// SshExecutor: the hands work on another machine (CONTRACT §4).
//
// Transport rules that are not negotiable:
//   * one ControlMaster socket per machine — a fresh connection costs ~1.1 s,
//     a multiplexed one ~32 ms, and every tool call is a connection.
//   * the system `ssh` binary, never a library.
//   * every remote command is a POSIX single-quoted string; a path is an
//     argument, never a fragment of a concatenated script.
//   * errors are rewritten before the model sees them: no `ssh:` prefixes, no
//     host names, no `Permission denied (publickey)`.

import { spawn } from "node:child_process"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  assertText,
  formatTaskTail,
  MAX_CAPTURE_CHARS,
  sliceLines,
  tailLines,
  type ExecOptions,
  type ExecResult,
  type Executor,
  type ListOptions,
  type ReadOptions,
  type SpawnOptions,
  type TaskReadOptions,
  type WriteOptions,
} from "./types.ts"

const DEFAULT_TIMEOUT_MS = 120_000
const MASTER_TIMEOUT_MS = 20_000
const EXIT_MARKER = "__CTRL_TASK_EXIT__"
const TASK_DIR_REMOTE = "\"$HOME\"/.ctrl/tasks"

// ---------------------------------------------------------------------------
// Quoting (exported for the unit tests)
// ---------------------------------------------------------------------------

/**
 * POSIX single-quote escaping: wrap in `'…'` and close/reopen around every `'`.
 * `it's` becomes `'it'\''s'`. Nothing else needs escaping inside quotes.
 */
export function quote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

/**
 * Quote a path for the remote shell, letting a leading `~` stay expandable.
 * A quoted `'~/x'` would be a literal directory named `~`, which is the exact
 * bug this function exists to prevent.
 */
export function quotePath(value: string): string {
  if (value === "~") return "\"$HOME\""
  if (value.startsWith("~/")) return `"$HOME"/${quote(value.slice(2))}`
  return quote(value)
}

/** Join argv into one shell-safe line, each element quoted on its own. */
export function joinArgv(argv: string[]): string {
  return argv.map(quote).join(" ")
}

/** The remote command for `exec`: `cd <cwd> && sh -c '<quoted argv>'`. */
export function buildExecScript(argv: string[], cwd?: string): string {
  const command = `sh -c ${quote(joinArgv(argv))}`
  return cwd ? `cd ${quotePath(cwd)} && ${command}` : command
}

/** Resolve a tool path against the session's remote cwd, without a shell. */
export function remotePath(target: string, cwd?: string): string {
  if (target.startsWith("/") || target === "~" || target.startsWith("~/")) return target
  if (!cwd) return target
  const base = cwd.length > 1 && cwd.endsWith("/") ? cwd.slice(0, -1) : cwd
  return `${base}/${target}`
}

/** Textual dirname for a remote path (`~` and absolute paths both work). */
export function remoteDirname(target: string): string {
  const trimmed = target.replace(/\/+$/, "")
  const cut = trimmed.lastIndexOf("/")
  if (cut < 0) return "."
  if (cut === 0) return "/"
  return trimmed.slice(0, cut)
}

/**
 * Rewrite transport noise so the model never learns a host name and never sees
 * an ssh diagnostic it cannot act on. Remote stderr (the command's own) is
 * passed through untouched — that is the useful part.
 */
export function sanitizeStderr(text: string, host: string): string {
  if (!text) return ""
  const hostPattern = new RegExp(escapeRegExp(host), "g")
  const lines = text.split("\n").map((line) => {
    const trimmed = line.trimStart()
    if (!/^ssh:\s/.test(trimmed) && !isTransportLine(trimmed)) {
      return line.replace(hostPattern, "machine")
    }
    const detail = trimmed.replace(/^ssh:\s*/, "")
    return `machine unreachable: ${translate(detail)}`
  })
  return lines.join("\n").replace(hostPattern, "machine")
}

