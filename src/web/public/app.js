const API = "/api/agent"

const JOBS_API = "/api/jobs"

const FOCUS_API = "/api/focus"
const MEMORIES_API = "/api/memories"

const PROPOSALS_API = "/api/proposals"
const HEALTH_API = "/api/health"

const TAIL = 100
const POLL_RUNNING_MS = 700
const POLL_IDLE_MS = 2500

const POLL_CATCHUP_MS = 60
const NEAR_BOTTOM_PX = 120
const MAX_INPUT_HEIGHT = 200

const FOCUS_MAX = 10

const WORKER_TASK_CHARS = 40

const MEMORY_LIMIT = 20

const MEMORY_SEARCH_MS = 320

const AGENT_SNAPSHOT_MS = 5000

const PROPOSAL_TASK_CHARS = 60

const PROPOSAL_DIFF_MAX_LINES = 3000

const PROPOSAL_RESTART_MS = 800

const PROPOSAL_HEALTH_MAX_TRIES = 150

const PROPOSAL_TEST_KEYS = ["typecheck", "unit", "e2e", "contract"]

const PROPOSAL_STATUSES = ["open", "applied", "discarded"]

const state = {
  name: "",
  turn: { running: false },
  resumePoint: null,
  eventCount: 0,
  lastActivity: "",

  workerCount: 0,

  jobs: new Map(),

  jobCards: [],

  since: 0,

  oldest: null,

  seen: new Set(),

  rows: [],

  tools: new Map(),
  pendingEl: null,
  loaded: false,
  exhausted: false,
  loadingEarlier: false,
  sending: false,
  aborting: false,

  optimisticUntil: 0,
  connected: null,
  errors: 0,
  nearBottom: true,

  focus: [],

  focusLoaded: false,

  focusError: false,

  memoryCount: null,
  focusOpen: null,
  lastDreamAt: "",

  windowChars: null,
  windowStart: null,

  drawerOpen: false,
  drawerQuery: "",

  drawerAll: true,
  memories: [],
  memoriesLoaded: false,
  memoriesError: "",

  proposals: [],

  proposalsLoaded: false,

  proposalsError: false,

  proposalsSignature: "",

  proposalDrawerOpen: false,

  proposalDetailId: "",

  proposalDetail: null,

  proposalDiff: "",

  proposalDetailError: "",

  proposalBusy: false,

  proposalApplyState: "",

  proposalNote: "",
}

const els = {
  name: document.getElementById("agent-name"),
  events: document.getElementById("status-events"),
  last: document.getElementById("status-last"),
  workers: document.getElementById("status-workers"),
  memoryItem: document.getElementById("status-memory-item"),
  memoryValue: document.getElementById("status-memory"),
  windowItem: document.getElementById("status-window-item"),
  windowValue: document.getElementById("status-window"),
  resume: document.getElementById("status-resume"),
  panelToggle: document.getElementById("panel-toggle"),
  panelBackdrop: document.getElementById("panel-backdrop"),
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
  focusCount: document.getElementById("focus-count"),
  focusForm: document.getElementById("focus-add"),
  focusInput: document.getElementById("focus-input"),
  focusList: document.getElementById("focus-list"),
  focusMore: document.getElementById("focus-more"),
  focusEmpty: document.getElementById("focus-empty"),
  focusError: document.getElementById("focus-error"),
  workerCount: document.getElementById("worker-count"),
  workerList: document.getElementById("worker-list"),
  workerEmpty: document.getElementById("worker-empty"),
  dreamLine: document.getElementById("dream-line"),
  memoryBtn: document.getElementById("open-memory"),
  memoryBtnCount: document.getElementById("memory-btn-count"),
  drawer: document.getElementById("drawer"),
  drawerSum: document.getElementById("drawer-sum"),
  drawerClose: document.getElementById("drawer-close"),
  drawerForm: document.getElementById("drawer-search"),
  drawerQuery: document.getElementById("drawer-query"),
  drawerAll: document.getElementById("drawer-all"),
  memoryList: document.getElementById("memory-list"),
  memoryEmpty: document.getElementById("memory-empty"),
  memoryError: document.getElementById("memory-error"),
  proposalCount: document.getElementById("proposal-count"),
  proposalList: document.getElementById("proposal-list"),
  proposalEmpty: document.getElementById("proposal-empty"),
  proposalError: document.getElementById("proposal-error"),
  proposalDrawer: document.getElementById("proposal-drawer"),
  proposalTitle: document.getElementById("proposal-title"),
  proposalBadge: document.getElementById("proposal-badge"),
  proposalClose: document.getElementById("proposal-close"),
  proposalBody: document.getElementById("proposal-body"),
  proposalApply: document.getElementById("proposal-apply"),
  proposalDiscard: document.getElementById("proposal-discard"),
  proposalNote: document.getElementById("proposal-note"),
}

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
  if (data && data.turn !== undefined) applyTurn(data.turn)
  applyMemoryMeta(data)
  applyContextMeta(data)
}

function applyTurn(turn) {
  const incoming = normalizeTurn(turn)
  const keepOptimistic = !incoming.running && Date.now() < state.optimisticUntil
  if (incoming.running) state.optimisticUntil = 0
  if (!keepOptimistic) state.turn = incoming
}

