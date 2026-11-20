import { spawn } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  CHROME_PATH,
  DEFAULT_WIDTHS,
  READY_TIMEOUT_MS,
  VIEWPORT_HEIGHT,
  classifyConsole,
  findOverflow,
  formatSummary,
  measureExpression,
  reportFailed,
  rowsExpression,
} from "../src/web/experience.ts"

const DEVTOOLS_TIMEOUT_MS = 15_000

const COMMAND_TIMEOUT_MS = 30_000

const SETTLE_MS = 300

const EXIT_OK = 0

const EXIT_FAILED = 1

const EXIT_BROKEN = 2

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function parseWidths(text) {
  const widths = String(text ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .map((part) => Number.parseInt(part, 10))
    .filter((value) => Number.isFinite(value) && value >= 240 && value <= 4096)
  return widths.length === 0 ? [...DEFAULT_WIDTHS] : widths
}

function parseArgs(argv) {
  const opts = { url: "", out: "", widths: [...DEFAULT_WIDTHS], chrome: CHROME_PATH, readyTimeoutMs: READY_TIMEOUT_MS }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (flag === "--url") {
      opts.url = String(value ?? "").trim()
      index += 1
      continue
    }
    if (flag === "--out") {
      opts.out = String(value ?? "").trim()
      index += 1
      continue
    }
    if (flag === "--widths") {
      opts.widths = parseWidths(value)
      index += 1
      continue
    }
    if (flag === "--chrome") {
      opts.chrome = String(value ?? "").trim() || CHROME_PATH
      index += 1
      continue
    }
    if (flag === "--timeout") {
      const parsed = Number.parseInt(String(value ?? ""), 10)
      opts.readyTimeoutMs = Number.isFinite(parsed) && parsed > 0 ? parsed : READY_TIMEOUT_MS
      index += 1
      continue
    }
    throw new Error(`unknown argument ${flag}`)
  }
  if (opts.url === "") throw new Error("usage: node scripts/experience.mjs --url http://host:7333/ --out /tmp/exp [--widths 390,1280]")
  if (opts.out === "") throw new Error("usage: node scripts/experience.mjs --url http://host:7333/ --out /tmp/exp [--widths 390,1280]")
  return opts
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = typeof address === "object" && address !== null ? address.port : 0
      server.close(() => (port > 0 ? resolve(port) : reject(new Error("could not reserve a debugging port"))))
    })
  })
}

async function waitForDevtools(port, timeoutMs, probe) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = probe()
    if (typeof state === "string" && state !== "") throw new Error(`chrome could not start: ${state}`)
    if (typeof state === "number") throw new Error(`chrome exited with code ${state} before devtools answered`)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1_000) })
      if (response.ok) {
        const body = await response.json()
        if (typeof body.webSocketDebuggerUrl === "string" && body.webSocketDebuggerUrl !== "") return body.webSocketDebuggerUrl
      }
    } catch {

    }
    await sleep(150)
  }
  throw new Error(`chrome devtools did not answer on port ${port} within ${Math.round(timeoutMs / 1000)}s`)
}

function describeRemote(item) {
  if (item === null || typeof item !== "object") return String(item)
  if (typeof item.value === "string") return item.value
  if (item.value !== undefined && item.value !== null) return String(item.value)
  if (typeof item.unserializableValue === "string") return item.unserializableValue
  if (typeof item.description === "string") return item.description
  return String(item.type ?? "value")
}

function describeArgs(args) {
  return (Array.isArray(args) ? args : []).map(describeRemote).join(" ")
}

class Devtools {
  constructor() {
    this.socket = undefined
    this.nextId = 0
    this.pending = new Map()
    this.listeners = new Set()
  }

