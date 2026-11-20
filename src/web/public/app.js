// ctrl — 单页对话界面。
//
// 纯静态：无 import、无依赖、无构建、无 top-level await。
// 只使用契约 §10 的接口：
//   GET  /api/health                              GET  /api/machines
//   GET  /api/sessions                            POST /api/sessions
//   GET  /api/sessions/:id                        GET  /api/sessions/:id/events?since=N
//   POST /api/sessions/:id/messages               POST /api/sessions/:id/abort
//
// 安全：所有来自服务端/模型/用户的文本都走 textContent 或 createElement，
// 这里没有任何 innerHTML 赋值。

const API = "/api"
const POLL_RUNNING_MS = 700
const POLL_IDLE_MS = 2500
const NEAR_BOTTOM_PX = 96
const MAX_INPUT_HEIGHT = 220

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

const state = {
  sessions: [],
  sessionId: null,
  session: null,
  resumePoint: null,
  turn: { running: false },
  /** 下一批事件的起始 seq（0-based dense） */
  since: 0,
  /** 事件总数，从流的 total 推进 */
  total: 0,
  machine: null,
  machineDefault: null,
  machines: [],
  errors: 0,
  pollTimer: 0,
  pollGen: 0,
  rendered: new Set(),
  tools: new Map(),
  pendingEl: null,
  sending: false,
  aborting: false,
  creating: false,
  hasContent: false,
  nearBottom: true,
  connected: null,
}