function applyMemoryMeta(data) {
  const memory = data && typeof data.memory === "object" && data.memory ? data.memory : null
  if (!memory) return
  const count = numberOf(memory.memories)
  if (count !== null) state.memoryCount = Math.max(0, count)
  const open = numberOf(memory.focusOpen)
  if (open !== null) state.focusOpen = Math.max(0, open)
  if (typeof memory.lastDreamAt === "string") state.lastDreamAt = memory.lastDreamAt
  else if (memory.lastDreamAt === null) state.lastDreamAt = ""
}

function applyContextMeta(data) {
  const context = data && typeof data.context === "object" && data.context ? data.context : null
  if (!context) return
  const chars = numberOf(context.chars)
  if (chars !== null) state.windowChars = Math.max(0, chars)
  const windowStart = numberOf(context.windowStart)
  if (windowStart !== null) state.windowStart = windowStart
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

  const memories = state.memoryCount
  els.memoryItem.hidden = memories === null
  els.memoryValue.textContent = memories === null ? "" : String(memories)
  els.memoryBtnCount.textContent = memories === null || memories === 0 ? "" : String(memories)
  els.memoryBtn.title =
    memories === null ? "看看它记住了什么" : `它记住了 ${memories} 条（点开可以搜 / 删）`

  const chars = state.windowChars
  els.windowItem.hidden = chars === null
  els.windowValue.textContent = chars === null ? "" : String(chars)
  els.windowItem.title =
    chars === null
      ? "本窗口内的字符数"
      : state.windowStart !== null
        ? `这个窗口从 seq ${state.windowStart} 开始，一共 ${chars} 字`
        : `这个窗口里一共 ${chars} 字`
}

function updateEmpty() {
  const empty = state.loaded && state.eventCount === 0
  els.empty.hidden = !empty
  if (!empty) return
  const name = state.name || "这个 agent"
  els.emptyLine.textContent = `这是 ${name}：一个一直活着的 agent，它自己不动手，活交给 pi worker 去干。`
}

function normalizeJobState(value, code) {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : ""
  if (raw === "exited" && code !== null && code !== 0) return "failed"
  if (raw === "running" || raw === "exited" || raw === "failed" || raw === "lost") return raw
  return raw || ""
}

function badgeText(jobState, code) {
  if (jobState === "running") return "running"
  if (jobState === "lost") return "lost"
  if (jobState === "exited" || jobState === "failed") {
    return code === null ? jobState : `${jobState} ${code}`
  }
  return jobState || "—"
}

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

      output: typeof item.output === "string" ? item.output : "",
    })
  }
  return jobs
}

function applyJobs(data) {
  const jobs = readJobs(data)
  if (!jobs) return false
  let running = 0
  const alive = []
  for (const job of jobs) {
    if (job.state === "running") {
      running += 1
      alive.push(job)
    }
    const cards = state.jobs.get(job.id)
    if (!cards) continue
    for (const card of cards) applyJobToCard(card, job)
  }
  state.workerCount = running

  renderWorkers(alive)
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

    return false
  }
}

function scheduleJobRefresh() {
  if (jobRefreshTimer) return
  jobRefreshTimer = window.setTimeout(() => {
    jobRefreshTimer = 0
    void refreshJobs()
  }, 120)
}

function separator(date, day) {
  const box = el("div", "sep")
  box.dataset.sep = day
  box.appendChild(el("span", "sep-label", dayLabel(date)))
  box.appendChild(el("span", "sep-rule", ""))
  return box
}

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

const cardOf = new WeakMap()

const JOB_ID_RE = /\b\d{8}T\d{6}Z-[a-z0-9]{4,12}\b/i

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
    taskOverflows: false,
  }
  cardOf.set(root, card)
  state.jobCards.push(card)
  return card
}

function registerJob(card, id) {
  if (!id) return
  card.jobId = id
  card.idEl.textContent = id
  card.idEl.title = id
  const cards = state.jobs.get(id)
  if (!cards) state.jobs.set(id, [card])
  else if (!cards.includes(card)) cards.push(card)
}

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

function applyJobToCard(card, job) {
  const jobState = job.state || "unknown"
  card.root.dataset.state = jobState
  card.badgeState.textContent = badgeText(jobState, job.code)
  if (job.elapsedMs !== null) card.durEl.textContent = formatDuration(job.elapsedMs)
  if (job.task && !card.taskEl.textContent) setJobTask(card, job.task)
  if (typeof job.output === "string" && job.output.trim()) {
    card.pre.textContent = job.output.trim()
    card.pre.classList.remove("is-empty")
  }
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
    const ok = !data || data.ok !== false
    if (!ok) {
      card.root.dataset.state = "failed"
      card.badgeState.textContent = "failed"
    }
  }
  scheduleJobRefresh()
}

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
      if (text.startsWith("[ctrl]")) {
        row.classList.add("row-system")
        const line = el("p", "system-text")
        line.appendChild(el("span", "system-mark", "⌃"))
        line.appendChild(document.createTextNode(text.slice(6).trim()))
        body.appendChild(line)
        break
      }
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
      return null
  }

  return { seq: event.seq, date, day: dayKey(date), el: row }
}

function recordOf(event) {
  if (!event || typeof event !== "object") return null
  const seq = numberOf(event.seq)
  if (seq === null || state.seen.has(seq)) return null
  state.seen.add(seq)
  try {
    return buildRow(event)
  } catch {
    return null
  }
}

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
  while (els.rows.firstElementChild && els.rows.firstElementChild.classList.contains("sep")) {
    els.rows.firstElementChild.remove()
  }
  els.rows.insertBefore(fragment, els.rows.firstElementChild)
  state.rows = records.concat(state.rows)
  scheduleTaskMeasure()
}

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