  async open(url) {
    await new Promise((resolve, reject) => {
      const socket = new WebSocket(url)
      const fail = (error) => reject(error instanceof Error ? error : new Error("devtools socket failed"))
      socket.addEventListener(
        "open",
        () => {
          this.socket = socket
          resolve()
        },
        { once: true },
      )
      socket.addEventListener("error", fail, { once: true })
      socket.addEventListener("close", () => {
        for (const entry of this.pending.values()) {
          clearTimeout(entry.timer)
          entry.reject(new Error(`devtools socket closed while waiting for ${entry.method}`))
        }
        this.pending.clear()
        if (this.socket === undefined) reject(new Error("devtools socket closed before it opened"))
      })
      socket.addEventListener("message", (event) => this.dispatch(event.data))
    })
  }

  dispatch(raw) {
    let message
    try {
      message = JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8"))
    } catch {
      return
    }
    if (message !== null && typeof message === "object" && message.id !== undefined && this.pending.has(message.id)) {
      const entry = this.pending.get(message.id)
      this.pending.delete(message.id)
      clearTimeout(entry.timer)
      const failure = message.error
      if (failure !== undefined && failure !== null) {
        entry.reject(new Error(String(failure.message ?? `devtools rejected ${entry.method}`)))
        return
      }
      entry.resolve(message.result ?? {})
      return
    }
    for (const listener of this.listeners) listener(message)
  }

  send(method, params = {}, sessionId) {
    const socket = this.socket
    if (socket === undefined) return Promise.reject(new Error("devtools socket is not open"))
    const id = (this.nextId += 1)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`devtools command ${method} timed out`))
      }, COMMAND_TIMEOUT_MS)
      timer.unref()
      this.pending.set(id, { resolve, reject, timer, method })
      socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }))
    })
  }

  on(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async createTarget(url) {
    const created = await this.send("Target.createTarget", { url })
    const targetId = String(created.targetId ?? "")
    if (targetId === "") throw new Error("devtools did not answer with a target id")
    const attached = await this.send("Target.attachToTarget", { targetId, flatten: true })
    const sessionId = String(attached.sessionId ?? "")
    if (sessionId === "") throw new Error("devtools did not answer with a session id")
    return { targetId, sessionId }
  }

  async closeTarget(targetId) {
    try {
      await this.send("Target.closeTarget", { targetId })
    } catch {

    }
  }

  close() {
    const socket = this.socket
    this.socket = undefined
    try {
      socket?.close()
    } catch {

    }
  }
}

function collectConsole(devtools, sessionId) {
  const events = []
  const off = devtools.on((message) => {
    if (message === null || typeof message !== "object" || message.sessionId !== sessionId) return
    if (message.method === "Runtime.consoleAPICalled") {
      const params = message.params ?? {}
      events.push({ kind: "console", type: String(params.type ?? ""), text: describeArgs(params.args) })
      return
    }
    if (message.method === "Runtime.exceptionThrown") {
      const details = message.params?.exceptionDetails ?? {}
      const exception = details.exception ?? {}
      const text = typeof exception.description === "string" ? exception.description : String(details.text ?? "exception")
      events.push({ kind: "exception", text })
    }
  })
  return { events, off }
}

async function waitForRows(devtools, sessionId, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const reply = await devtools.send("Runtime.evaluate", { expression: rowsExpression(), returnByValue: true }, sessionId)
    const value = reply.result?.value
    if (typeof value === "number" && value > 0) return true
    await sleep(150)
  }
  return false
}

function measurementOf(reply) {
  const value = reply.result?.value
  if (value === null || typeof value !== "object") throw new Error("the measurement expression returned no object")
  const composer = value.composer === null || typeof value.composer !== "object" ? null : value.composer
  return {
    scrollWidth: Number(value.scrollWidth ?? 0),
    clientWidth: Number(value.clientWidth ?? 0),
    rows: Number(value.rows ?? 0),
    composer:
      composer === null
        ? null
        : { x: Number(composer.x ?? 0), y: Number(composer.y ?? 0), width: Number(composer.width ?? 0), height: Number(composer.height ?? 0) },
    wide: (Array.isArray(value.wide) ? value.wide : []).map((box) => ({
      tag: String(box?.tag ?? ""),
      cls: String(box?.cls ?? ""),
      left: Number(box?.left ?? 0),
      right: Number(box?.right ?? 0),
    })),
  }
}

