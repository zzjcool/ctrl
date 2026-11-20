// ctrl — 一个命名 agent 的页面：它的名字、它的一生（一条时间线）、一个输入框。
//
// 纯静态 ES module：零 import、零依赖、零构建、无 top-level await。
// 只使用契约 §7 的接口（v3 里没有会话、也没有"机器"这个概念；ctrl 自己不动手，
// 活交给 pi worker，页面靠 `/api/jobs` 看 worker 的当下状态）：
//   GET  /api/agent
//   GET  /api/agent/events?since=N | tail=T | before=S&tail=T
//   POST /api/agent/messages   { text }
//   POST /api/agent/abort
//   GET  /api/jobs             { jobs: [{ id, state, task, startedAt, elapsedMs, code? }] }
//
// 安全：服务端 / 模型 / 用户的所有文本都走 textContent 或 createElement，
// 这个文件里没有一处把字符串当 HTML 塞回 DOM。

const API = "/api/agent"
/** 契约 §7：`GET /api/jobs` 不在 /api/agent 下面（worker 不是日志的一部分）。 */
const JOBS_API = "/api/jobs"
/** 首屏和"加载更早"一次拿多少条（契约 §7：单次上限 200） */
const TAIL = 100
const POLL_RUNNING_MS = 700
const POLL_IDLE_MS = 2500
/** 一次拉满 200 条说明后面还有，别等一个轮询间隔 */
const POLL_CATCHUP_MS = 60
const NEAR_BOTTOM_PX = 120
const MAX_INPUT_HEIGHT = 200

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

const state = {
  name: "",
  turn: { running: false },
  resumePoint: null,
  eventCount: 0,
  lastActivity: "",
  /** `/api/jobs` 里 state === "running" 的条数：状态条的 workers */
  workerCount: 0,
  /** job id → 渲染过的 delegate 卡片数组；轮询到了就按 id 合并，从不删除卡片 */
  jobs: new Map(),
  /** 所有 delegate 卡片（量「展开全文」要遍历它们） */
  jobCards: [],
  /** 流式游标：下一次 since= 用（最后一条 seq + 1） */
  since: 0,
  /** 已收到的最小 seq；> 0 就说明上面还有历史（null = 一条都没收到） */
  oldest: null,
  /** 收到过的所有 seq（含不渲染的 memory_*），用来去重 */
  seen: new Set(),
  /** 时间线上已有的行，按时间顺序：[{ seq, date, day, el }] */
  rows: [],
  /** callId → 工具卡片，用来把 tool_call 和 tool_result 合成一张 */
  tools: new Map(),
  pendingEl: null,
  loaded: false,
  exhausted: false,
  loadingEarlier: false,
  sending: false,
  aborting: false,
  /** 刚发完消息的那一下：服务端的 running 可能还没翻过来，先信自己 */
  optimisticUntil: 0,
  connected: null,
  errors: 0,
  nearBottom: true,
}

const els = {
  name: document.getElementById("agent-name"),
  events: document.getElementById("status-events"),
  last: document.getElementById("status-last"),
  workers: document.getElementById("status-workers"),
  resume: document.getElementById("status-resume"),
  connDot: document.getElementById("conn-dot"),
  connText: document.getElementById("conn-text"),
  timeline: document.getElementById("timeline"),
  rows: document.getElementById("rows"),
  empty: document.getElementById("empty"),
  emptyLine: document.getElementById("empty-line"),
  loadWrap: document.getElementById("load-earlier-wrap"),
  loadBtn: document.getElementById("load-earlier"),
  composer: document.getElementById("composer"),
  input: document.getElementById("input"),
  send: document.getElementById("send"),
  hint: document.getElementById("composer-hint"),
  toast: document.getElementById("toast"),
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 建一个元素。文本一律走 textContent。 */
function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined && text !== null) node.textContent = String(text)
  return node
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function oneLine(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim()
}

function messageOf(error) {
  if (error && typeof error.message === "string" && error.message) return error.message
  return String(error)
}