const FOCUS_RANK = { doing: 0, open: 1, blocked: 2, done: 3 }
const FOCUS_NEXT = { open: "doing", doing: "done", blocked: "doing", done: "open" }

function normalizeFocusState(value) {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : ""
  return Object.hasOwn(FOCUS_RANK, raw) ? raw : "open"
}

function focusTime(item) {
  const date = toDate(item.updatedAt)
  return date ? date.getTime() : Number.NEGATIVE_INFINITY
}

function compareFocus(a, b) {
  const rank = FOCUS_RANK[a.state] - FOCUS_RANK[b.state]
  if (rank !== 0) return rank
  const at = focusTime(a)
  const bt = focusTime(b)
  if (at !== bt) return bt - at
  return (b.seq ?? 0) - (a.seq ?? 0)
}

function readFocus(data) {
  const list = data && Array.isArray(data.items) ? data.items : null
  if (!list) return null
  const items = []
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue
    const id = entry.id === undefined || entry.id === null ? "" : String(entry.id).trim()
    const text = typeof entry.text === "string" ? entry.text.trim() : ""
    if (!id || !text) continue
    items.push({
      id,
      text,
      state: normalizeFocusState(entry.state),
      updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : "",
      seq: numberOf(entry.seq),
    })
  }
  items.sort(compareFocus)
  return items
}

function focusItemEl(item) {
  const row = el("li", "focus-item")
  row.dataset.id = item.id
  row.dataset.state = item.state
  row.tabIndex = 0
  row.setAttribute("role", "button")
  row.title = `点一下：${item.state} → ${FOCUS_NEXT[item.state] || "doing"}`
  const dot = el("span", "focus-dot")
  dot.setAttribute("aria-hidden", "true")
  row.append(dot, el("span", "focus-text", item.text), el("span", "focus-state", item.state))
  return row
}

function renderFocus() {
  const visible = state.focus.filter((item) => item.state !== "done")
  const shown = visible.slice(0, FOCUS_MAX)
  els.focusList.textContent = ""
  for (const item of shown) els.focusList.appendChild(focusItemEl(item))

  const rest = visible.length - shown.length
  els.focusMore.hidden = rest <= 0
  if (rest > 0) els.focusMore.textContent = `还有 ${rest} 条被挤在下面（面板最多 ${FOCUS_MAX} 条，做梦会收拾）`

  els.focusEmpty.hidden = shown.length > 0 || state.focusError || !state.focusLoaded
  els.focusError.hidden = !state.focusError
  const count = state.focusError && state.focusOpen !== null ? state.focusOpen : visible.length
  els.focusCount.textContent = String(Math.max(0, count))
}

let focusBusy = false

async function refreshFocus() {
  if (focusBusy) return false
  focusBusy = true
  try {
    const items = readFocus(await request(FOCUS_API))
    if (!items) return false
    state.focus = items
    state.focusLoaded = true
    state.focusError = false
    renderFocus()
    return true
  } catch {
    state.focusError = true
    renderFocus()
    return false
  } finally {
    focusBusy = false
  }
}

async function cycleFocus(id) {
  const item = state.focus.find((entry) => entry.id === id)
  if (!item) return
  const previous = item.state
  const next = FOCUS_NEXT[previous] || "doing"
  item.state = next
  item.updatedAt = new Date().toISOString()
  state.focus.sort(compareFocus)
  renderFocus()
  try {
    await request(FOCUS_API, { method: "POST", body: { id, state: next } })
    void refreshFocus()
  } catch (error) {
    item.state = previous
    state.focus.sort(compareFocus)
    renderFocus()
    toast(`focus 没存上：${messageOf(error)}`)
  }
}

async function addFocus(text) {
  const clean = oneLine(text)
  if (!clean) return
  try {
    await request(FOCUS_API, { method: "POST", body: { text: clean } })
    els.focusInput.value = ""
    await refreshFocus()
  } catch (error) {
    toast(`加不上 focus：${messageOf(error)}`)
  }
}

function shortJobId(id) {
  const raw = String(id ?? "").trim()
  const dash = raw.lastIndexOf("-")
  const tail = dash >= 0 ? raw.slice(dash + 1) : raw
  if (tail.length >= 3 && tail.length <= 12) return tail
  return raw.length > 10 ? `${raw.slice(0, 9)}…` : raw
}

function shortTask(text) {
  const line = oneLine(text)
  if (!line) return "（没写任务）"
  return line.length > WORKER_TASK_CHARS ? `${line.slice(0, WORKER_TASK_CHARS)}…` : line
}

function jobElapsed(job) {
  if (job.elapsedMs !== null) return formatDuration(job.elapsedMs)
  const started = toDate(job.startedAt)
  return started ? formatDuration(Date.now() - started.getTime()) : ""
}

function workerItemEl(job) {
  const row = el("li", "worker-item")
  row.dataset.id = job.id
  const idEl = el("span", "worker-id", shortJobId(job.id))
  idEl.title = job.id
  const taskEl = el("span", "worker-task", shortTask(job.task))
  if (job.task) taskEl.title = oneLine(job.task)
  row.append(idEl, taskEl, el("span", "worker-dur", jobElapsed(job)))
  return row
}

function renderWorkers(jobs) {
  const list = jobs || []
  els.workerList.textContent = ""
  for (const job of list) els.workerList.appendChild(workerItemEl(job))
  els.workerEmpty.hidden = list.length > 0
  els.workerCount.textContent = String(list.length)
}