const els = {
  log: document.getElementById("log"),
  empty: document.getElementById("empty"),
  sessionList: document.getElementById("session-list"),
  newSession: document.getElementById("new-session"),
  composer: document.getElementById("composer"),
  input: document.getElementById("input"),
  send: document.getElementById("send"),
  machineSelect: document.getElementById("machine-select"),
  toast: document.getElementById("toast"),
  statusModel: document.getElementById("status-model"),
  statusMachine: document.getElementById("status-machine"),
  statusEvents: document.getElementById("status-events"),
  statusResume: document.getElementById("status-resume"),
  statusCwd: document.getElementById("status-cwd"),
  connDot: document.getElementById("conn-dot"),
  connText: document.getElementById("conn-text"),
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 建一个元素。文本一律走 textContent。 */
function node(tag, className, text) {
  const el = document.createElement(tag)
  if (className) el.className = className
  if (text !== undefined && text !== null) el.textContent = String(text)
  return el
}

function idOf(value) {
  if (!value || typeof value !== "object") return null
  const id = value.sessionId ?? value.id ?? value.session?.sessionId
  return typeof id === "string" && id ? id : null
}

function oneLine(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim()
}

function timeAgo(iso) {
  const t = Date.parse(String(iso ?? ""))
  if (!Number.isFinite(t)) return ""
  const diff = Date.now() - t
  if (diff < 45_000) return "刚刚"
  if (diff < 3_600_000) return `${Math.max(1, Math.round(diff / 60_000))} 分钟前`
  if (diff < 86_400_000) return `${Math.max(1, Math.round(diff / 3_600_000))} 小时前`
  const date = new Date(t)
  const pad = (n) => String(n).padStart(2, "0")
  const md = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  return date.getFullYear() === new Date().getFullYear() ? md : `${date.getFullYear()}-${md}`
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return ""
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes}m${String(seconds).padStart(2, "0")}s`
}

function errorMessage(data) {
  if (!data || typeof data !== "object") return ""
  const err = data.error
  if (typeof err === "string") return err
  if (err && typeof err === "object" && typeof err.message === "string") return err.message
  if (typeof data.message === "string") return data.message
  return ""
}

async function api(path, options) {
  const init = { method: (options && options.method) || "GET", headers: { accept: "application/json" } }
  if (options && options.body !== undefined) {
    init.headers["content-type"] = "application/json"
    init.body = JSON.stringify(options.body)
  }
  const res = await fetch(API + path, init)
  const raw = await res.text()
  let data = null
  if (raw) {
    try {
      data = JSON.parse(raw)
    } catch {
      data = { raw }
    }
  }
  if (!res.ok) {
    const err = new Error(errorMessage(data) || `HTTP ${res.status}`)
    err.status = res.status
    err.data = data
    throw err
  }
  return data ?? {}
}

function setConnected(ok, label) {
  if (state.connected !== ok) state.connected = ok
  els.connDot.className = `dot ${ok ? "dot-ok" : "dot-fail"}`
  els.connText.textContent = ok ? label || "已连接" : "连接断开"
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
  }, 3200)
}

// ---------------------------------------------------------------------------
// 会话列表
// ---------------------------------------------------------------------------

function extractSessions(data) {
  if (Array.isArray(data)) return data
  if (data && Array.isArray(data.sessions)) return data.sessions
  if (data && Array.isArray(data.items)) return data.items
  return []
}

function drawSessionList() {
  els.sessionList.textContent = ""
  if (!state.sessions.length) {
    els.sessionList.appendChild(node("div", "session-empty", "还没有会话。点「＋ 新对话」开始。"))
    return
  }
  for (const session of state.sessions) {
    const id = idOf(session)
    if (!id) continue
    const item = node("button", "session-item")
    item.type = "button"
    item.dataset.id = id
    item.setAttribute("role", "listitem")
    if (id === state.sessionId) item.classList.add("active")

    const title = typeof session.title === "string" && session.title.trim()
      ? session.title.trim()
      : `会话 ${id.slice(0, 6)}`
    item.appendChild(node("div", "session-title", title))

    const meta = node("div", "session-meta")
    const when = session.updatedAt ?? session.createdAt
    meta.appendChild(node("span", "session-time", timeAgo(when) || "—"))
    if (typeof session.eventCount === "number") {
      meta.appendChild(node("span", "session-sep", "·"))
      meta.appendChild(node("span", "session-count", `${session.eventCount} 事件`))
    }
    item.appendChild(meta)

    item.addEventListener("click", () => {
      if (state.sessionId === id) return
      void openSession(id)
    })
    els.sessionList.appendChild(item)
  }
}

async function refreshSessions() {
  try {
    const data = await api("/sessions")
    state.sessions = extractSessions(data)
    drawSessionList()
    return state.sessions
  } catch {
    // 会话列表不是关键路径：断线时保留上一次的列表。
    return state.sessions
  }
}

// ---------------------------------------------------------------------------
// 机器 / 健康
// ---------------------------------------------------------------------------

function machineName(value) {
  if (!value || typeof value !== "object") return null
  const name = value.name ?? value.id ?? value.machine
  return typeof name === "string" && name ? name : null
}

async function loadMachines() {
  try {
    const data = await api("/machines")
    const list = Array.isArray(data?.machines) ? data.machines : Array.isArray(data) ? data : []
    state.machines = list.filter((m) => m && typeof m === "object")
    const current = state.machines.find((m) => m.current === true) || state.machines[0] || null
    state.machineDefault = machineName(current)
    els.machineSelect.textContent = ""
    for (const m of state.machines) {
      const name = machineName(m)
      if (!name) continue
      const option = document.createElement("option")
      option.value = name
      option.textContent = name
      if (m.current === true) option.selected = true
      els.machineSelect.appendChild(option)
    }
    if (!els.machineSelect.options.length) {
      const option = document.createElement("option")
      option.value = ""
      option.textContent = state.machineDefault || "—"
      els.machineSelect.appendChild(option)
    }
    // 机器在会话创建时绑定（契约 §7），这里只做展示，不让用户在已有会话里改。
    els.machineSelect.disabled = true
    updateMachineChip()
    updateStatus()
  } catch {
    els.machineSelect.textContent = ""
    const option = document.createElement("option")
    option.value = ""
    option.textContent = "—"
    els.machineSelect.appendChild(option)
    els.machineSelect.disabled = true
  }
}

async function loadHealth() {
  try {
    const data = await api("/health")
    const status = typeof data?.status === "string" ? data.status : "ok"
    setConnected(true, status === "ok" ? "已连接" : status)
    if (!state.machineDefault) {
      const name = machineName({ machine: data?.machine, name: data?.machine })
      if (name) {
        state.machineDefault = name
        updateMachineChip()
        updateStatus()
      }
    }
  } catch {
    setConnected(false)
  }
}

function updateMachineChip() {
  const name = state.machine || state.machineDefault || ""
  if (name) {
    const exists = Array.from(els.machineSelect.options).some((o) => o.value === name)
    if (!exists) {
      const option = document.createElement("option")
      option.value = name
      option.textContent = name
      els.machineSelect.appendChild(option)
    }
    els.machineSelect.value = name
  }
  els.machineSelect.disabled = true
}

// ---------------------------------------------------------------------------
// 状态条
// ---------------------------------------------------------------------------

function resumeKind() {
  const kind = state.resumePoint && typeof state.resumePoint.kind === "string" ? state.resumePoint.kind : null
  if (!kind || kind === "clean") return null
  // 新会话的 resumePoint 是 "empty"（0 条事件），那不是"恢复"。
  if (state.total === 0) return null
  return kind
}

const RESUME_TITLE = {
  dangling_tool_call: "上次有一个工具调用没有结果，已按失败标记",
  interrupted_turn: "上次的模型调用没有返回，已中断",
}

function updateStatus() {
  const session = state.session
  els.statusModel.textContent = (session && typeof session.model === "string" && session.model) || "—"
  els.statusMachine.textContent = state.machine || state.machineDefault || "—"
  els.statusEvents.textContent = String(state.total)

  const kind = resumeKind()
  if (kind) {
    els.statusResume.hidden = false
    els.statusResume.title = RESUME_TITLE[kind] || `会话从上次中断处恢复（${kind}）`
  } else {
    els.statusResume.hidden = true
  }

  const cwd = session && typeof session.cwd === "string" ? session.cwd : ""
  els.statusCwd.textContent = cwd
  els.statusCwd.title = cwd ? `工作目录：${cwd}` : ""
  els.statusCwd.hidden = !cwd
}

// ---------------------------------------------------------------------------
// 输入区
// ---------------------------------------------------------------------------

function autosize() {
  const ta = els.input
  ta.style.height = "auto"
  const next = Math.min(ta.scrollHeight || 0, MAX_INPUT_HEIGHT)
  ta.style.height = `${next}px`
  ta.style.overflowY = (ta.scrollHeight || 0) > MAX_INPUT_HEIGHT ? "auto" : "hidden"
}

function updateComposer() {
  const running = Boolean(state.turn && state.turn.running)
  els.send.textContent = running ? "停止" : "发送"
  els.send.classList.toggle("is-stop", running)
  els.send.disabled = running ? state.aborting : state.sending
  els.send.title = running ? "停止这一轮（abort）" : "发送（Enter）"
  els.input.placeholder = state.sessionId
    ? "接着说…（Enter 发送，Shift+Enter 换行）"
    : "让它在远端做点什么…（发送会在新会话里开始）"
}

function updateEmptyState() {
  els.empty.hidden = state.hasContent
}

function bindPrompt(button) {
  button.addEventListener("click", () => {
    const prompt = button.dataset.prompt || button.textContent || ""
    els.input.value = prompt
    autosize()
    els.input.focus()
  })
}

function scrollToBottom() {
  els.log.scrollTop = els.log.scrollHeight
}

/** 追加一条区块到对话流；仅当用户本来就在底部时才跟随。 */
function appendBlock(el) {
  if (!state.hasContent) {
    state.hasContent = true
    updateEmptyState()
  }
  els.log.appendChild(el)
  // 转圈永远挂在流的末尾（它表示"下一步正在生成"）。
  if (state.pendingEl) els.log.appendChild(state.pendingEl)
  if (state.nearBottom) scrollToBottom()
}

// ---------------------------------------------------------------------------
// 消息渲染
// ---------------------------------------------------------------------------

function showPending() {
  if (state.pendingEl) {
    if (els.log.lastElementChild !== state.pendingEl) els.log.appendChild(state.pendingEl)
    return
  }
  const row = node("div", "row row-pending")
  const inner = node("div", "pending")
  inner.appendChild(node("span", "spinner", ""))
  inner.appendChild(node("span", "pending-text", "正在生成…"))
  row.appendChild(inner)
  state.pendingEl = row
  if (!state.hasContent) {
    state.hasContent = true
    updateEmptyState()
  }
  els.log.appendChild(row)
  if (state.nearBottom) scrollToBottom()
}

function clearPending() {
  if (!state.pendingEl) return
  state.pendingEl.remove()
  state.pendingEl = null
}

function syncPending() {
  if (state.turn && state.turn.running) showPending()
  else clearPending()
}

/** 把 ``` 代码块渲染成 <pre>，其余文本保留换行。 */
function renderRichText(container, text) {
  const src = String(text ?? "")
  const lines = src.split("\n")
  let buffer = []
  let fence = null

  const flushText = () => {
    if (!buffer.length) return
    // 代码块切开的边界会留下空行；块之间的间距交给 flex gap。
    const block = buffer.join("\n").replace(/^\n+/, "").replace(/\s+$/, "")
    buffer = []
    if (!block) return
    const div = node("div", "msg-text")
    div.textContent = block
    container.appendChild(div)
  }

  const flushCode = (current) => {
    const wrap = node("div", "code-block")
    if (current.lang) wrap.appendChild(node("div", "code-lang", current.lang))
    const pre = node("pre", "code-pre")
    const code = node("code", "code-body", current.lines.join("\n"))
    pre.appendChild(code)
    wrap.appendChild(pre)
    container.appendChild(wrap)
  }

  for (const line of lines) {
    const match = /^\s*```(.*)$/.exec(line)
    if (fence) {
      if (match) {
        flushCode(fence)
        fence = null
      } else {
        fence.lines.push(line)
      }
    } else if (match) {
      flushText()
      fence = { lang: match[1].trim(), lines: [] }
    } else {
      buffer.push(line)
    }
  }
  if (fence) flushCode(fence)
  flushText()
}

function renderUserMessage(data) {
  clearPending()
  const row = node("div", "row row-user")
  const bubble = node("div", "bubble-user", String(data?.text ?? ""))
  row.appendChild(bubble)
  appendBlock(row)
}

function renderAssistantMessage(data) {
  clearPending()
  const text = String(data?.text ?? "")
  if (!text.trim()) return
  const row = node("div", "row row-assistant")
  const body = node("div", "message-body")
  renderRichText(body, text)
  row.appendChild(body)
  appendBlock(row)
}

function argsPreview(args) {
  if (args === null || args === undefined) return null
  if (typeof args === "string") return [{ key: null, value: oneLine(args).slice(0, 400) }]
  if (typeof args !== "object") return [{ key: null, value: String(args) }]
  const keys = Object.keys(args)
  if (!keys.length) return null
  const parts = []
  for (const key of keys.slice(0, 4)) {
    const value = args[key]
    let text
    if (typeof value === "string") text = value
    else if (value === null || typeof value === "number" || typeof value === "boolean") text = String(value)
    else {
      try {
        text = JSON.stringify(value)
      } catch {
        text = String(value)
      }
    }
    parts.push({ key, value: oneLine(text).slice(0, 300) })
  }
  if (keys.length > 4) parts.push({ key: null, value: "…" })
  return parts
}

function createToolCard(input) {
  const card = node("div", "tool-card is-running")
  const head = node("div", "tool-head")

  head.appendChild(node("span", "tool-name", String(input.name || "tool")))
  const machine = input.machine || state.machine || state.machineDefault
  if (machine) head.appendChild(node("span", "tool-machine", String(machine)))

  const status = node("span", "tool-status", "running")
  const durationEl = node("span", "tool-duration", "")
  head.append(status, durationEl)
  card.appendChild(head)

  const preview = argsPreview(input.args)
  if (preview && preview.length) {
    const argsRow = node("div", "tool-args")
    for (const part of preview) {
      if (part.key) argsRow.appendChild(node("span", "arg-key", `${part.key}:`))
      argsRow.appendChild(node("span", "arg-val", part.value))
    }
    card.appendChild(argsRow)
  }

  const details = document.createElement("details")
  details.className = "tool-output"
  details.hidden = true
  const summary = document.createElement("summary")
  summary.className = "tool-output-summary"
  summary.appendChild(node("span", "tool-output-label", "输出"))
  const pre = node("pre", "tool-output-pre")
  details.append(summary, pre)
  card.appendChild(details)

  const callTs = input.ts ? Date.parse(String(input.ts)) : NaN
  return { el: card, status, durationEl, details, pre, callTs }
}

function finishToolCard(card, data, ts) {
  const ok = data?.ok !== false
  card.el.classList.remove("is-running")
  card.el.classList.add(ok ? "is-ok" : "is-fail")
  card.status.textContent = ok ? "ok" : "fail"
  card.status.className = `tool-status ${ok ? "ok" : "fail"}`

  const ended = ts ? Date.parse(String(ts)) : NaN
  const elapsed = formatDuration(ended - card.callTs)
  card.durationEl.textContent = elapsed

  const output = String(data?.output ?? "")
  card.pre.textContent = output.trim() ? output : "(无输出)"
  card.pre.classList.toggle("is-empty", !output.trim())
  card.details.hidden = false
}

function renderToolCall(data, ts) {
  const callId = String(data?.callId ?? "")
  const card = createToolCard({ name: data?.name, args: data?.args, ts, machine: state.machine })
  if (callId) state.tools.set(callId, card)
  appendBlock(card.el)
}

function renderToolResult(data, ts) {
  const callId = String(data?.callId ?? "")
  let card = callId ? state.tools.get(callId) : null
  if (!card) {
    // 重放或半截日志里可能只有 result：仍然给一张卡。
    card = createToolCard({ name: data?.name, args: null, ts: null, machine: state.machine })
    if (callId) state.tools.set(callId, card)
    appendBlock(card.el)
  }
  finishToolCard(card, data, ts)
}

function renderError(data) {
  clearPending()
  const row = node("div", "row row-error")
  const line = node("div", "error-line")
  line.appendChild(node("span", "error-tag", data?.fatal ? "致命" : "错误"))
  line.appendChild(node("span", "error-text", String(data?.message ?? "")))
  row.appendChild(line)
  appendBlock(row)
}

function renderCompaction(data) {
  const row = node("div", "row row-compaction")
  const line = node("div", "compaction-line")
  const firstKept = typeof data?.firstKeptSeq === "number" ? ` · 保留自 seq ${data.firstKeptSeq}` : ""
  line.textContent = `对话已压缩${firstKept}`
  if (typeof data?.summary === "string" && data.summary) {
    line.title = data.summary
    line.classList.add("has-title")
  }
  row.appendChild(line)
  appendBlock(row)
}

function renderEvent(event) {
  if (!event || typeof event !== "object") return
  const data = event.data
  switch (event.type) {
    case "user_message":
      renderUserMessage(data)
      break
    case "assistant_message":
      renderAssistantMessage(data)
      break
    case "assistant_pending":
      showPending()
      break
    case "tool_call":
      renderToolCall(data, event.ts)
      break
    case "tool_result":
      renderToolResult(data, event.ts)
      break
    case "error":
      renderError(data)
      break
    case "compaction":
      renderCompaction(data)
      break
    // memory_write / memory_recall / session_created 不渲染。
    default:
      break
  }
}

function renderEvents(events) {
  if (!Array.isArray(events)) return
  for (const event of events) {
    if (!event || typeof event !== "object") continue
    const seq = typeof event.seq === "number" && Number.isFinite(event.seq) ? event.seq : null
    if (seq !== null) {
      if (state.rendered.has(seq)) continue
      state.rendered.add(seq)
    }
    renderEvent(event)
  }
}

// ---------------------------------------------------------------------------
// 会话加载 / 全量重画
// ---------------------------------------------------------------------------

function countSince(events) {
  let next = 0
  for (const event of events) {
    if (event && typeof event.seq === "number" && Number.isFinite(event.seq)) {
      next = Math.max(next, event.seq + 1)
    }
  }
  return Math.max(next, Array.isArray(events) ? events.length : 0)
}

function pickMachine(data) {
  const candidates = [
    data?.session?.machine,
    data?.session?.machineName,
    data?.machine,
    data?.ctrl?.machine,
    data?.sidecar?.machine,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate) return candidate
  }
  return null
}

function normalizeTurn(turn) {
  if (!turn || typeof turn !== "object") return { running: false }
  return turn
}

async function openSession(id) {
  if (!id) return
  state.pollGen += 1
  window.clearTimeout(state.pollTimer)
  state.pollTimer = 0

  state.sessionId = id
  state.session = null
  state.resumePoint = null
  state.turn = { running: false }
  state.since = 0
  state.total = 0
  state.errors = 0
  state.rendered.clear()
  state.tools.clear()
  state.pendingEl = null
  state.hasContent = false

  els.log.textContent = ""
  els.log.appendChild(els.empty)
  updateEmptyState()
  drawSessionList()
  updateStatus()
  updateComposer()
  await reloadSession()
}

/** GET /api/sessions/:id → 整盘重画（刷新、重连、切会话都走这里）。 */
async function reloadSession() {
  const id = state.sessionId
  if (!id) return null
  const gen = (state.pollGen += 1)
  window.clearTimeout(state.pollTimer)
  state.pollTimer = 0

  let data
  try {
    data = await api(`/sessions/${encodeURIComponent(id)}`)
    state.errors = 0
    setConnected(true)
  } catch (err) {
    setConnected(false)
    if (gen === state.pollGen) schedulePoll(Math.min(POLL_IDLE_MS * 2, 8000))
    return null
  }
  if (gen !== state.pollGen || id !== state.sessionId) return null

  state.session = data?.session && typeof data.session === "object" ? data.session : null
  state.resumePoint = data?.resumePoint && typeof data.resumePoint === "object" ? data.resumePoint : null
  state.turn = normalizeTurn(data?.turn)
  state.machine = pickMachine(data) || state.machine || state.machineDefault
  const events = Array.isArray(data?.events) ? data.events : []

  state.rendered.clear()
  state.tools.clear()
  state.pendingEl = null
  state.hasContent = false
  els.log.textContent = ""
  els.log.appendChild(els.empty)
  updateEmptyState()

  renderEvents(events)
  state.since = countSince(events)
  state.total = state.since
  state.nearBottom = true
  syncPending()
  updateMachineChip()
  updateStatus()
  updateComposer()
  drawSessionList()
  scrollToBottom()

  schedulePoll(state.turn && state.turn.running ? POLL_RUNNING_MS : POLL_IDLE_MS)
  return data
}

// ---------------------------------------------------------------------------
// 轮询
// ---------------------------------------------------------------------------

function schedulePoll(delay) {
  const gen = state.pollGen
  window.clearTimeout(state.pollTimer)
  state.pollTimer = window.setTimeout(() => {
    if (gen !== state.pollGen) return
    void pollOnce()
  }, delay)
}

async function pollOnce() {
  const id = state.sessionId
  if (!id) return
  const gen = state.pollGen
  const since = state.since
  const wasRunning = Boolean(state.turn && state.turn.running)

  let data
  try {
    data = await api(`/sessions/${encodeURIComponent(id)}/events?since=${since}`)
  } catch (err) {
    if (gen !== state.pollGen) return
    setConnected(false)
    state.errors += 1
    if (state.errors >= 3) {
      // 断得太久：重连时整盘重拉，避免局部状态漂移。
      await reloadSession()
      return
    }
    schedulePoll(Math.min(POLL_IDLE_MS, 1000 * state.errors))
    return
  }
  if (gen !== state.pollGen || id !== state.sessionId) return

  state.errors = 0
  setConnected(true)

  const events = Array.isArray(data?.events) ? data.events : []
  renderEvents(events)

  const nextSince = events.reduce((max, event) => {
    return event && typeof event.seq === "number" && Number.isFinite(event.seq)
      ? Math.max(max, event.seq + 1)
      : max
  }, since)
  const total = typeof data?.total === "number" && Number.isFinite(data.total) ? data.total : null
  state.since = Math.max(since, nextSince, total === null ? 0 : total)
  state.total = total === null ? state.since : Math.max(total, state.since)

  if (data && data.turn !== undefined) state.turn = normalizeTurn(data.turn)
  syncPending()
  updateStatus()
  updateComposer()

  const running = Boolean(state.turn && state.turn.running)
  if (wasRunning && !running) {
    // 一轮结束：刷新会话列表里的更新时间/事件数。
    void refreshSessions()
  }
  schedulePoll(running ? POLL_RUNNING_MS : POLL_IDLE_MS)
}

// ---------------------------------------------------------------------------
// 动作：发送 / 停止 / 新会话
// ---------------------------------------------------------------------------

async function ensureSession() {
  if (state.sessionId) return state.sessionId
  const data = await api("/sessions", { method: "POST", body: {} })
  const id = idOf(data?.session) || idOf(data) || idOf(data?.session?.session)
  if (!id) throw new Error("服务端没有返回会话 id")
  await refreshSessions()
  await openSession(id)
  return id
}

async function sendMessage() {
  const text = els.input.value.trim()
  if (!text || state.sending) return
  if (state.turn && state.turn.running) {
    toast("上一轮还在跑，等它结束或先点停止。")
    return
  }
  state.sending = true
  updateComposer()
  try {
    const id = await ensureSession()
    await api(`/sessions/${encodeURIComponent(id)}/messages`, { method: "POST", body: { text } })
    els.input.value = ""
    autosize()
    state.turn = { running: true, startedAt: new Date().toISOString() }
    syncPending()
    updateComposer()
    updateStatus()
    state.nearBottom = true
    schedulePoll(0)
  } catch (err) {
    if (err && err.status === 409) {
      toast("上一轮还在跑，等它结束或先点停止。")
      state.turn = { ...(state.turn || {}), running: true }
      syncPending()
      schedulePoll(POLL_RUNNING_MS)
    } else {
      toast(`发送失败：${(err && err.message) || "未知错误"}`)
    }
  } finally {
    state.sending = false
    updateComposer()
  }
}

async function abortTurn() {
  if (!state.sessionId || state.aborting) return
  state.aborting = true
  updateComposer()
  try {
    const data = await api(`/sessions/${encodeURIComponent(state.sessionId)}/abort`, { method: "POST", body: {} })
    if (data && data.aborted === false) toast("现在没有正在跑的轮次")
    schedulePoll(0)
  } catch (err) {
    toast(`停止失败：${(err && err.message) || "未知错误"}`)
    schedulePoll(POLL_RUNNING_MS)
  } finally {
    state.aborting = false
    updateComposer()
  }
}

async function createSession() {
  if (state.creating) return
  state.creating = true
  els.newSession.disabled = true
  try {
    const data = await api("/sessions", { method: "POST", body: {} })
    const id = idOf(data?.session) || idOf(data)
    if (!id) throw new Error("服务端没有返回会话 id")
    await refreshSessions()
    await openSession(id)
    els.input.focus()
  } catch (err) {
    toast(`新建会话失败：${(err && err.message) || "未知错误"}`)
  } finally {
    state.creating = false
    els.newSession.disabled = false
  }
}

// ---------------------------------------------------------------------------
// 绑定
// ---------------------------------------------------------------------------

function bindUI() {
  for (const button of els.empty.querySelectorAll(".prompt")) bindPrompt(button)

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
      if (!state.sending) toast("上一轮还在跑，等它结束或先点停止。")
      return
    }
    void sendMessage()
  })

  els.newSession.addEventListener("click", () => {
    void createSession()
  })

  els.log.addEventListener("scroll", () => {
    const gap = els.log.scrollHeight - els.log.scrollTop - els.log.clientHeight
    state.nearBottom = gap < NEAR_BOTTOM_PX
  })

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return
    if (state.sessionId) void reloadSession()
    else void refreshSessions()
  })

  window.addEventListener("focus", () => {
    if (!state.sessionId) return
    if (!(state.turn && state.turn.running)) schedulePoll(0)
  })
}

// ---------------------------------------------------------------------------
// 启动（无 top-level await：所有异步都收在 boot 里）
// ---------------------------------------------------------------------------

async function boot() {
  bindUI()
  autosize()
  updateStatus()
  updateComposer()
  updateEmptyState()

  await Promise.allSettled([loadHealth(), loadMachines(), refreshSessions()])

  const first = state.sessions[0]
  const firstId = idOf(first)
  if (firstId) await openSession(firstId)
  else {
    setConnected(true)
    updateStatus()
    updateComposer()
  }
}

void boot()
