#!/usr/bin/env node
/**
 * 启动后自检：只有本脚本通过，才允许把当前 HEAD 晋升为 known-good。
 *
 * 逐个探测受管进程的真实接口（只读，不写任何服务端状态）。
 * 任一项失败立即 abort，最后一行是 `verify-boot: FAIL at step N (<name>)`，exit 1；
 * 全部通过时最后一行是 `verify-boot: PASS`，exit 0（supervisor 靠这两个字符串判定）。
 *
 * 侦察得到的真实返回结构（2026-11，实测 100.115.91.57:7333）：
 *   GET /api/health                 200 {"status":"ok","agent":"scout"}
 *                                   → 判据：status === "ok"（含 agent 字段，不校验）
 *   GET /api/agent                  200 {"agent","session","resumePoint","turn","memory","context"}
 *                                   → turn 字段存在，但**不是数字**，而是对象
 *                                     {"running":boolean,"startedAt"?,"partial"?,"thinking"?}
 *                                     （src/server/turns.ts TurnRegistry.state()）
 *                                     → 判据：有 turn 字段；打印 turn=running|idle
 *   GET /api/memories?kind=lesson   200 {"memories":[{id,kind,text,tags,importance,confidence,
 *                                       createdAt,updatedAt,sourceFrom,sourceTo}],"count":N}
 *                                   → 判据：memories 数组长度 > 0（服务端还给了 count，二者应一致）
 *   GET /api/focus                  200 {"items":[{id,text,state,updatedAt,seq,accept,...}]}
 *                                   → 判据：合法 JSON（数组是 items，不是顶层数组）
 *   GET /                         200 HTML，时间线容器是 <main class="timeline" id="timeline">
 *                                   → 判据：HTML 里出现 id="timeline"
 *   第 6 项跑 scripts/experience.mjs —— 它**必须**带 --url 和 --out（缺了会抛 args 错误），
 *   输出首行 `experience <url> — N widths, M failing`，据此取 M 与退出码。
 *
 * 用法：
 *   node scripts/verify-boot.mjs [--base http://100.115.91.57:7333] [--skip-experience]
 *                                [--timeout 2500] [--verbose]
 *
 * 说明：传输层失败（超时/连接拒绝/DNS）重试一次再判 FAIL，因为线上进程实测有 2-3s 的
 * 事件循环停顿尖峰（/ 曾见 3.2s），一次慢响应不等于启动失败；HTTP 状态码不重试。
 * --skip-experience 直接跳过第 6 项（此时第 5 项后直接打 PASS）。
 */
import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const DEFAULT_BASE = "http://100.115.91.57:7333"

const DEFAULT_TIMEOUT_MS = 2_500

const EXPERIENCE_WIDTHS = "390"

const EXPERIENCE_READY_TIMEOUT_MS = 20_000

const EXPERIENCE_KILL_MS = 180_000

const EXPERIENCE_TAIL_LINES = 8

const SNIPPET_LIMIT = 200

const NAME_WIDTH = 17

/** 传输层失败最多试两次（见 request() 注释）。 */
const TRANSPORT_ATTEMPTS = 2

const TOTAL_STEPS = 6

const EXIT_OK = 0

const EXIT_FAILED = 1

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))