function renderDream() {
  const when = state.lastDreamAt
  els.dreamLine.textContent = when ? `上次做梦 ${timeAgo(when)}` : "还没做过梦"
  els.dreamLine.title = when ? absoluteTime(when) : "空闲十分钟、又有新事件时它会自己整理一遍"
}

let lastAgentSnapshot = 0

function refreshPanel(force) {
  void refreshFocus()
  if (!force && Date.now() - lastAgentSnapshot < AGENT_SNAPSHOT_MS) return
  lastAgentSnapshot = Date.now()
  void (async () => {
    try {
      applyAgent(await api(""))
      renderDream()
      updateHead()
      updateEmpty()
      updateComposer()
      syncPending()
    } catch {
    }
  })()
}

function readMemories(data) {
  const list = data && Array.isArray(data.memories) ? data.memories : null
  if (!list) return null
  const memories = []
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue
    const id = entry.id === undefined || entry.id === null ? "" : String(entry.id).trim()
    const text = typeof entry.text === "string" ? entry.text : ""
    if (!id || !text.trim()) continue
    const supersededBy = entry.supersededBy ?? entry.superseded_by ?? entry.superseded ?? null
    memories.push({
      id,
      text: text.trim(),
      kind: typeof entry.kind === "string" && entry.kind.trim() ? entry.kind.trim() : "note",
      createdAt: typeof entry.createdAt === "string" ? entry.createdAt : String(entry.created_at ?? ""),
      importance: numberOf(entry.importance),
      superseded: Boolean(supersededBy),
    })
  }
  return memories
}

function memoryItemEl(memory) {
  const row = el("li", "memory-item")
  row.dataset.id = memory.id
  const superseded = memory.superseded
  row.dataset.superseded = superseded ? "true" : "false"

  const head = el("div", "memory-head")
  head.appendChild(el("span", "memory-kind", memory.kind))
  if (superseded) head.appendChild(el("span", "memory-flag", "已合并"))
  const when = memory.createdAt
  const time = el("span", "memory-time", when ? timeAgo(when) : "")
  if (when) time.title = absoluteTime(when)
  head.appendChild(time)
  if (memory.importance !== null) head.appendChild(el("span", "memory-imp", memory.importance.toFixed(2)))

  const del = el("button", "memory-del", "删除")
  del.type = "button"
  del.setAttribute("aria-label", `删除这条记忆：${oneLine(memory.text).slice(0, 40)}`)
  head.appendChild(del)

  row.append(head, el("p", "memory-text", memory.text))
  return row
}

function renderMemories() {
  const list = state.memories
  els.memoryList.textContent = ""
  for (const memory of list) els.memoryList.appendChild(memoryItemEl(memory))

  const live = list.filter((memory) => !memory.superseded).length
  const parts = []
  if (state.memoriesLoaded) {
    parts.push(list.length === live ? `${live} 条` : `${live} 条 · ${list.length - live} 条已合并`)
    if (list.length >= MEMORY_LIMIT) parts.push(`一次最多 ${MEMORY_LIMIT} 条，搜一下能找更多`)
  }
  els.drawerSum.textContent = parts.join(" · ")
  els.memoryEmpty.hidden = !(state.memoriesLoaded && !state.memoriesError && list.length === 0)
  els.memoryError.hidden = !state.memoriesError
  if (state.memoriesError) els.memoryError.textContent = `拉不到记忆：${state.memoriesError}`
}

let memoriesBusy = false

async function refreshMemories() {
  if (memoriesBusy) return false
  memoriesBusy = true
  const params = new URLSearchParams()
  const query = oneLine(state.drawerQuery)
  if (query) params.set("query", query)
  params.set("limit", String(MEMORY_LIMIT))
  if (state.drawerAll) params.set("all", "1")
  try {
    const memories = readMemories(await request(`${MEMORIES_API}?${params}`))
    if (!memories) throw new Error("返回里没有 memories")
    state.memories = memories
    state.memoriesLoaded = true
    state.memoriesError = ""
    renderMemories()
    return true
  } catch (error) {
    state.memoriesError = messageOf(error)
    renderMemories()
    return false
  } finally {
    memoriesBusy = false
  }
}

async function deleteMemory(id) {
  const memory = state.memories.find((entry) => entry.id === id)
  const preview = oneLine(memory ? memory.text : "").slice(0, 80) || id
  if (!window.confirm(`删掉这条记忆？\n\n${preview}\n\n（不是物理删除：它会被标成已删除，不再被召回）`)) return
  try {
    await request(`${MEMORIES_API}/${encodeURIComponent(id)}`, { method: "DELETE" })
    state.memories = state.memories.filter((entry) => entry.id !== id)
    renderMemories()
    void refreshMemories()
    refreshPanel(true)
  } catch (error) {
    toast(`删除失败：${messageOf(error)}`)
  }
}

function normalizeProposalStatus(value) {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : ""
  return PROPOSAL_STATUSES.includes(raw) ? raw : ""
}

function proposalStateText(stateName) {
  if (stateName === "ok") return "通过"
  if (stateName === "fail") return "失败"
  return "未知"
}

function readTestResult(value) {
  if (!value || typeof value !== "object") return null
  const output = typeof value.output === "string" ? value.output : ""
  return { ok: value.ok === true, output }
}

function readProposalTests(value) {
  const source = value && typeof value === "object" ? value : null
  const tests = {}
  for (const key of PROPOSAL_TEST_KEYS) tests[key] = readTestResult(source ? source[key] : null)
  return tests
}