function numberOf(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

const pad2 = (n) => String(n).padStart(2, "0")

function toDate(value) {
  const ms = typeof value === "number" ? value : Date.parse(String(value ?? ""))
  if (!Number.isFinite(ms)) return null
  return new Date(ms)
}

function dayKey(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

function dayLabel(date) {
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const gap = Math.round((today.getTime() - day.getTime()) / 86_400_000)
  if (gap === 0) return "今天"
  if (gap === 1) return "昨天"
  if (date.getFullYear() === today.getFullYear()) return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
  return dayKey(date)
}

/** 今天只给 HH:MM；更早的日期在时间列里带上 MM-DD。 */
function timeLabel(date) {
  const hm = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  return dayKey(date) === dayKey(new Date())
    ? hm
    : `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${hm}`
}

function timeAgo(value) {
  const date = toDate(value)
  if (!date) return ""
  const diff = Date.now() - date.getTime()
  if (diff < 0) return timeLabel(date)
  if (diff < 45_000) return "刚刚"
  if (diff < 3_600_000) return `${Math.max(1, Math.round(diff / 60_000))} 分钟前`
  if (diff < 86_400_000) return `${Math.max(1, Math.round(diff / 3_600_000))} 小时前`
  return timeLabel(date)
}

function absoluteTime(value) {
  const date = toDate(value)
  if (!date) return ""
  return `${dayKey(date)} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return ""
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes}m${pad2(seconds)}s`
}

/** 发一次 GET/POST，拿 JSON。`path` 是完整路径（/api/jobs 不在 /api/agent 下面）。 */
async function request(fullPath, options) {
  const init = {
    method: (options && options.method) || "GET",
    headers: { accept: "application/json" },
  }
  if (options && options.body !== undefined) {
    init.headers["content-type"] = "application/json"
    init.body = JSON.stringify(options.body)
  }
  const response = await fetch(fullPath, init)
  const raw = await response.text()
  let data = null
  if (raw) {
    try {
      data = JSON.parse(raw)
    } catch {
      data = { raw }
    }
  }
  if (!response.ok) {
    const serverMessage =
      data && typeof data === "object" && typeof data.error === "string" ? data.error : ""
    const error = new Error(serverMessage || `HTTP ${response.status}`)
    error.status = response.status
    error.data = data
    throw error
  }
  return data ?? {}
}

function api(path, options) {
  return request(API + path, options)
}

function setConnected(ok) {
  state.connected = ok
  els.connDot.className = ok ? "dot dot-ok" : "dot dot-fail"
  els.connText.textContent = ok ? "已连接" : "连接断开"
  els.connText.classList.toggle("is-fail", !ok)
}

let toastTimer = 0
function toast(message) {
  els.toast.textContent = String(message)
  els.toast.hidden = false
  els.toast.classList.add("show")
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => {
    els.toast.classList.remove("show")
    els.toast.hidden = true
  }, 3600)
}

// ---------------------------------------------------------------------------
// 头部：名字 + 状态条
// ---------------------------------------------------------------------------

function pickName(data) {
  if (typeof data?.agent === "string" && data.agent.trim()) return data.agent.trim()
  const agent = data && typeof data.agent === "object" && data.agent ? data.agent : null
  if (agent && typeof agent.name === "string" && agent.name.trim()) return agent.name.trim()
  if (data?.session && typeof data.session.name === "string" && data.session.name.trim()) {
    return data.session.name.trim()
  }
  return ""
}

function normalizeTurn(turn) {
  if (!turn || typeof turn !== "object") return { running: false }
  const running = turn.running === true
  return {
    running,
    ...(typeof turn.startedAt === "string" ? { startedAt: turn.startedAt } : {}),
    ...(typeof turn.error === "string" && turn.error ? { error: turn.error } : {}),
    ...(turn.aborted === true ? { aborted: true } : {}),
  }
}

const RESUME_TITLE = {
  dangling_tool_call: "上次有一个工具调用没有结果，已经按失败标记",
  interrupted_turn: "上次的模型调用没有返回，那一轮被中断了",
}

/** 只有"不 clean 而且有历史"才配一个安静的"已恢复"。 */
function resumeKind() {
  const kind = state.resumePoint && typeof state.resumePoint.kind === "string" ? state.resumePoint.kind : ""
  if (!kind || kind === "clean" || kind === "empty") return ""
  if (state.eventCount <= 0) return ""
  return kind
}

function applyAgent(data) {
  const name = pickName(data)
  if (name) state.name = name

  const session = data && typeof data.session === "object" && data.session ? data.session : null
  if (session) {
    const count = numberOf(session.eventCount)
    if (count !== null) state.eventCount = Math.max(state.eventCount, count)
    const lastSeq = numberOf(session.lastSeq)
    if (lastSeq !== null) state.since = Math.max(state.since, lastSeq + 1)
    if (typeof session.updatedAt === "string" && session.updatedAt) {
      const incoming = toDate(session.updatedAt)
      const current = toDate(state.lastActivity)
      if (incoming && (!current || incoming.getTime() > current.getTime())) state.lastActivity = session.updatedAt
    }
  }
  if (data && data.resumePoint !== undefined) state.resumePoint = data.resumePoint ?? null
  if (data && data.turn !== undefined) state.turn = normalizeTurn(data.turn)
}

function updateHead() {
  els.name.textContent = state.name || "—"
  document.title = state.name ? `${state.name} · ctrl` : "ctrl"

  els.events.textContent = String(Math.max(0, state.eventCount))

  const workers = Math.max(0, state.workerCount)
  els.workers.textContent = String(workers)
  els.workers.title = workers ? `${workers} 个 pi worker 正在跑` : "眼下没有 worker 在跑"

  const when = state.lastActivity
  els.last.textContent = when ? timeAgo(when) : "—"
  els.last.title = when ? absoluteTime(when) : ""

  const kind = resumeKind()
  els.resume.hidden = !kind
  els.resume.title = kind ? RESUME_TITLE[kind] || `从上次中断处恢复（${kind}）` : ""
}

function updateEmpty() {
  const empty = state.loaded && state.eventCount === 0
  els.empty.hidden = !empty
  if (!empty) return
  const name = state.name || "这个 agent"
  els.emptyLine.textContent = `这是 ${name}：一个一直活着的 agent，它自己不动手，活交给 pi worker 去干。`
}

// ---------------------------------------------------------------------------
// worker（job）：岗位状态。契约 §7 `GET /api/jobs` 只给这一行信息，
// 卡片上的任务文本、输出还是从日志里的 tool_call / tool_result 来。
// ---------------------------------------------------------------------------

/** 后端的 state 是 meta 推导出来的：running / exited / failed / killed / lost。
 *  这里只做一件事：`exited` 却带了非 0 退出码（同一条信息被拆成两半时）算 failed。 */
function normalizeJobState(value, code) {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : ""
  if (raw === "exited" && code !== null && code !== 0) return "failed"
  if (raw === "running" || raw === "exited" || raw === "failed" || raw === "lost") return raw
  return raw || ""
}

/** 徽章上写什么：把退出码写进去，比一个孤零零的 exited 有用。 */
function badgeText(jobState, code) {
  if (jobState === "running") return "running"
  if (jobState === "lost") return "lost"
  if (jobState === "exited" || jobState === "failed") {
    return code === null ? jobState : `${jobState} ${code}`
  }
  return jobState || "—"
}

/** `{ jobs: [...] }` → 数组；形状不对就当没拿到。 */
function readJobs(data) {
  const list = data && Array.isArray(data.jobs) ? data.jobs : null
  if (!list) return null
  const jobs = []
  for (const item of list) {
    if (!item || typeof item !== "object") continue
    const id = typeof item.id === "string" ? item.id.trim() : ""
    if (!id) continue
    jobs.push({
      id,
      state: normalizeJobState(item.state, numberOf(item.code)),
      task: typeof item.task === "string" ? item.task : "",
      startedAt: typeof item.startedAt === "string" ? item.startedAt : "",
      elapsedMs: numberOf(item.elapsedMs),
      code: numberOf(item.code),
    })
  }
  return jobs
}

/**
 * 拿到 `/api/jobs` 就合并进已渲染的卡片；拿不到就什么也不做——
 * 卡片保留最后一次已知状态，比凭空消失或者掉回「运行中」诚实。
 */
function applyJobs(data) {
  const jobs = readJobs(data)
  if (!jobs) return false
  let running = 0
  for (const job of jobs) {
    if (job.state === "running") running += 1
    const cards = state.jobs.get(job.id)
    if (!cards) continue
    for (const card of cards) applyJobToCard(card, job)
  }
  state.workerCount = running
  updateHead()
  return true
}

let jobRefreshTimer = 0

async function refreshJobs() {
  window.clearTimeout(jobRefreshTimer)
  jobRefreshTimer = 0
  try {
    return applyJobs(await request(JOBS_API))
  } catch {
    // worker 列表拉不到不该把事件流带倒；下一次轮询再试。
    return false
  }
}

/** 一批卡片刚落地时把 worker 状态补一次（拢在一起发，不一张卡片一个请求）。 */
function scheduleJobRefresh() {
  if (jobRefreshTimer) return
  jobRefreshTimer = window.setTimeout(() => {
    jobRefreshTimer = 0
    void refreshJobs()
  }, 120)
}

// ---------------------------------------------------------------------------
// 时间线：行
// ---------------------------------------------------------------------------

/** 一条日期分隔条；和行共用时间列，所以标签是右对齐的。 */
function separator(date, day) {
  const box = el("div", "sep")
  box.dataset.sep = day
  box.appendChild(el("span", "sep-label", dayLabel(date)))
  box.appendChild(el("span", "sep-rule", ""))
  return box
}

/** 把 ``` 围栏切成代码块，其余文本原样保留换行。 */
function renderProse(container, rawText) {
  const lines = String(rawText ?? "").split("\n")
  let buffer = []
  let fence = null

  const flushText = () => {
    if (!buffer.length) return
    const block = buffer.join("\n").replace(/^\n+/, "").replace(/\s+$/, "")
    buffer = []
    if (!block) return
    container.appendChild(el("p", "prose", block))
  }

  const flushFence = (current) => {
    const box = el("div", "fence")
    if (current.lang) box.appendChild(el("div", "fence-lang", current.lang))
    const pre = document.createElement("pre")
    pre.appendChild(el("code", "fence-code", current.lines.join("\n")))
    box.appendChild(pre)
    container.appendChild(box)
  }

  for (const line of lines) {
    const open = /^\s*```(.*)$/.exec(line)
    if (fence) {
      if (open) {
        flushFence(fence)
        fence = null
      } else {
        fence.lines.push(line)
      }
    } else if (open) {
      flushText()
      fence = { lang: open[1].trim(), lines: [] }
    } else {
      buffer.push(line)
    }
  }
  if (fence) flushFence(fence)
  flushText()
}

const ARG_PRIORITY = ["cmd", "command", "path", "query", "task", "pattern", "text", "id", "url", "name"]

function rankKey(key) {
  const index = ARG_PRIORITY.indexOf(key)
  return index === -1 ? ARG_PRIORITY.length : index
}

function valueText(value) {
  if (value === null || value === undefined) return ""
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** `cmd: go build ./...  ·  cwd: /srv/app` — 先挑最像"这一行在干什么"的键。 */
function argsLine(args) {
  if (args === null || args === undefined) return ""
  if (typeof args !== "object") return oneLine(valueText(args)).slice(0, 300)
  const keys = Object.keys(args)
  if (!keys.length) return ""
  const ordered = keys.slice().sort((a, b) => rankKey(a) - rankKey(b) || a.localeCompare(b))
  const parts = []
  for (const key of ordered.slice(0, 5)) {
    parts.push(`${key}: ${oneLine(valueText(args[key])).slice(0, 220)}`)
  }
  if (ordered.length > 5) parts.push(`+${ordered.length - 5}`)
  return parts.join("  ·  ")
}

function createCard(name) {
  const root = el("div", "tool")
  root.dataset.state = "running"

  const head = el("div", "tool-head")
  const nameEl = el("span", "tool-name", String(name || "tool"))
  head.appendChild(nameEl)

  const durEl = el("span", "tool-dur", "")
  const stateEl = el("span", "tool-state", "…")
  head.append(durEl, stateEl)

  const argsEl = el("div", "tool-args")
  argsEl.hidden = true

  const details = document.createElement("details")
  details.className = "tool-out"
  details.hidden = true
  const summary = document.createElement("summary")
  summary.textContent = "输出"
  const pre = el("pre", "tool-pre", "")
  details.append(summary, pre)

  root.append(head, argsEl, details)
  return { kind: "tool", root, nameEl, durEl, stateEl, argsEl, details, pre, callTs: null, resultTs: null }
}

// --- delegate 卡片：任务全文 + job id + worker 状态 + 输出 -------------------

/** 卡片根节点 → 卡片对象（点击「展开全文」时要回找）。 */
const cardOf = new WeakMap()

/** job 目录名 / `pi --session-id`：`YYYYMMDDTHHMMSSZ-<随机>`（契约 §5.1）。 */
const JOB_ID_RE = /\b\d{8}T\d{6}Z-[a-z0-9]{4,12}\b/i

/**
 * `delegate` 的返回值是一句人话（`started job <id> — poll with job_status`），
 * 契约没有结构化字段，所以先在几个可能的键里找，再退回从文本里抠。
 * 抠不到就返回空串：那张卡片就按普通失败处理（比如并发到顶没起来）。
 */
function jobIdOf(data) {
  for (const candidate of [data?.id, data?.jobId, data?.job_id, data?.job]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim()
  }
  const text = String((data && data.output) ?? "")
  const hit = JOB_ID_RE.exec(text)
  if (hit) return hit[0]
  const loose = /\bjob[:\s#]+([A-Za-z0-9][A-Za-z0-9._-]{3,})/i.exec(text)
  return loose ? loose[1] : ""
}

function createJobCard(name) {
  const root = el("div", "tool job")
  root.dataset.state = "running"

  const head = el("div", "tool-head job-head")
  const nameEl = el("span", "tool-name", String(name || "delegate"))
  const badge = el("span", "job-badge")
  badge.append(el("span", "job-dot", ""), el("span", "job-badge-text", "running"))
  const badgeState = badge.lastElementChild
  const idEl = el("span", "job-id", "")
  const durEl = el("span", "tool-dur", "")
  head.append(nameEl, badge, idEl, durEl)

  const body = el("div", "job-body")
  const taskEl = el("p", "job-task", "")
  const toggle = el("button", "job-toggle", "展开全文")
  toggle.type = "button"
  toggle.hidden = true
  const metaEl = el("div", "job-meta", "")
  body.append(taskEl, toggle, metaEl)

  const details = document.createElement("details")
  details.className = "tool-out"
  details.hidden = true
  const summary = document.createElement("summary")
  summary.textContent = "输出"
  const pre = el("pre", "tool-pre", "")
  details.append(summary, pre)

  root.append(head, body, details)

  const card = {
    kind: "job",
    root,
    nameEl,
    durEl,
    badgeState,
    idEl,
    taskEl,
    toggle,
    metaEl,
    details,
    pre,
    jobId: "",
    callTs: null,
    resultTs: null,
    /** 任务文本被钳成两行时是否会溢出（决定要不要给「展开全文」） */
    taskOverflows: false,
  }
  cardOf.set(root, card)
  state.jobCards.push(card)
  return card
}

/** 记下这张卡片属于哪个 job：之后 `/api/jobs` 就来这里找它。 */
function registerJob(card, id) {
  if (!id) return
  card.jobId = id
  card.idEl.textContent = id
  card.idEl.title = id
  const cards = state.jobs.get(id)
  if (!cards) state.jobs.set(id, [card])
  else if (!cards.includes(card)) cards.push(card)
}

/** 任务全文：默认只露两行，真溢出了才给一个「展开全文」。 */
function measureJobTask(card) {
  if (!card.taskEl.isConnected) return
  if (card.root.dataset.open === "true") {
    card.toggle.hidden = !card.taskOverflows
    return
  }
  card.taskOverflows = card.taskEl.scrollHeight > card.taskEl.clientHeight + 1
  card.toggle.hidden = !card.taskOverflows
}

function measureJobTasks() {
  for (const card of state.jobCards) measureJobTask(card)
}

let measureFrame = 0

/** 卡片刚插进 DOM 时量不出来（还没有布局），下一帧再量。 */
function scheduleTaskMeasure() {
  if (measureFrame) return
  measureFrame = window.requestAnimationFrame(() => {
    measureFrame = 0
    measureJobTasks()
  })
}

function setJobTask(card, text) {
  card.taskEl.textContent = String(text ?? "")
  measureJobTask(card)
}

function toggleJobTask(card, force) {
  const open = typeof force === "boolean" ? force : card.root.dataset.open !== "true"
  card.root.dataset.open = open ? "true" : "false"
  card.toggle.textContent = open ? "收起" : "展开全文"
  measureJobTask(card)
}

/** `/api/jobs` 的一行 → 这张卡片的徽章与耗时（状态只认 worker 的真实状态）。 */
function applyJobToCard(card, job) {
  const jobState = job.state || "unknown"
  card.root.dataset.state = jobState
  card.badgeState.textContent = badgeText(jobState, job.code)
  if (job.elapsedMs !== null) card.durEl.textContent = formatDuration(job.elapsedMs)
  if (job.task && !card.taskEl.textContent) setJobTask(card, job.task)
}

function fillJobCall(card, data, ts) {
  const args = data && data.args && typeof data.args === "object" ? data.args : null
  if (args && typeof args.task === "string" && args.task.trim()) setJobTask(card, args.task)
  const meta = []
  for (const key of ["cwd", "model", "thinking"]) {
    const value = args ? args[key] : null
    if (value === null || value === undefined || value === "") continue
    meta.push(`${key}: ${oneLine(valueText(value)).slice(0, 160)}`)
  }
  if (meta.length) card.metaEl.textContent = meta.join("  ·  ")
  registerJob(card, jobIdOf(data))
  const callDate = toDate(ts)
  if (callDate) card.callTs = callDate.getTime()
}

function finishJobCall(card, data, ts) {
  registerJob(card, jobIdOf(data))

  const end = toDate(ts)
  if (end) card.resultTs = end.getTime()
  if (card.callTs !== null && card.resultTs !== null) {
    card.durEl.textContent = formatDuration(card.resultTs - card.callTs)
  }

  const output = String((data && data.output) ?? "").replace(/\s+$/, "")
  card.pre.textContent = output.trim() ? output : "（无输出）"
  card.pre.classList.toggle("is-empty", !output.trim())
  card.details.hidden = false

  if (!card.jobId) {
    // 没有 job id（并发到顶、spawn 失败）：没有 worker 可跟，就老实说失败。
    const ok = !data || data.ok !== false
    if (!ok) {
      card.root.dataset.state = "failed"
      card.badgeState.textContent = "failed"
    }
  }
  // 卡片刚到：把 worker 的当下状态取一次，别等下一个轮询间隔。
  scheduleJobRefresh()
}

/** 一张新的工具卡片该长什么样：`delegate` 有自己的版式。 */
function createCardFor(name) {
  return String(name || "") === "delegate" ? createJobCard(name) : createCard(name)
}

function callInto(card, data, ts) {
  if (card.kind === "job") fillJobCall(card, data, ts)
  else fillCall(card, data, ts)
}

function resultInto(card, data, ts) {
  if (card.kind === "job") finishJobCall(card, data, ts)
  else finishCard(card, data, ts)
}

/** call 和 result 是先后脚到的，谁后到谁负责把耗时补上（上翻分页时会反过来）。 */
function updateDuration(card) {
  if (card.callTs === null || card.resultTs === null) return
  card.durEl.textContent = formatDuration(card.resultTs - card.callTs)
}

function fillCall(card, data, ts) {
  if (data && typeof data.name === "string" && data.name) card.nameEl.textContent = data.name
  const line = argsLine(data ? data.args : null)
  if (line) {
    card.argsEl.textContent = line
    card.argsEl.hidden = false
  }
  const callDate = toDate(ts)
  if (callDate) card.callTs = callDate.getTime()
  updateDuration(card)
}

function finishCard(card, data, ts) {
  const ok = !data || data.ok !== false
  card.root.dataset.state = ok ? "ok" : "fail"
  card.stateEl.textContent = ok ? "ok" : "fail"

  const end = toDate(ts)
  if (end) {
    card.resultTs = end.getTime()
    updateDuration(card)
  }

  const output = String((data && data.output) ?? "").replace(/\s+$/, "")
  card.pre.textContent = output.trim() ? output : "（无输出）"
  card.pre.classList.toggle("is-empty", !output.trim())
  card.details.hidden = false
}

/** 一条事件 → 一行；返回 null 表示不渲染（memory_* / session_created / 已合并进卡片）。 */
function buildRow(event) {
  const date = toDate(event.ts) || new Date()
  const type = String(event.type || "")
  const data = event.data && typeof event.data === "object" ? event.data : {}

  const row = el("div", "row")
  row.dataset.type = type
  const time = document.createElement("time")
  time.className = "row-time"
  time.dateTime = date.toISOString()
  time.textContent = timeLabel(date)
  const body = el("div", "row-body")
  row.append(time, body)

  switch (type) {
    case "user_message": {
      const text = String(data.text ?? "")
      if (!text.trim()) return null
      row.classList.add("row-user")
      const line = el("p", "user-text")
      line.appendChild(el("span", "user-mark", "›"))
      line.appendChild(document.createTextNode(text))
      body.appendChild(line)
      break
    }
    case "assistant_message": {
      const text = String(data.text ?? "")
      if (!text.trim()) return null
      row.classList.add("row-agent")
      renderProse(body, text)
      break
    }
    case "tool_call": {
      const callId = String(data.callId ?? "")
      const existing = callId ? state.tools.get(callId) : null
      if (existing) {
        // 上翻分页时先看到了 result、后看到 call：补上参数，不另起一行。
        callInto(existing, data, event.ts)
        return null
      }
      const card = createCardFor(data.name)
      callInto(card, data, event.ts)
      if (callId) state.tools.set(callId, card)
      row.classList.add("row-tool")
      body.appendChild(card.root)
      break
    }
    case "tool_result": {
      const callId = String(data.callId ?? "")
      const existing = callId ? state.tools.get(callId) : null
      if (existing) {
        // 和上面那张卡片是同一件事：结果写进卡片，不再多一行。
        // job_status / job_stop 没有自己的卡片，它们就是普通的工具卡片。
        resultInto(existing, data, event.ts)
        return null
      }
      const card = createCardFor(data.name)
      if (callId) state.tools.set(callId, card)
      resultInto(card, data, event.ts)
      row.classList.add("row-tool")
      body.appendChild(card.root)
      break
    }
    case "error": {
      row.classList.add("row-error")
      if (data.fatal === true) row.classList.add("is-fatal")
      const line = el("div", "err-line")
      line.appendChild(el("span", "err-mark", data.fatal === true ? "!" : "⚠"))
      line.appendChild(el("span", "err-text", String(data.message ?? "")))
      body.appendChild(line)
      break
    }
    case "compaction": {
      row.classList.add("row-note")
      const kept = numberOf(data.firstKeptSeq)
      const line = el("div", "note-line", kept === null ? "上下文已压缩" : `上下文已压缩 · 保留自 seq ${kept}`)
      if (typeof data.summary === "string" && data.summary) line.title = data.summary
      body.appendChild(line)
      break
    }
    default:
      // memory_write / memory_recall / session_created / assistant_pending：不渲染。
      return null
  }

  return { seq: event.seq, date, day: dayKey(date), el: row }
}

/** 记下"这条 seq 见过了"，再交给 buildRow；重复的、坏掉的都直接丢。 */
function recordOf(event) {
  if (!event || typeof event !== "object") return null
  const seq = numberOf(event.seq)
  if (seq === null || state.seen.has(seq)) return null
  state.seen.add(seq)
  try {
    return buildRow(event)
  } catch {
    // 一条坏事件不该把整条流卡死：跳过它，游标照常往前。
    return null
  }
}

/** 推进三个游标：since（往后）、oldest（往前）、最后活动时间。 */
function noteCursors(events) {
  for (const event of events) {
    if (!event || typeof event !== "object") continue
    const seq = numberOf(event.seq)
    if (seq !== null) {
      state.since = Math.max(state.since, seq + 1)
      if (state.oldest === null || seq < state.oldest) state.oldest = seq
    }
    if (typeof event.ts === "string" && event.ts) {
      const incoming = toDate(event.ts)
      const current = toDate(state.lastActivity)
      if (incoming && (!current || incoming.getTime() > current.getTime())) state.lastActivity = event.ts
    }
  }
  if (state.oldest !== null) state.eventCount = Math.max(state.eventCount, state.since)
}

function appendEvents(events) {
  const records = []
  for (const event of events) {
    const record = recordOf(event)
    if (record) records.push(record)
  }
  noteCursors(events)
  if (!records.length) return
  const fragment = document.createDocumentFragment()
  let prevDay = state.rows.length ? state.rows[state.rows.length - 1].day : null
  for (const record of records) {
    if (record.day !== prevDay) fragment.appendChild(separator(record.date, record.day))
    fragment.appendChild(record.el)
    prevDay = record.day
  }
  els.rows.appendChild(fragment)
  for (const record of records) state.rows.push(record)
  if (state.pendingEl) els.rows.appendChild(state.pendingEl)
  scheduleTaskMeasure()
}

function prependEvents(events) {
  const records = []
  for (const event of events) {
    const record = recordOf(event)
    if (record) records.push(record)
  }
  noteCursors(events)
  if (!records.length) return

  const fragment = document.createDocumentFragment()
  let prevDay = null
  for (const record of records) {
    if (record.day !== prevDay) fragment.appendChild(separator(record.date, record.day))
    fragment.appendChild(record.el)
    prevDay = record.day
  }
  const first = state.rows.length ? state.rows[0] : null
  if (first && prevDay !== first.day) fragment.appendChild(separator(first.date, first.day))
  // 顶上原来那条分隔条要么被上面这条取代，要么本来就多余（同一天）。
  while (els.rows.firstElementChild && els.rows.firstElementChild.classList.contains("sep")) {
    els.rows.firstElementChild.remove()
  }
  els.rows.insertBefore(fragment, els.rows.firstElementChild)
  state.rows = records.concat(state.rows)
  scheduleTaskMeasure()
}

// ---------------------------------------------------------------------------
// 时间线：滚动、加载更早、"运行中"
// ---------------------------------------------------------------------------

function scrollToBottom() {
  els.timeline.scrollTop = els.timeline.scrollHeight
}

function updateLoadEarlier() {
  const more = state.loaded && state.oldest !== null && state.oldest > 0 && !state.exhausted
  els.loadWrap.hidden = !more
  els.loadBtn.disabled = state.loadingEarlier
  els.loadBtn.textContent = state.loadingEarlier ? "加载中…" : "加载更早"
}

function buildPending() {
  const row = el("div", "row row-pending")
  const time = document.createElement("time")
  time.className = "row-time"
  time.textContent = timeLabel(new Date())
  const body = el("div", "row-body")
  const line = el("div", "pending")
  line.appendChild(el("span", "spin", ""))
  line.appendChild(el("span", "pending-text", "运行中…"))
  body.appendChild(line)
  row.append(time, body)
  return row
}

function syncPending() {
  const running = Boolean(state.turn && state.turn.running)
  if (!running) {
    if (state.pendingEl) {
      state.pendingEl.remove()
      state.pendingEl = null
    }
    return
  }
  if (!state.pendingEl) state.pendingEl = buildPending()
  if (els.rows.lastElementChild !== state.pendingEl) els.rows.appendChild(state.pendingEl)
}

// ---------------------------------------------------------------------------
// 输入区
// ---------------------------------------------------------------------------

function autosize() {
  const input = els.input
  input.style.height = "auto"
  const next = Math.min(input.scrollHeight || 0, MAX_INPUT_HEIGHT)
  input.style.height = `${next}px`
  input.style.overflowY = (input.scrollHeight || 0) > MAX_INPUT_HEIGHT ? "auto" : "hidden"
}

function updateComposer() {
  const running = Boolean(state.turn && state.turn.running)
  els.send.textContent = running ? "停止" : "发送"
  els.send.classList.toggle("is-stop", running)
  els.send.disabled = running ? state.aborting : state.sending
  els.send.title = running ? "停止这一轮" : "发送（Enter）"
  els.input.placeholder = running
    ? "它在跑…（先点停止，Enter 不会开新的一轮）"
    : "说点什么…（Enter 发送，Shift+Enter 换行）"
  els.hint.textContent = running ? "运行中 · 停止不会中断已经在跑的工具" : "Enter 发送 · Shift+Enter 换行"
}

async function sendMessage() {
  const text = els.input.value.trim()
  if (!text || state.sending) return
  if (state.turn && state.turn.running) {
    toast("还在跑，等它结束或先点停止。")
    return
  }
  state.sending = true
  updateComposer()
  try {
    await api("/messages", { method: "POST", body: { text } })
    els.input.value = ""
    autosize()
    state.turn = { running: true, startedAt: new Date().toISOString() }
    state.optimisticUntil = Date.now() + 1500
    state.nearBottom = true
    syncPending()
    updateComposer()
    updateHead()
    schedulePoll(0)
  } catch (error) {
    if (error && error.status === 409) {
      toast("还在跑，等它结束或先点停止。")
      state.turn = normalizeTurn({ ...(state.turn || {}), running: true })
      state.optimisticUntil = Date.now() + 1500
      syncPending()
      updateComposer()
      schedulePoll(POLL_RUNNING_MS)
    } else {
      toast(`发送失败：${messageOf(error)}`)
    }
  } finally {
    state.sending = false
    updateComposer()
  }
}

async function abortTurn() {
  if (state.aborting) return
  state.aborting = true
  updateComposer()
  try {
    const data = await api("/abort", { method: "POST", body: {} })
    if (data && data.aborted === false) toast("现在没有正在跑的一轮")
    schedulePoll(0)
  } catch (error) {
    toast(`停止失败：${messageOf(error)}`)
    schedulePoll(POLL_RUNNING_MS)
  } finally {
    state.aborting = false
    updateComposer()
  }
}

// ---------------------------------------------------------------------------
// 数据：首屏 + 上翻 + 轮询
// ---------------------------------------------------------------------------

async function loadTail() {
  try {
    const data = await api(`/events?tail=${TAIL}`)
    const total = numberOf(data && data.total)
    if (total !== null) state.eventCount = Math.max(state.eventCount, total)
    const events = Array.isArray(data && data.events) ? data.events : []
    appendEvents(events)
  } catch (error) {
    toast(`历史加载失败：${messageOf(error)}`)
  }
  // 一条历史都没拿到（比如 tail 挂了）就别从 seq 0 开始追：那样会按顺序
  // 把最老的一批当成新事件堆到底下。直接从日志末尾开始接。
  if (state.oldest === null) state.since = Math.max(state.since, state.eventCount)
}

async function loadEarlier() {
  if (state.loadingEarlier || state.oldest === null || state.oldest <= 0) return
  const before = state.oldest
  state.loadingEarlier = true
  updateLoadEarlier()
  const offset = els.timeline.scrollHeight - els.timeline.scrollTop
  try {
    const data = await api(`/events?before=${before}&tail=${TAIL}`)
    const events = Array.isArray(data && data.events) ? data.events : []
    const total = numberOf(data && data.total)
    if (total !== null) state.eventCount = Math.max(state.eventCount, total)
    if (!events.length) state.exhausted = true
    else prependEvents(events)
    if (state.oldest === null || state.oldest >= before) state.exhausted = true
    // 往前插了一屏：把滚动位置钉住，视线里的那一行不许动。
    els.timeline.scrollTop = els.timeline.scrollHeight - offset
  } catch (error) {
    toast(`加载更早失败：${messageOf(error)}`)
  } finally {
    state.loadingEarlier = false
    updateLoadEarlier()
    updateHead()
  }
}

let pollTimer = 0
let polling = false
let surfacedTurnError = ""

function schedulePoll(delay) {
  window.clearTimeout(pollTimer)
  pollTimer = window.setTimeout(() => {
    void pollOnce()
  }, Math.max(0, delay))
}

async function pollOnce() {
  if (polling) return
  polling = true
  const since = state.since
  const wasRunning = Boolean(state.turn && state.turn.running)
  let next = POLL_IDLE_MS
  try {
    // 事件和 worker 列表同一拍：delegate 卡片在 turn 结束后还要跟着 worker 活。
    const [data, jobsData] = await Promise.all([
      api(`/events?since=${since}`),
      request(JOBS_API).catch(() => null),
    ])
    state.errors = 0
    setConnected(true)

    if (data && data.turn !== undefined) {
      const incoming = normalizeTurn(data.turn)
      // 刚按下发送时，一个更早发出的轮询可能带回旧的 running:false；
      // 1.5 s 内不信它，否则按钮会在"停止/发送"之间闪一下。
      const keepOptimistic = !incoming.running && Date.now() < state.optimisticUntil
      if (incoming.running) state.optimisticUntil = 0
      if (!keepOptimistic) state.turn = incoming
    }
    const events = Array.isArray(data && data.events) ? data.events : []
    if (events.length) {
      appendEvents(events)
      if (state.nearBottom) scrollToBottom()
    }
    const total = numberOf(data && data.total)
    if (total !== null) state.eventCount = Math.max(state.eventCount, total, state.since)

    // job 从列表里消失（超过最近 20 条）不动已渲染的卡片：保留最后一次已知状态。
    applyJobs(jobsData)

    const running = Boolean(state.turn && state.turn.running)
    const turnError = state.turn && typeof state.turn.error === "string" ? state.turn.error : ""
    if (turnError && turnError !== surfacedTurnError) {
      // 服务端把这一轮的失败记在 turn 上（日志里另有 error 事件）。只说一次。
      surfacedTurnError = turnError
      toast(`这一轮出错：${turnError}`)
    }
    // 有 worker 在跑也算“忙”：不然 turn 一结束，卡片会拖到 2.5 s 才动。
    const busy = running || state.workerCount > 0
    next = events.length >= 200 ? POLL_CATCHUP_MS : busy ? POLL_RUNNING_MS : POLL_IDLE_MS
    if (wasRunning && !running) void refreshHead()

    updateHead()
    updateEmpty()
    updateLoadEarlier()
    syncPending()
    updateComposer()
  } catch {
    state.errors += 1
    setConnected(false)
    next = Math.min(1000 * state.errors, 6000)
  } finally {
    polling = false
    schedulePoll(next)
  }
}

/** 一轮结束、或刚恢复连接时，把头部（事件数 / resumePoint / turn）重新拉一次。 */
async function refreshHead() {
  try {
    // 头部和 worker 列表一起拉：turn 结束后 workers 那个数字也得是新的。
    const [data] = await Promise.all([api(""), refreshJobs()])
    applyAgent(data)
    setConnected(true)
    updateHead()
    updateEmpty()
    updateComposer()
  } catch {
    // 轮询会继续，头部保持旧值即可。
  }
}

async function tryLoadAgent() {
  try {
    const data = await api("")
    applyAgent(data)
    setConnected(true)
    state.loaded = true
    if (state.eventCount > 0) await loadTail()
    // 卡片都上屏了再来一次：重开页面时 job 可能早跑完了，不能等到下个轮询拍。
    await refreshJobs()
    updateHead()
    updateEmpty()
    updateLoadEarlier()
    syncPending()
    updateComposer()
    scrollToBottom()
    state.nearBottom = true
    return true
  } catch {
    setConnected(false)
    return false
  }
}

// ---------------------------------------------------------------------------
// 绑定 + 启动（无 top-level await：所有异步都收在 boot 里）
// ---------------------------------------------------------------------------

function bind() {
  els.composer.addEventListener("submit", (event) => {
    event.preventDefault()
    if (state.turn && state.turn.running) void abortTurn()
    else void sendMessage()
  })

  els.input.addEventListener("input", autosize)
  els.input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return
    if (event.metaKey || event.ctrlKey || event.altKey) return
    event.preventDefault()
    if (state.turn && state.turn.running) {
      if (!state.sending) toast("还在跑，等它结束或先点停止。")
      return
    }
    void sendMessage()
  })

  els.loadBtn.addEventListener("click", () => {
    void loadEarlier()
  })

  els.timeline.addEventListener(
    "scroll",
    () => {
      const gap = els.timeline.scrollHeight - els.timeline.scrollTop - els.timeline.clientHeight
      state.nearBottom = gap < NEAR_BOTTOM_PX
    },
    { passive: true },
  )

  // delegate 卡片是动态的：展开/收起用事件委托，不给每张卡片绑一份。
  els.rows.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null
    if (!target) return
    const root = target.closest("div.tool.job")
    if (!root) return
    const card = cardOf.get(root)
    if (!card) return
    if (target.closest(".job-toggle")) {
      toggleJobTask(card)
      return
    }
    if (!target.closest(".job-task") || !card.taskOverflows) return
    if (root.dataset.open === "true") return
    // 选中文字了就是用户在建选区，别把卡片展开。
    const selection = window.getSelection ? String(window.getSelection() || "") : ""
    if (selection) return
    toggleJobTask(card, true)
  })

  // 窗口宽度变了，两行能装下多少字也变了：重新量一次。
  window.addEventListener(
    "resize",
    () => {
      if (state.jobCards.length) scheduleTaskMeasure()
    },
    { passive: true },
  )

  for (const button of document.querySelectorAll(".prompt")) {
    button.addEventListener("click", () => {
      els.input.value = button.dataset.prompt || button.textContent || ""
      autosize()
      els.input.focus()
    })
  }

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && state.loaded) schedulePoll(0)
  })

  window.addEventListener("focus", () => {
    if (state.loaded) schedulePoll(0)
  })
}

async function boot() {
  bind()
  autosize()
  updateHead()
  updateEmpty()
  updateLoadEarlier()
  updateComposer()

  let attempt = 0
  while (!state.loaded) {
    attempt += 1
    const ok = await tryLoadAgent()
    if (ok) break
    if (attempt === 1) toast("连不上 ctrl，正在重试…")
    await sleep(Math.min(1200 * attempt, 8000))
  }

  schedulePoll(state.turn && state.turn.running ? POLL_RUNNING_MS : POLL_IDLE_MS)
}

void boot()
