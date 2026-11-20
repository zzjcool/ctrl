// LocalExecutor: the same seam, but the hands are on the control machine.
//
// Two things to know:
//   * every child is spawned `detached` so a timeout can kill the whole
//     process group — otherwise `sh -c "sleep 30"` leaves `sleep` orphaned and
//     the tool only *looks* bounded.
//   * long tasks live in an in-memory table. The log/pid/code files survive a
//     restart (they are plain files under the temp dir) but ctrl forgets which
//     pid it started, so a task started before a restart can no longer be
//     stopped from here. Local tasks are for short-lived polls; the durable
//     place for a long build is a real machine, i.e. the ssh backend.

import { spawn } from "node:child_process"
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs"
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { constants as osConstants, homedir, tmpdir } from "node:os"
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

const DEFAULT_TIMEOUT_MS = 60_000
const KILL_GRACE_MS = 250

/** Shared by every LocalExecutor in this process; the files outlive it. */
const TASK_DIR = path.join(tmpdir(), "ctrl-tasks")

interface LocalTask {
  id: string
  logFile: string
  codeFile: string
  child: ReturnType<typeof spawn>
  exitCode: number | null
}

export interface LocalExecutorOptions {
  machine?: string
}

export class LocalExecutor implements Executor {
  readonly kind = "local" as const
  readonly machine: string
  private readonly tasks = new Map<string, LocalTask>()
  private readonly defaultCwd: string | undefined

  constructor(opts: LocalExecutorOptions & { cwd?: string } = {}) {
    this.machine = opts.machine ?? "local"
    this.defaultCwd = opts.cwd
  }