function readProposal(item) {
  if (!item || typeof item !== "object") return null
  const id = item.id === undefined || item.id === null ? "" : String(item.id).trim()
  if (!id) return null
  const endedAt = item.endedAt ?? item.ended_at ?? null
  return {
    id,
    branch: typeof item.branch === "string" ? item.branch : "",
    base: typeof item.base === "string" ? item.base : "",
    task: typeof item.task === "string" ? item.task : "",
    summary: typeof item.summary === "string" ? item.summary : "",
    diffstat: typeof item.diffstat === "string" ? item.diffstat : "",
    status: normalizeProposalStatus(item.status),
    createdAt: typeof item.createdAt === "string" ? item.createdAt : String(item.created_at ?? ""),
    endedAt: typeof endedAt === "string" ? endedAt : "",
    tests: readProposalTests(item.tests),
  }
}

function proposalTime(proposal) {
  const date = toDate(proposal.createdAt)
  return date ? date.getTime() : Number.NEGATIVE_INFINITY
}

function compareProposals(a, b) {
  const at = proposalTime(a)
  const bt = proposalTime(b)
  if (at !== bt) return bt - at
  return b.id.localeCompare(a.id)
}

function readProposals(data) {
  const list = data && Array.isArray(data.proposals) ? data.proposals : null
  if (!list) return null
  const proposals = []
  for (const item of list) {
    const proposal = readProposal(item)
    if (proposal) proposals.push(proposal)
  }
  proposals.sort(compareProposals)
  return proposals
}

function proposalTestState(result) {
  if (!result) return "unknown"
  return result.ok ? "ok" : "fail"
}

function proposalsSignature(proposals) {
  const parts = []
  for (const proposal of proposals) {
    const marks = PROPOSAL_TEST_KEYS.map((key) => {
      const stateName = proposalTestState(proposal.tests[key])
      return stateName === "unknown" ? "-" : stateName === "ok" ? "1" : "0"
    }).join("")
    parts.push(
      [proposal.id, proposal.status, proposal.branch, proposal.createdAt, proposal.endedAt, proposal.diffstat, marks].join("\u0001"),
    )
  }
  return parts.join("\u0002")
}

function shortProposalTask(text) {
  const line = oneLine(text)
  if (!line) return "（没写任务）"
  return line.length > PROPOSAL_TASK_CHARS ? `${line.slice(0, PROPOSAL_TASK_CHARS)}…` : line
}

function proposalItemEl(proposal) {
  const row = el("li", "proposal-item")
  row.dataset.id = proposal.id
  row.dataset.status = proposal.status || "unknown"
  row.tabIndex = 0
  row.setAttribute("role", "button")
  const full = oneLine(proposal.task) || proposal.id
  row.title = proposal.createdAt ? `${full}\n${absoluteTime(proposal.createdAt)}` : full

  const head = el("div", "proposal-line")
  const badge = el("span", "proposal-badge", proposal.status || "—")
  badge.dataset.status = proposal.status || "unknown"
  head.append(badge, el("span", "proposal-task", shortProposalTask(proposal.task)))

  const meta = el("div", "proposal-line")
  meta.appendChild(el("span", "proposal-branch", proposal.branch || "（没有分支）"))
  const dots = el("span", "proposal-dots")
  const labels = []
  for (const key of PROPOSAL_TEST_KEYS) {
    const stateName = proposalTestState(proposal.tests[key])
    const dot = el("span", "proposal-dot")
    dot.dataset.state = stateName
    dot.title = `${key}: ${proposalStateText(stateName)}`
    dots.appendChild(dot)
    labels.push(`${key} ${proposalStateText(stateName)}`)
  }
  dots.setAttribute("aria-label", labels.join(" · "))
  meta.appendChild(dots)

  const stat = el("div", "proposal-diffstat", proposal.diffstat || "（没有 diffstat）")
  row.append(head, meta, stat)
  return row
}

function renderProposals() {
  els.proposalList.textContent = ""
  for (const proposal of state.proposals) els.proposalList.appendChild(proposalItemEl(proposal))
  const count = state.proposals.length
  els.proposalCount.textContent = String(Math.max(0, count))
  els.proposalEmpty.hidden = !(state.proposalsLoaded && !state.proposalsError && count === 0)
  els.proposalError.hidden = !state.proposalsError
}

function applyProposals(data) {
  const proposals = readProposals(data)
  if (!proposals) {
    noteProposalsFailure()
    return false
  }
  const wasError = state.proposalsError
  const signature = proposalsSignature(proposals)
  const changed = wasError || signature !== state.proposalsSignature
  state.proposals = proposals
  state.proposalsSignature = signature
  state.proposalsLoaded = true
  state.proposalsError = false
  if (changed) {
    renderProposals()
    syncProposalFoot()
  } else {
    els.proposalError.hidden = true
  }
  return true
}

function noteProposalsFailure() {
  if (state.proposalsError) return
  state.proposalsError = true
  renderProposals()
}

let proposalsBusy = false

async function refreshProposals() {
  if (proposalsBusy) return false
  proposalsBusy = true
  try {
    return applyProposals(await request(PROPOSALS_API))
  } catch {
    noteProposalsFailure()
    return false
  } finally {
    proposalsBusy = false
  }
}

function findProposal(id) {
  if (!id) return null
  return state.proposals.find((proposal) => proposal.id === id) || null
}