/** 时间线容器：src/web/public/index.html 里是 <main class="timeline" id="timeline" ...> */
const TIMELINE_CONTAINER = 'id="timeline"'

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function scrub(text) {
  const raw = String(text ?? "")
  const masked = raw.replace(
    /("?[\w-]*(?:token|secret|password|passwd|api[_-]?key|authorization|cookie|credential)[\w-]*"?\s*:\s*)"[^"]*"/gi,
    '$1"<redacted>"',
  )
  return masked.replace(/\b(bearer\s+)[^\s",]+/gi, "$1<redacted>")
}

function snippet(text) {
  const cleaned = scrub(text).replace(/\s+/g, " ").trim()
  if (cleaned === "") return "<empty>"
  return cleaned.length > SNIPPET_LIMIT ? `${cleaned.slice(0, SNIPPET_LIMIT)}…` : cleaned
}

function parsePositiveInt(text) {
  const parsed = Number.parseInt(String(text ?? ""), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

function parseArgs(argv) {
  const envBase = String(process.env.CTRL_VERIFY_BASE ?? "").trim()
  const opts = {
    base: envBase === "" ? DEFAULT_BASE : envBase,
    skipExperience: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    verbose: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === "--base") {
      const value = String(argv[index + 1] ?? "").trim()
      if (value === "") throw new Error("--base needs a value, e.g. --base http://100.115.91.57:7333")
      opts.base = value
      index += 1
      continue
    }
    if (flag === "--skip-experience") {
      opts.skipExperience = true
      continue
    }
    if (flag === "--timeout") {
      const parsed = parsePositiveInt(argv[index + 1])
      if (parsed === undefined) throw new Error("--timeout needs a positive number of milliseconds")
      opts.timeoutMs = parsed
      index += 1
      continue
    }
    if (flag === "--verbose") {
      opts.verbose = true
      continue
    }
    throw new Error(`unknown argument ${flag}`)
  }
  opts.base = opts.base.replace(/\/+$/, "")
  return opts
}

function urlFor(base, suffix) {
  return `${base}${suffix}`
}

function baseOf(base) {
  return `${base}/`
}

/** 把 fetch 的各类失败（拒绝连接、超时、DNS）转成一句人话，不抛原始异常。 */
function describeFetchError(error, timeoutMs) {
  const name = error instanceof Error ? error.name : ""
  if (name === "TimeoutError" || name === "AbortError") return `timeout after ${timeoutMs}ms`
  const cause = error instanceof Error ? error.cause : undefined
  if (cause !== null && typeof cause === "object") {
    const code = typeof cause.code === "string" ? cause.code : ""
    const message = typeof cause.message === "string" ? cause.message : errorMessage(cause)
    const combined = `${code} ${message}`.trim()
    if (combined !== "") return combined === "ECONNREFUSED" ? "ECONNREFUSED (nothing listening)" : combined
  }
  return errorMessage(error) || "request failed"
}

/**
 * 单次 GET。传输层失败（超时 / 连接拒绝 / DNS）重试一次：
 * 线上进程偶尔出现 2-3s 的事件循环停顿（实测 / 有 3.2s 的尖峰），
 * 一次慢响应不足以证明启动失败，但确定性的失败（127.0.0.1 无监听）重试后仍然失败。
 * 只看传输层：HTTP 4xx/5xx 不重试，直接交给检查项判 FAIL。
 */
async function request(url, timeoutMs) {
  let reason = "request failed"
  for (let attempt = 1; attempt <= TRANSPORT_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "GET",
        redirect: "manual",
        headers: { accept: "*/*", "user-agent": "ctrl-verify-boot" },
        signal: AbortSignal.timeout(timeoutMs),
      })
      const text = await response.text()
      return { ok: true, status: response.status, text, attempts: attempt }
    } catch (error) {
      reason = describeFetchError(error, timeoutMs)
    }
  }
  return { ok: false, reason }
}