  async exec(argv: string[], o: ExecOptions = {}): Promise<ExecResult> {
    if (argv.length === 0) throw new Error("exec requires at least one argv element")
    const [program, ...rest] = argv as [string, ...string[]]
    const cwd = o.cwd ?? this.defaultCwd
    const timeoutMs = o.timeoutMs !== undefined && o.timeoutMs > 0 ? o.timeoutMs : DEFAULT_TIMEOUT_MS
    const started = Date.now()

    return await new Promise<ExecResult>((resolve) => {
      const child = spawn(program, rest, {
        ...(cwd !== undefined ? { cwd } : {}),
        ...(o.env !== undefined ? { env: { ...process.env, ...o.env } } : {}),
        detached: true,
        stdio: [o.input !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
      })

      let stdout = ""
      let stderr = ""
      let truncated = false
      let timedOut = false
      let exited = false
      let settled = false
      let hardKill: ReturnType<typeof setTimeout> | undefined

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

      const finish = (code: number | null, extraStderr = "") => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (hardKill !== undefined) clearTimeout(hardKill)
        const text = extraStderr && stderr.length === 0 ? extraStderr : stderr
        resolve({
          code,
          stdout: stdout.trimEnd(),
          stderr: text.trimEnd(),
          truncated,
          ms: Date.now() - started,
          timedOut,
        })
      }

      const timer = setTimeout(() => {
        timedOut = true
        killTree("SIGTERM")
        hardKill = setTimeout(() => killTree("SIGKILL"), KILL_GRACE_MS)
      }, timeoutMs)

      child.stdout?.on("data", (chunk: Buffer) => {
        stdout = cap(stdout, chunk)
      })
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = cap(stderr, chunk)
      })
      if (o.input !== undefined && child.stdin) {
        child.stdin.end(o.input)
      }
      child.on("error", (error) => {
        exited = true
        finish(null, error.message)
      })
      child.on("close", (code) => {
        exited = true
        finish(code)
      })
    })
  }

  async read(target: string, o: ReadOptions = {}): Promise<string> {
    const resolved = this.resolve(target, o.cwd)
    const payload = await readFile(resolved, "utf8")
    assertText(payload, target)
    return sliceLines(payload, o.offset, o.limit)
  }

  async write(target: string, data: string, o: WriteOptions = {}): Promise<void> {
    const resolved = this.resolve(target, o.cwd)
    await mkdir(path.dirname(resolved), { recursive: true })
    await writeFile(resolved, data, "utf8")
  }

  async list(target: string, o: ListOptions = {}): Promise<string[]> {
    const resolved = this.resolve(target, o.cwd)
    const entries = await readdir(resolved, { withFileTypes: true })
    return entries
      // Par with `ls -1Ap`: hidden names kept, `.`/`..` dropped, dirs marked.
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
  }

  async spawn(argv: string[], o: SpawnOptions = {}): Promise<{ address: string }> {
    if (argv.length === 0) throw new Error("spawn requires at least one argv element")
    const [program, ...rest] = argv as [string, ...string[]]
    const id = newTaskId()
    mkdirSync(TASK_DIR, { recursive: true })
    const logFile = path.join(TASK_DIR, `${id}.log`)
    const codeFile = path.join(TASK_DIR, `${id}.code`)
    const pidFile = path.join(TASK_DIR, `${id}.pid`)
    const logFd = openSync(logFile, "w")
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(program, rest, {
        ...(o.cwd !== undefined ? { cwd: o.cwd } : this.defaultCwd !== undefined ? { cwd: this.defaultCwd } : {}),
        ...(o.env !== undefined ? { env: { ...process.env, ...o.env } } : {}),
        detached: true,
        stdio: ["ignore", logFd, logFd],
      })
    } finally {
      closeSync(logFd)
    }
    if (child.pid !== undefined) writeFileSync(pidFile, `${child.pid}\n`)

    const task: LocalTask = { id, logFile, codeFile, child, exitCode: null }
    this.tasks.set(id, task)
    child.on("error", () => {
      task.exitCode = 1
      writeFileSync(codeFile, "1\n")
    })
    child.on("exit", (code, signal) => {
      const resolved = code ?? signalExitCode(signal)
      task.exitCode = resolved
      writeFileSync(codeFile, `${resolved}\n`)
    })
    return { address: `${this.machine}/${id}` }
  }

  async readTask(address: string, o: TaskReadOptions = {}): Promise<string> {
    const id = this.parseAddress(address)
    const logFile = path.join(TASK_DIR, `${id}.log`)
    const codeFile = path.join(TASK_DIR, `${id}.code`)
    let log: string
    try {
      log = await readFile(logFile, "utf8")
    } catch {
      throw new Error(`no such task: ${address}`)
    }
    const exitCode = this.exitCodeFor(id, codeFile)
    return formatTaskTail(tailLines(log, o.lines ?? 40).trimEnd(), exitCode)
  }

  async stopTask(address: string): Promise<void> {
    const id = this.parseAddress(address)
    const task = this.tasks.get(id)
    if (!task) {
      // The files are still there, but nothing in this process owns the pid.
      // Never signal a pid we did not start: it may belong to something else.
      throw new Error(`task is not tracked by this ctrl process: ${address}`)
    }
    if (task.exitCode !== null) return
    try {
      if (task.child.pid !== undefined) process.kill(-task.child.pid, "SIGTERM")
    } catch {
      try {
        task.child.kill("SIGTERM")
      } catch {
        /* already gone */
      }
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          if (task.child.pid !== undefined) process.kill(-task.child.pid, "SIGKILL")
        } catch {
          /* already gone */
        }
        resolve()
      }, KILL_GRACE_MS)
      task.child.once("exit", () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  private exitCodeFor(id: string, codeFile: string): number | null {
    const task = this.tasks.get(id)
    if (task && task.exitCode !== null) return task.exitCode
    try {
      const raw = readFileSync(codeFile, "utf8").trim()
      const parsed = Number.parseInt(raw, 10)
      return Number.isInteger(parsed) ? parsed : null
    } catch {
      return null
    }
  }

  private parseAddress(address: string): string {
    const prefix = `${this.machine}/`
    if (!address.startsWith(prefix)) throw new Error(`task address must look like ${this.machine}/<id>`)
    const id = address.slice(prefix.length)
    if (!/^[a-zA-Z0-9._-]{1,80}$/.test(id)) throw new Error("invalid task address")
    return id
  }

  private resolve(target: string, cwd?: string): string {
    const expanded = expandHome(target)
    return path.resolve(cwd ?? this.defaultCwd ?? process.cwd(), expanded)
  }
}

/** `~` is the local user's home here, matching the remote semantics. */
export function expandHome(target: string): string {
  if (target === "~") return homedir()
  if (target.startsWith("~/")) return path.join(homedir(), target.slice(2))
  return target
}

function newTaskId(): string {
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

function signalExitCode(signal: NodeJS.Signals | null): number {
  if (!signal) return 1
  const number = (osConstants.signals as Record<string, number | undefined>)[signal]
  return number === undefined ? 1 : 128 + number
}