function currentProposal() {
  return state.proposalDetail || findProposal(state.proposalDetailId)
}

function proposalTestsAllOk(proposal) {
  if (!proposal) return false
  for (const key of PROPOSAL_TEST_KEYS) {
    if (proposalTestState(proposal.tests[key]) !== "ok") return false
  }
  return true
}

function proposalCanApply(proposal) {
  return Boolean(proposal) && proposal.status === "open" && proposalTestsAllOk(proposal)
}

function proposalApplyTitle(proposal) {
  if (!proposal) return "提案还没加载完"
  if (proposal.status === "applied") return "已经应用过了"
  if (proposal.status === "discarded") return "已经丢弃了"
  if (proposal.status !== "open") return "状态不明，不能应用"
  if (!proposalTestsAllOk(proposal)) return "四个测试还没全绿，先让它改到全绿"
  return "合并这条分支并重启服务"
}

function clipLines(text, max) {
  const lines = String(text ?? "").split("\n")
  if (lines.length <= max) return { text: lines.join("\n"), truncated: 0 }
  return { text: lines.slice(0, max).join("\n"), truncated: lines.length - max }
}

function proposalMetaRow(key, value) {
  const row = el("div", "proposal-meta-row")
  row.append(el("span", "proposal-meta-key", key), el("span", "proposal-meta-value", value))
  return row
}

function proposalTestEl(key, result) {
  const stateName = proposalTestState(result)
  const box = el("div", "proposal-test")
  box.dataset.state = stateName

  const head = el("div", "proposal-test-head")
  head.append(el("span", "proposal-test-name", key), el("span", "proposal-test-state", proposalStateText(stateName)))
  box.appendChild(head)

  if (result && result.output) {
    const details = document.createElement("details")
    details.className = "proposal-out"
    const summary = document.createElement("summary")
    summary.textContent = result.ok ? "输出" : "失败输出"
    const clip = clipLines(result.output, PROPOSAL_DIFF_MAX_LINES)
    details.append(summary, el("pre", "proposal-pre", clip.text.trim() ? clip.text : "（空）"))
    if (clip.truncated > 0) details.appendChild(el("p", "proposal-cut", `还有 ${clip.truncated} 行没显示`))
    box.appendChild(details)
  }
  return box
}

function renderProposalBody(proposal) {
  els.proposalBody.textContent = ""
  if (!proposal) {
    const note = state.proposalDetailError ? `拉不到提案：${state.proposalDetailError}` : "加载中…"
    els.proposalBody.appendChild(el("p", "proposal-hint", note))
    return
  }

  els.proposalBody.appendChild(el("p", "proposal-task-full", proposal.task || "（没写任务）"))

  const meta = el("div", "proposal-meta")
  meta.appendChild(proposalMetaRow("branch", proposal.branch || "—"))
  meta.appendChild(proposalMetaRow("base", proposal.base || "—"))
  meta.appendChild(proposalMetaRow("created", proposal.createdAt ? absoluteTime(proposal.createdAt) : "—"))
  if (proposal.endedAt) meta.appendChild(proposalMetaRow("ended", absoluteTime(proposal.endedAt)))
  if (proposal.summary) meta.appendChild(proposalMetaRow("summary", proposal.summary))
  els.proposalBody.appendChild(meta)

  const tests = el("section", "proposal-tests")
  tests.appendChild(el("h3", "proposal-sub", "tests"))
  for (const key of PROPOSAL_TEST_KEYS) tests.appendChild(proposalTestEl(key, proposal.tests[key]))
  els.proposalBody.appendChild(tests)

  const diffBox = el("section", "proposal-diff-wrap")
  diffBox.appendChild(el("h3", "proposal-sub", "diff"))
  const clip = clipLines(state.proposalDiff, PROPOSAL_DIFF_MAX_LINES)
  diffBox.appendChild(el("pre", "proposal-diff", clip.text.trim() ? clip.text : "（没有 diff）"))
  if (clip.truncated > 0) {
    diffBox.appendChild(
      el("p", "proposal-cut", `diff 太长，只显示前 ${PROPOSAL_DIFF_MAX_LINES} 行（还有 ${clip.truncated} 行没显示）`),
    )
  }
  els.proposalBody.appendChild(diffBox)
}

function syncProposalFoot() {
  const proposal = currentProposal()
  const restarting = state.proposalApplyState === "restarting"
  const applied = state.proposalApplyState === "applied"
  const busy = state.proposalBusy
  const canApply = proposalCanApply(proposal)

  els.proposalApply.disabled = !canApply || busy || restarting || applied
  els.proposalApply.textContent = restarting ? "重启中…" : applied ? "已应用" : busy ? "应用中…" : "应用"
  els.proposalApply.title = proposalApplyTitle(proposal)

  const canDiscard = Boolean(proposal) && proposal.status === "open" && !busy && !restarting
  els.proposalDiscard.disabled = !canDiscard
  els.proposalDiscard.title = canDiscard ? "删掉这条提案的分支，代码不合进来" : "只有 open 的提案能丢弃"

  els.proposalNote.textContent = state.proposalNote
  els.proposalBadge.textContent = proposal ? proposal.status || "…" : "…"
  els.proposalBadge.dataset.status = proposal && proposal.status ? proposal.status : "unknown"
}

function renderProposalDrawer() {
  const proposal = currentProposal()
  els.proposalTitle.textContent = proposal ? `提案 ${proposal.id}` : "提案"
  renderProposalBody(proposal)
  syncProposalFoot()
}