function isTransportLine(line: string): boolean {
  return /Permission denied \(/.test(line) ||
    /^Host key verification failed/.test(line) ||
    /^Connection (refused|closed|reset)/.test(line) ||
    /^Could not resolve hostname/.test(line) ||
    /^Control socket connect\(/.test(line) ||
    /^ssh_exchange_identification/.test(line) ||
    /^kex_exchange_identification/.test(line)
}

function translate(detail: string): string {
  const clean = detail
    .replace(/^Could not resolve hostname \S+:\s*/, "could not resolve host name — ")
    .replace(/^Control socket connect\([^)]*\):\s*/, "")
    .replace(/^connect to host \S+ port \d+:\s*/, "")
    .replace(/^(\S+)@(\S+):\s*/, "")
    .replace(/^Connection (refused|closed|reset)\.?$/, "connection $1")
    .replace(/^Permission denied \(publickey[^)]*\)\.?$/, "authentication failed — no usable ssh key")
    .replace(/^Host key verification failed\.?$/, "host key verification failed")
  return clean.trim() || "connection failed"
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export interface SshExecutorOptions {
  /** A `Host` alias from ~/.ssh/config. */
  host: string
  cwd?: string
  /** Overrides the ControlMaster socket path (tests). */
  socketPath?: string
  /** Overrides the binary, e.g. a stub in tests. */
  sshBinary?: string
  controlPersistSeconds?: number
}

interface LocalRun {
  code: number | null
  stdout: string
  stderr: string
  ms: number
  timedOut: boolean
  truncated: boolean
}

export class SshExecutor implements Executor {
  readonly kind = "ssh" as const
  readonly machine: string
  private readonly host: string
  private readonly socketPath: string
  private readonly sshBinary: string
  private readonly persist: number
  private readonly defaultCwd: string | undefined
  private masterState: "unknown" | "ready" | "degraded" = "unknown"
  private masterError = ""

  constructor(opts: SshExecutorOptions) {
    this.host = opts.host
    this.machine = opts.host
    this.defaultCwd = opts.cwd
    this.sshBinary = opts.sshBinary ?? "ssh"
    this.persist = opts.controlPersistSeconds ?? 60
    this.socketPath = opts.socketPath ?? path.join(tmpdir(), `ctrl-${opts.host.replace(/[^a-zA-Z0-9._-]/g, "_")}.sock`)
  }

  async exec(argv: string[], o: ExecOptions = {}): Promise<ExecResult> {
    if (argv.length === 0) throw new Error("exec requires at least one argv element")
    const cwd = o.cwd ?? this.defaultCwd
    const started = Date.now()
    const run = await this.runRemote(buildExecScript(argv, cwd), {
      ...(o.input !== undefined ? { input: o.input } : {}),
      timeoutMs: o.timeoutMs !== undefined && o.timeoutMs > 0 ? o.timeoutMs : DEFAULT_TIMEOUT_MS,
    })
    return {
      code: run.code,
      stdout: run.stdout,
      stderr: sanitizeStderr(run.stderr, this.host),
      ms: Date.now() - started,
      timedOut: run.timedOut,
      truncated: run.truncated,
    }
  }

  async read(target: string, o: ReadOptions = {}): Promise<string> {
    const resolved = remotePath(target, o.cwd ?? this.defaultCwd)
    const run = await this.runRemote(`cat ${quotePath(resolved)}`, { timeoutMs: DEFAULT_TIMEOUT_MS })
    this.assertOk(run, `read ${target}`)
    assertText(run.stdout, target)
    return sliceLines(run.stdout, o.offset, o.limit)
  }

  async write(target: string, data: string, o: WriteOptions = {}): Promise<void> {
    const resolved = remotePath(target, o.cwd ?? this.defaultCwd)
    const dir = remoteDirname(resolved)
    const script = `mkdir -p ${quotePath(dir)} && cat > ${quotePath(resolved)}`
    const run = await this.runRemote(script, { input: data, timeoutMs: DEFAULT_TIMEOUT_MS })
    this.assertOk(run, `write ${target}`)
  }

  async list(target: string, o: ListOptions = {}): Promise<string[]> {
    const resolved = remotePath(target, o.cwd ?? this.defaultCwd)
    const run = await this.runRemote(`ls -1Ap ${quotePath(resolved)}`, { timeoutMs: DEFAULT_TIMEOUT_MS })
    this.assertOk(run, `list ${target}`)
    return run.stdout.split("\n").map((line) => line.trimEnd()).filter((line) => line.length > 0)
  }

  async spawn(argv: string[], o: SpawnOptions = {}): Promise<{ address: string }> {
    if (argv.length === 0) throw new Error("spawn requires at least one argv element")
    const id = newTaskId()
    const cwd = o.cwd ?? this.defaultCwd
    const log = `${TASK_DIR_REMOTE}/${id}.log`
    const code = `${TASK_DIR_REMOTE}/${id}.code`
    const pid = `${TASK_DIR_REMOTE}/${id}.pid`
    const command = joinArgv(argv)
    const envPrefix = o.env
      ? Object.entries(o.env).map(([key, value]) => `${key}=${quote(value)} `).join("")
      : ""
    const inner = `${envPrefix}${command}\necho $? > ${code}`
    const lines = [
      `mkdir -p ${TASK_DIR_REMOTE}`,
      ...(cwd ? [`cd ${quotePath(cwd)}`] : []),
      `setsid sh -c ${quote(inner)} > ${log} 2>&1 < /dev/null &`,
      `echo $! > ${pid}`,
      "echo $!",
    ]
    const run = await this.runRemote(lines.join("\n"), { timeoutMs: MASTER_TIMEOUT_MS })
    this.assertOk(run, "start task")
    return { address: `${this.machine}/${id}` }
  }

  async readTask(address: string, o: TaskReadOptions = {}): Promise<string> {
    const id = this.parseAddress(address)
    const log = `${TASK_DIR_REMOTE}/${id}.log`
    const code = `${TASK_DIR_REMOTE}/${id}.code`
    const lines = Math.max(1, Math.floor(o.lines ?? 40))
    // A running task has no `.code` yet, so every step here is optional; the
    // trailing `:` keeps the whole probe at exit 0 (a missing code file is not
    // a failure — it just means "still running").
    const script = [
      `tail -n ${lines} ${log} 2>/dev/null`,
      `printf '\\n${EXIT_MARKER}'`,
      `cat ${code} 2>/dev/null`,
      ":",
    ].join("\n")
    const run = await this.runRemote(script, { timeoutMs: DEFAULT_TIMEOUT_MS })
    this.assertOk(run, `read task ${address}`)
    const at = run.stdout.lastIndexOf(EXIT_MARKER)
    const body = at < 0 ? run.stdout : run.stdout.slice(0, at)
    const rawCode = at < 0 ? "" : run.stdout.slice(at + EXIT_MARKER.length).trim()
    const parsed = Number.parseInt(rawCode, 10)
    const exitCode = Number.isInteger(parsed) ? parsed : null
    return formatTaskTail(tailLines(body.replace(/\n$/, ""), lines), exitCode)
  }

  async stopTask(address: string): Promise<void> {
    const id = this.parseAddress(address)
    const pid = `${TASK_DIR_REMOTE}/${id}.pid`
    const script = [
      `if [ -f ${pid} ]; then`,
      `  pid=$(cat ${pid})`,
      `  kill -TERM -"$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null`,
      `  echo stopped`,
      "else",
      `  echo "no task: ${id}"`,
      "fi",
    ].join("\n")
    const run = await this.runRemote(script, { timeoutMs: MASTER_TIMEOUT_MS })
    this.assertOk(run, `stop task ${address}`)
  }

  /** Establish the ControlMaster once; degrade to plain ssh if it fails. */
  async connect(): Promise<boolean> {
    if (this.masterState !== "unknown") return this.masterState === "ready"
    const args = [
      "-M",
      "-S",
      this.socketPath,
      "-N",
      "-f",
      "-o",
      `ControlPersist=${this.persist}`,
      "-o",
      "StrictHostKeyChecking=accept-new",
      this.host,
    ]
    const run = await runLocal(this.sshBinary, args, { timeoutMs: MASTER_TIMEOUT_MS })
    if (run.code === 0) {
      this.masterState = "ready"
      return true
    }
    this.masterState = "degraded"
    this.masterError = sanitizeStderr(run.stderr || run.stdout, this.host)
    return false
  }

  private async runRemote(script: string, opts: { input?: string; timeoutMs: number }): Promise<LocalRun> {
    await this.connect()
    const args =
      this.masterState === "ready"
        ? ["-S", this.socketPath, "-o", "StrictHostKeyChecking=accept-new", this.host, "--", script]
        : ["-o", "StrictHostKeyChecking=accept-new", this.host, "--", script]
    const run = await runLocal(this.sshBinary, args, opts)
    if (run.code === 255 && run.timedOut === false) {
      // 255 is ssh's own failure code, not the remote command's exit status.
      const detail = sanitizeStderr(run.stderr, this.host) || this.masterError || "connection failed"
      throw new Error(`machine unreachable: ${firstLine(detail)}`)
    }
    return run
  }

  private assertOk(run: LocalRun, what: string): void {
    if (run.timedOut) throw new Error(`command timed out after ${Math.round(run.ms / 1000)}s`)
    if (run.code === 0) return
    const detail = sanitizeStderr(run.stderr, this.host).trim() || run.stdout.trim()
    throw new Error(detail ? `${what} failed: ${detail}` : `${what} failed with exit ${run.code}`)
  }

  private parseAddress(address: string): string {
    const prefix = `${this.machine}/`
    if (!address.startsWith(prefix)) throw new Error(`task address must look like ${this.machine}/<id>`)
    const id = address.slice(prefix.length)
    if (!/^[a-zA-Z0-9._-]{1,80}$/.test(id)) throw new Error("invalid task address")
    return id
  }
}

function newTaskId(): string {
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

function firstLine(text: string): string {
  return text.split("\n").find((line) => line.trim().length > 0)?.trim() ?? text.trim()
}

/** Spawn a local process (in practice: ssh) and capture it under a timeout. */
function runLocal(
  program: string,
  args: string[],
  opts: { input?: string; timeoutMs: number },
): Promise<LocalRun> {
  const started = Date.now()
  return new Promise<LocalRun>((resolve) => {
    const child = spawn(program, args, {
      detached: true,
      stdio: [opts.input !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    let truncated = false
    let timedOut = false
    let exited = false
    let settled = false

    const cap = (current: string, chunk: Buffer): string => {
      if (current.length >= MAX_CAPTURE_CHARS) {
        truncated = true
        return current
      }
      const next = current + chunk.toString("utf8")
      if (next.length > MAX_CAPTURE_CHARS) {
        truncated = true
        return next.slice(0, MAX_CAPTURE_CHARS)
      }
      return next
    }

    const killTree = (signal: NodeJS.Signals) => {
      if (exited) return
      try {
        if (child.pid !== undefined) process.kill(-child.pid, signal)
      } catch {
        try {
          child.kill(signal)
        } catch {
          /* already gone */
        }
      }
    }

    const finish = (code: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout: stdout.trimEnd(), stderr: stderr.trimEnd(), ms: Date.now() - started, timedOut, truncated })
    }

    const timer = setTimeout(() => {
      timedOut = true
      killTree("SIGTERM")
      // Kill the local ssh; the remote side of a plain `exec` dies with the
      // channel for most programs. A task that must survive/cancel cleanly
      // goes through spawn/stopTask, which owns a pid file.
      setTimeout(() => killTree("SIGKILL"), 250)
    }, opts.timeoutMs)

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = cap(stdout, chunk)
    })
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = cap(stderr, chunk)
    })
    if (opts.input !== undefined && child.stdin) child.stdin.end(opts.input)
    child.on("error", (error) => {
      exited = true
      stderr = stderr || error.message
      finish(null)
    })
    child.on("close", (code) => {
      exited = true
      finish(code)
    })
  })
}