async function measureWidth(devtools, opts, width) {
  const { targetId, sessionId } = await devtools.createTarget("about:blank")
  const capture = collectConsole(devtools, sessionId)
  try {
    await devtools.send("Runtime.enable", {}, sessionId)
    await devtools.send("Page.enable", {}, sessionId)
    await devtools.send(
      "Emulation.setDeviceMetricsOverride",
      { width, height: VIEWPORT_HEIGHT, deviceScaleFactor: 1, mobile: false },
      sessionId,
    )
    const navigation = await devtools.send("Page.navigate", { url: opts.url }, sessionId)
    const errorText = String(navigation.errorText ?? "")
    if (errorText !== "") throw new Error(`navigation to ${opts.url} failed: ${errorText}`)
    const ready = await waitForRows(devtools, sessionId, opts.readyTimeoutMs)
    await sleep(SETTLE_MS)
    await devtools.send("Page.bringToFront", {}, sessionId)
    const shot = await devtools.send("Page.captureScreenshot", { format: "png", fromSurface: true }, sessionId)
    const screenshot = path.join(opts.out, `${width}.png`)
    await writeFile(screenshot, Buffer.from(String(shot.data ?? ""), "base64"))
    const measured = measurementOf(await devtools.send("Runtime.evaluate", { expression: measureExpression(), returnByValue: true }, sessionId))
    return {
      width,
      ready,
      screenshot,
      measurement: measured,
      overflow: findOverflow(measured.wide, measured.clientWidth),
      console: classifyConsole(capture.events),
    }
  } finally {
    capture.off()
    await devtools.closeTarget(targetId)
  }
}

function buildReport(url, startedAt, widths) {
  return { url, startedAt, widths, ok: !reportFailed({ url, startedAt, ok: false, widths }) }
}

async function run() {
  const opts = parseArgs(process.argv.slice(2))
  await mkdir(opts.out, { recursive: true })
  const profile = await mkdtemp(path.join(tmpdir(), "ctrl-experience-"))
  const port = await freePort()
  const chrome = spawn(
    opts.chrome,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      `--window-size=${Math.max(...opts.widths)},${VIEWPORT_HEIGHT}`,
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  )
  let chromeStderr = ""
  let spawnFailure = ""
  chrome.stderr?.on("data", (chunk) => {
    chromeStderr += chunk.toString("utf8")
  })
  chrome.on("error", (error) => {
    spawnFailure = errorMessage(error)
  })
  const devtools = new Devtools()
  try {
    const socketUrl = await waitForDevtools(port, DEVTOOLS_TIMEOUT_MS, () => (spawnFailure !== "" ? spawnFailure : chrome.exitCode))
    await devtools.open(socketUrl)
    const widths = []
    for (const width of opts.widths) widths.push(await measureWidth(devtools, opts, width))
    const report = buildReport(opts.url, new Date().toISOString(), widths)
    await writeFile(path.join(opts.out, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8")
    process.stdout.write(`${formatSummary(report)}\n`)
    process.exitCode = report.ok ? EXIT_OK : EXIT_FAILED
  } catch (error) {
    const detail = chromeStderr.trim()
    throw new Error(detail === "" ? errorMessage(error) : `${errorMessage(error)} — ${detail}`)
  } finally {
    devtools.close()
    chrome.kill("SIGKILL")
    await rm(profile, { recursive: true, force: true }).catch(() => {})
  }
}

try {
  await run()
} catch (error) {
  process.stderr.write(`experience failed: ${errorMessage(error)}\n`)
  process.exitCode = EXIT_BROKEN
}