async function loadProposalDetail(id) {
  try {
    const data = await request(`${PROPOSALS_API}/${encodeURIComponent(id)}`)
    if (state.proposalDetailId !== id) return false
    const detail = data && data.proposal ? readProposal(data.proposal) : null
    state.proposalDetail = detail
    state.proposalDiff = data && typeof data.diff === "string" ? data.diff : ""
    state.proposalDetailError = ""
  } catch (error) {
    if (state.proposalDetailId !== id) return false
    state.proposalDetailError = messageOf(error)
  }
  renderProposalDrawer()
  return true
}

function openProposalDrawer(id) {
  if (!id) return
  if (state.drawerOpen) closeDrawer()
  state.proposalDrawerOpen = true
  state.proposalDetailId = id
  state.proposalDetail = null
  state.proposalDiff = ""
  state.proposalDetailError = ""
  state.proposalApplyState = ""
  state.proposalNote = ""
  stopHealthWatch()
  els.proposalDrawer.hidden = false
  renderProposalDrawer()
  void loadProposalDetail(id)
}

function closeProposalDrawer() {
  state.proposalDrawerOpen = false
  state.proposalDetailId = ""
  state.proposalDetail = null
  state.proposalDiff = ""
  state.proposalDetailError = ""
  state.proposalApplyState = ""
  state.proposalNote = ""
  stopHealthWatch()
  els.proposalDrawer.hidden = true
}

let healthTimer = 0

function stopHealthWatch() {
  window.clearTimeout(healthTimer)
  healthTimer = 0
}

function scheduleHealthWatch(attempt) {
  stopHealthWatch()
  healthTimer = window.setTimeout(() => {
    healthTimer = 0
    void checkHealth(attempt)
  }, PROPOSAL_RESTART_MS)
}

async function checkHealth(attempt) {
  const id = state.proposalDetailId
  let reachable = false
  try {
    const data = await request(HEALTH_API)
    reachable = Boolean(data) && data.status !== "down"
  } catch {
    reachable = false
  }
  if (!id || state.proposalApplyState !== "restarting") return
  if (reachable && attempt > 1) {
    state.proposalApplyState = "applied"
    state.proposalNote = "已应用"
    stopHealthWatch()
    syncProposalFoot()
    void refreshProposals()
    if (state.proposalDrawerOpen && state.proposalDetailId === id) void loadProposalDetail(id)
    return
  }
  if (attempt >= PROPOSAL_HEALTH_MAX_TRIES) {
    state.proposalApplyState = ""
    state.proposalNote = "重启后一直没等到健康检查，刷新页面试试"
    stopHealthWatch()
    syncProposalFoot()
    return
  }
  scheduleHealthWatch(attempt + 1)
}

async function applyProposal(id) {
  if (!id || state.proposalBusy) return
  const proposal = currentProposal()
  if (!proposalCanApply(proposal)) return
  state.proposalBusy = true
  state.proposalNote = "正在应用…"
  syncProposalFoot()
  try {
    const data = await request(`${PROPOSALS_API}/${encodeURIComponent(id)}/apply`, { method: "POST", body: {} })
    if (data && data.applied === false) throw new Error("后端没有应用成功")
    state.proposalNote = "服务正在重启"
    if (data && data.restarting === false) {
      state.proposalApplyState = "applied"
      state.proposalNote = "已应用"
      void refreshProposals()
    } else {
      state.proposalApplyState = "restarting"
      scheduleHealthWatch(1)
    }
  } catch (error) {
    state.proposalApplyState = ""
    state.proposalNote = ""
    toast(`应用失败：${messageOf(error)}`)
  } finally {
    state.proposalBusy = false
    syncProposalFoot()
  }
}

async function discardProposal(id) {
  if (!id || state.proposalBusy) return
  const proposal = currentProposal()
  if (!proposal || proposal.status !== "open") return
  const preview = oneLine(proposal.task).slice(0, 80) || id
  if (!window.confirm(`丢弃这条提案？\n\n${preview}\n\n它对应的分支会被删掉，代码不会合进来。`)) return
  state.proposalBusy = true
  syncProposalFoot()
  try {
    const data = await request(`${PROPOSALS_API}/${encodeURIComponent(id)}/discard`, { method: "POST", body: {} })
    const updated = data && data.proposal ? readProposal(data.proposal) : null
    if (updated && state.proposalDetailId === id) state.proposalDetail = updated
    state.proposalNote = "已丢弃"
    state.proposalApplyState = ""
  } catch (error) {
    toast(`丢弃失败：${messageOf(error)}`)
  } finally {
    state.proposalBusy = false
    void refreshProposals()
    if (state.proposalDetailId === id && state.proposalDrawerOpen) void loadProposalDetail(id)
    syncProposalFoot()
  }
}

function openDrawer() {
  state.drawerOpen = true
  els.drawer.hidden = false
  els.drawerQuery.value = state.drawerQuery
  void refreshMemories()
  els.drawerQuery.focus()
}

function closeDrawer() {
  state.drawerOpen = false
  els.drawer.hidden = true
}

function setPanelOpen(open) {
  document.body.classList.toggle("panel-open", Boolean(open))
  els.panelToggle.setAttribute("aria-expanded", open ? "true" : "false")
  if (!open && state.drawerOpen) closeDrawer()
}