function parseJsonBody(text) {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch (error) {
    return { ok: false, reason: `invalid JSON: ${snippet(errorMessage(error))}` }
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function turnLabel(turn) {
  if (typeof turn === "number" && Number.isFinite(turn)) return String(turn)
  if (typeof turn === "string" && turn !== "") return turn
  if (turn === null || typeof turn !== "object") return String(turn)
  if (typeof turn.running === "boolean") return turn.running ? "running" : "idle"
  const id = turn.id ?? turn.seq ?? turn.count
  if (id !== undefined && id !== null) return String(id)
  return "present"
}

/** 检查项统一返回 { detail }：失败时 throw 一个带 detail 的 Error。 */
function fail(detail) {
  const error = new Error(detail)
  error.detail = detail
  throw error
}

function failureDetail(error) {
  const detail = error?.detail
  return typeof detail === "string" && detail !== "" ? detail : errorMessage(error)
}

async function checkHealth(ctx) {
  const url = urlFor(ctx.base, "/api/health")
  const reply = await request(url, ctx.timeoutMs)
  if (!reply.ok) fail(reply.reason)
  ctx.snippet("health", `HTTP ${reply.status} ${reply.text}`)
  if (reply.status !== 200) fail(`HTTP ${reply.status} (expected 200)`)
  const body = parseJsonBody(reply.text)
  if (!body.ok) fail(body.reason)
  if (!isPlainObject(body.value) || body.value.status !== "ok") {
    fail(`status=${snippet(JSON.stringify(body.value.status))} (expected "ok")`)
  }
  return { detail: "" }
}

async function checkAgent(ctx) {
  const url = urlFor(ctx.base, "/api/agent")
  const reply = await request(url, ctx.timeoutMs)
  if (!reply.ok) fail(reply.reason)
  ctx.snippet("agent", `HTTP ${reply.status} ${reply.text}`)
  if (reply.status !== 200) fail(`HTTP ${reply.status} (expected 200)`)
  const body = parseJsonBody(reply.text)
  if (!body.ok) fail(body.reason)
  if (!isPlainObject(body.value)) fail("body is not a JSON object")
  if (!("turn" in body.value)) fail(`no turn field (keys: ${Object.keys(body.value).join(",") || "none"})`)
  return { detail: `turn=${turnLabel(body.value.turn)}` }
}

async function checkMemories(ctx) {
  const url = urlFor(ctx.base, "/api/memories?kind=lesson")
  const reply = await request(url, ctx.timeoutMs)
  if (!reply.ok) fail(reply.reason)
  ctx.snippet("memories.lesson", `HTTP ${reply.status} ${reply.text}`)
  if (reply.status !== 200) fail(`HTTP ${reply.status} (expected 200)`)
  const body = parseJsonBody(reply.text)
  if (!body.ok) fail(body.reason)
  const rows = Array.isArray(body.value)
    ? body.value
    : isPlainObject(body.value) && Array.isArray(body.value.memories)
      ? body.value.memories
      : undefined
  if (rows === undefined) fail("no memories array in body")
  const count = rows.length
  if (count <= 0) fail("count=0 (expected > 0)")
  return { detail: `count=${count}` }
}

async function checkFocus(ctx) {
  const url = urlFor(ctx.base, "/api/focus")
  const reply = await request(url, ctx.timeoutMs)
  if (!reply.ok) fail(reply.reason)
  ctx.snippet("focus", `HTTP ${reply.status} ${reply.text}`)
  if (reply.status !== 200) fail(`HTTP ${reply.status} (expected 200)`)
  const body = parseJsonBody(reply.text)
  if (!body.ok) fail(body.reason)
  return { detail: "" }
}

async function checkPage(ctx) {
  const url = baseOf(ctx.base)
  const reply = await request(url, ctx.timeoutMs)
  if (!reply.ok) fail(reply.reason)
  ctx.snippet("page", `HTTP ${reply.status} ${reply.text}`)
  if (reply.status !== 200) fail(`HTTP ${reply.status} (expected 200)`)
  if (!reply.text.includes(TIMELINE_CONTAINER)) fail(`no ${TIMELINE_CONTAINER} in HTML (timeline container missing)`)
  return { detail: "timeline container found" }
}

function runExperience(ctx) {
  const script = path.join(SCRIPT_DIR, "experience.mjs")
  const args = [
    script,
    "--widths",
    EXPERIENCE_WIDTHS,
    "--timeout",
    String(EXPERIENCE_READY_TIMEOUT_MS),
    "--url",
    baseOf(ctx.base),
    "--out",
    ctx.experienceOut,
  ]
  return new Promise((resolve) => {
    const chunks = []
    let settled = false
    let child
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve({ ...result, output: chunks.join("") })
    }
    try {
      child = spawn(process.execPath, args, { cwd: path.join(SCRIPT_DIR, ".."), stdio: ["ignore", "pipe", "pipe"] })
    } catch (error) {
      finish({ ok: false, reason: `could not spawn experience.mjs: ${snippet(errorMessage(error))}` })
      return
    }
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL")
      } catch {

      }
      finish({ ok: false, reason: `experience.mjs still running after ${Math.round(EXPERIENCE_KILL_MS / 1000)}s` })
    }, EXPERIENCE_KILL_MS)
    child.stdout?.on("data", (chunk) => chunks.push(chunk.toString("utf8")))
    child.stderr?.on("data", (chunk) => chunks.push(chunk.toString("utf8")))
    child.on("error", (error) => {
      clearTimeout(timer)
      finish({ ok: false, reason: `could not spawn experience.mjs: ${snippet(errorMessage(error))}` })
    })
    child.on("close", (code, signal) => {
      clearTimeout(timer)
      finish({ ok: true, code: code ?? (signal === null ? -1 : 1), signal })
    })
  })
}