function togglePanel() {
  setPanelOpen(!document.body.classList.contains("panel-open"))
}

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
    const [data, jobsData, proposalsData] = await Promise.all([
      api(`/events?since=${since}`),
      request(JOBS_API).catch(() => null),
      request(PROPOSALS_API).catch(() => null),
    ])
    state.errors = 0
    setConnected(true)

    if (data && data.turn !== undefined) applyTurn(data.turn)
    const events = Array.isArray(data && data.events) ? data.events : []
    if (events.length) {
      appendEvents(events)
      if (state.nearBottom) scrollToBottom()
    }
    const total = numberOf(data && data.total)
    if (total !== null) state.eventCount = Math.max(state.eventCount, total, state.since)

    applyJobs(jobsData)

    if (proposalsData) applyProposals(proposalsData)
    else noteProposalsFailure()

    refreshPanel()

    const running = Boolean(state.turn && state.turn.running)
    const turnError = state.turn && typeof state.turn.error === "string" ? state.turn.error : ""
    if (turnError && turnError !== surfacedTurnError) {
      surfacedTurnError = turnError
      toast(`这一轮出错：${turnError}`)
    }
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

async function refreshHead() {
  try {
    const [data] = await Promise.all([api(""), refreshJobs()])
    applyAgent(data)
    lastAgentSnapshot = Date.now()
    setConnected(true)
    renderDream()
    updateHead()
    updateEmpty()
    updateComposer()
  } catch {
  }
}

async function tryLoadAgent() {
  try {
    const data = await api("")
    applyAgent(data)
    lastAgentSnapshot = Date.now()
    setConnected(true)
    state.loaded = true
    if (state.eventCount > 0) await loadTail()
    await refreshJobs()
    await refreshProposals()
    void refreshFocus()
    renderDream()
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

  els.panelToggle.addEventListener("click", () => {
    togglePanel()
  })

  els.panelBackdrop.addEventListener("click", () => {
    setPanelOpen(false)
  })

  els.focusForm.addEventListener("submit", (event) => {
    event.preventDefault()
    void addFocus(els.focusInput.value)
  })

  els.focusInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.isComposing) return
    event.preventDefault()
    void addFocus(els.focusInput.value)
  })

  const activateFocus = (target) => {
    const row = target.closest("li.focus-item")
    if (!row || !row.dataset.id) return
    const selection = window.getSelection ? String(window.getSelection() || "") : ""
    if (selection) return
    void cycleFocus(row.dataset.id)
  }

  els.focusList.addEventListener("click", (event) => {
    if (event.target instanceof Element) activateFocus(event.target)
  })

  els.focusList.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return
    if (!(event.target instanceof Element)) return
    event.preventDefault()
    activateFocus(event.target)
  })

  els.memoryBtn.addEventListener("click", () => {
    openDrawer()
  })

  els.drawerClose.addEventListener("click", () => {
    closeDrawer()
  })

  els.drawer.addEventListener("click", (event) => {
    if (event.target === els.drawer) closeDrawer()
  })

  els.drawerForm.addEventListener("submit", (event) => {
    event.preventDefault()
    state.drawerQuery = els.drawerQuery.value
    void refreshMemories()
  })

  els.drawerAll.addEventListener("change", () => {
    state.drawerAll = els.drawerAll.checked
    void refreshMemories()
  })

  let searchTimer = 0
  els.drawerQuery.addEventListener("input", () => {
    window.clearTimeout(searchTimer)
    searchTimer = window.setTimeout(() => {
      searchTimer = 0
      state.drawerQuery = els.drawerQuery.value
      void refreshMemories()
    }, MEMORY_SEARCH_MS)
  })

  els.memoryList.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null
    if (!target) return
    if (!target.closest("button.memory-del")) return
    const row = target.closest("li.memory-item")
    if (!row || !row.dataset.id) return
    void deleteMemory(row.dataset.id)
  })

  const openProposalFrom = (target) => {
    if (!(target instanceof Element)) return
    const row = target.closest("li.proposal-item")
    if (!row || !row.dataset.id) return
    const selection = window.getSelection ? String(window.getSelection() || "") : ""
    if (selection) return
    openProposalDrawer(row.dataset.id)
  }

  els.proposalList.addEventListener("click", (event) => {
    openProposalFrom(event.target)
  })

  els.proposalList.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return
    event.preventDefault()
    openProposalFrom(event.target)
  })

  els.proposalClose.addEventListener("click", () => {
    closeProposalDrawer()
  })

  els.proposalDrawer.addEventListener("click", (event) => {
    if (event.target === els.proposalDrawer) closeProposalDrawer()
  })

  els.proposalApply.addEventListener("click", () => {
    void applyProposal(state.proposalDetailId)
  })

  els.proposalDiscard.addEventListener("click", () => {
    void discardProposal(state.proposalDetailId)
  })

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return
    if (state.drawerOpen) {
      event.preventDefault()
      closeDrawer()
      return
    }
    if (state.proposalDrawerOpen) {
      event.preventDefault()
      closeProposalDrawer()
      return
    }
    if (document.body.classList.contains("panel-open")) setPanelOpen(false)
  })

  els.timeline.addEventListener(
    "scroll",
    () => {
      const gap = els.timeline.scrollHeight - els.timeline.scrollTop - els.timeline.clientHeight
      state.nearBottom = gap < NEAR_BOTTOM_PX
    },
    { passive: true },
  )

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
    const selection = window.getSelection ? String(window.getSelection() || "") : ""
    if (selection) return
    toggleJobTask(card, true)
  })

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
  renderFocus()
  renderWorkers([])
  renderProposals()
  renderDream()
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