function failingCount(output) {
  const matches = [...String(output ?? "").matchAll(/(\d+)\s+failing/gi)]
  const last = matches[matches.length - 1]
  if (last === undefined) return undefined
  const parsed = Number.parseInt(last[1], 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

function experienceTail(output) {
  const lines = String(output ?? "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "")
  return lines.slice(-EXPERIENCE_TAIL_LINES).join(" / ")
}

async function checkExperience(ctx) {
  const result = await runExperience(ctx)
  ctx.snippet("experience", result.output ?? result.reason ?? "")
  if (!result.ok) fail(result.reason)
  if (result.signal !== null && result.signal !== undefined) fail(`experience.mjs killed by ${result.signal}`)
  const failing = failingCount(result.output)
  if (failing === undefined) {
    const tail = experienceTail(result.output)
    fail(`exit=${result.code}, no "N failing" summary (${tail === "" ? "no output" : tail})`)
  }
  if (failing !== 0) fail(`failing=${failing} (expected 0) — ${experienceTail(result.output)}`)
  if (result.code !== 0) fail(`exit=${result.code} with failing=0`)
  return { detail: "0 failing" }
}

function buildSteps(skipExperience) {
  const steps = [
    { name: "health", run: checkHealth },
    { name: "agent", run: checkAgent },
    { name: "memories.lesson", run: checkMemories },
    { name: "focus", run: checkFocus },
    { name: "page", run: checkPage },
  ]
  if (!skipExperience) steps.push({ name: "experience", run: checkExperience })
  return steps
}

function line(index, name, status, elapsedMs, detail) {
  const head = `verify-boot: ${index}/${TOTAL_STEPS} ${name.padEnd(NAME_WIDTH)}${status}  (${Math.round(elapsedMs)}ms)`
  return detail === "" || detail === undefined ? head : `${head}  ${detail}`
}

async function prepareExperienceOut() {
  return await mkdtemp(path.join(tmpdir(), "ctrl-verify-boot-"))
}

async function run() {
  const opts = parseArgs(process.argv.slice(2))
  const ctx = {
    base: opts.base,
    timeoutMs: opts.timeoutMs,
    verbose: opts.verbose,
    experienceOut: "",
    snippet(label, body) {
      if (!this.verbose) return
      process.stdout.write(`verify-boot: debug ${label} → ${snippet(body)}\n`)
    },
  }

  const steps = buildSteps(opts.skipExperience)
  const needsExperience = steps.some((step) => step.name === "experience")
  try {
    if (needsExperience) ctx.experienceOut = await prepareExperienceOut()
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index]
      const number = index + 1
      const startedAt = Date.now()
      try {
        const result = await step.run(ctx)
        const elapsed = Date.now() - startedAt
        process.stdout.write(`${line(number, step.name, "ok", elapsed, result?.detail ?? "")}\n`)
      } catch (error) {
        const elapsed = Date.now() - startedAt
        process.stdout.write(`${line(number, step.name, "FAIL", elapsed, failureDetail(error))}\n`)
        process.stdout.write(`verify-boot: FAIL at step ${number} (${step.name})\n`)
        process.exitCode = EXIT_FAILED
        return
      }
    }
    process.stdout.write("verify-boot: PASS\n")
    process.exitCode = EXIT_OK
  } finally {
    if (ctx.experienceOut !== "") await rm(ctx.experienceOut, { recursive: true, force: true }).catch(() => {})
  }
}

try {
  await run()
} catch (error) {
  process.stdout.write(`verify-boot: FAIL at step 0 (args)  ${snippet(errorMessage(error))}\n`)
  process.stdout.write(`verify-boot: ${scrub(errorMessage(error))}\n`)
  process.exitCode = EXIT_FAILED
}
