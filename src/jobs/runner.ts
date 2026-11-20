import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { accessSync, constants as fsConstants, closeSync, existsSync, openSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import {
  countRunning,
  createJobPaths,
  isJobId,
  isProcessAlive,
  jobPaths,
  listJobs,
  readJob,
  readJobMeta,
  updateJobMeta,
  writeJobMeta,
} from "./store.ts"
import type { JobMeta, JobView } from "./store.ts"

export const DEFAULT_PI_BIN = "pi"

export const DEFAULT_PI_PROVIDER = "any-endpoint"
export const DEFAULT_MAX_WORKERS = 3

export const DEFAULT_JOB_TIMEOUT_MINUTES = 30

export const STOP_TIMEOUT_MS = 3_000
const STOP_POLL_MS = 50

export interface RunnerConfig {

  agentHome: string
  piBin?: string
  piProvider?: string
  maxWorkers?: number

  jobTimeoutMinutes?: number

  model: string

  thinking: string

  onExit?: (job: JobView) => void
}

export interface DelegateInput {
  task: string
  cwd?: string
  model?: string
  thinking?: string
}

export interface RunnerReply {
  ok: boolean
  output: string

  id?: string
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined
}

export class JobRunner {
  readonly agentHome: string
  readonly piBin: string
  readonly piProvider: string
  readonly maxWorkers: number

  readonly jobTimeoutMinutes: number

  onExit?: (job: JobView) => void
  private readonly model: string
  private readonly thinking: string

  constructor(config: RunnerConfig) {
    this.agentHome = config.agentHome
    this.piBin = nonEmpty(config.piBin) ?? DEFAULT_PI_BIN
    this.piProvider = nonEmpty(config.piProvider) ?? DEFAULT_PI_PROVIDER
    this.maxWorkers =
      config.maxWorkers !== undefined && Number.isFinite(config.maxWorkers) && config.maxWorkers > 0
        ? Math.floor(config.maxWorkers)
        : DEFAULT_MAX_WORKERS
    this.jobTimeoutMinutes =
      config.jobTimeoutMinutes !== undefined && Number.isFinite(config.jobTimeoutMinutes) && config.jobTimeoutMinutes >= 0
        ? Math.floor(config.jobTimeoutMinutes)
        : DEFAULT_JOB_TIMEOUT_MINUTES
    this.onExit = config.onExit
    this.model = config.model
    this.thinking = config.thinking
  }

  get jobTimeoutMs(): number {
    return this.jobTimeoutMinutes * 60_000
  }

  workerArgv(input: { id: string; task: string; model?: string; thinking?: string }, piDir: string): string[] {
    return [
      "-p",
      input.task,
      "--provider",
      this.piProvider,
      "--model",
      nonEmpty(input.model) ?? this.model,
      "--thinking",
      nonEmpty(input.thinking) ?? this.thinking,
      "--session-dir",
      piDir,
    ]
  }

  delegate(input: DelegateInput, fallbackCwd: string): RunnerReply {
    const task = nonEmpty(input.task)
    if (task === undefined) return { ok: false, output: "delegate requires a non-empty task" }

    const running = countRunning(this.agentHome)
    if (running >= this.maxWorkers) {
      return { ok: false, output: `${running} workers already running — poll them with job_status` }
    }

    const cwd = resolveCwd(input.cwd, fallbackCwd)
    if (cwd === undefined) return { ok: false, output: `delegate cwd does not exist: ${input.cwd ?? fallbackCwd}` }

    const binary = resolveBinary(this.piBin)
    if (binary === undefined) {
      return { ok: false, output: `pi binary not found or not executable: ${this.piBin} (check --pi-bin)` }
    }

    let paths: ReturnType<typeof createJobPaths>
    try {
      paths = createJobPaths(this.agentHome)
    } catch (error) {
      return { ok: false, output: `could not create a job directory: ${errorMessage(error)}` }
    }

    const startedAt = new Date().toISOString()
    const model = nonEmpty(input.model) ?? this.model
    const thinking = nonEmpty(input.thinking) ?? this.thinking
    const args = this.workerArgv({ id: paths.id, task, model, thinking }, paths.piDir)

    let child: ChildProcess
    let logFd: number
    try {

      logFd = openSync(paths.logPath, "a")
    } catch (error) {
      return { ok: false, output: `could not open ${paths.logPath}: ${errorMessage(error)}` }
    }
    try {
      child = spawn(binary, args, {
        cwd,
        detached: true,
        stdio: ["ignore", logFd, logFd],
      })
    } catch (error) {
      closeSync(logFd)
      return { ok: false, output: `failed to start ${this.piBin}: ${errorMessage(error)}` }
    }

    closeSync(logFd)

    const pid = child.pid ?? 0

    child.on("exit", (code, signal) => {
      this.finalize(paths.id, { code: code ?? null, signal: signal ?? null })
    })
    child.on("error", (error) => {
      appendNote(paths.logPath, `ctrl: failed to start ${this.piBin}: ${errorMessage(error)}`)
      this.finalize(paths.id, { code: 127, signal: null })
    })
    child.unref()

    const meta: JobMeta = {
      id: paths.id,
      task,
      cwd,
      model,
      thinking,
      startedAt,
      pid,
    }
    try {
      writeJobMeta(this.agentHome, meta)
    } catch (error) {
      return { ok: false, output: `started pid ${pid} but could not write meta.json: ${errorMessage(error)}` }
    }

    return { ok: true, output: `started job ${paths.id} — poll with job_status`, id: paths.id }
  }

  async stop(id: string): Promise<RunnerReply> {
    if (!isJobId(id)) return { ok: false, output: `invalid job id: ${id}` }
    const job = readJob(this.agentHome, id)
    if (job === undefined) return { ok: false, output: `no such job: ${id}` }
    if (job.state !== "running") return { ok: false, output: `job ${id} is not running (${job.state})` }

    signalGroup(job.pid, "SIGTERM")
    const deadline = Date.now() + STOP_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (!isProcessAlive(job.pid)) {

        this.finalize(id, { code: null, signal: "SIGTERM" })
        return { ok: true, output: `stopped ${id}` }
      }
      await sleep(STOP_POLL_MS)
    }
    signalGroup(job.pid, "SIGKILL")
    const hardDeadline = Date.now() + 2_000
    while (Date.now() < hardDeadline) {
      if (!isProcessAlive(job.pid)) {
        this.finalize(id, { code: null, signal: "SIGKILL" })
        return { ok: true, output: `stopped ${id} (SIGKILL)` }
      }
      await sleep(STOP_POLL_MS)
    }
    return { ok: false, output: `job ${id} did not stop within ${Math.round(STOP_TIMEOUT_MS / 1000)}s (pid ${job.pid})` }
  }

  private finalize(id: string, exit: { code: number | null; signal: string | null }): void {
    const meta = readJobMeta(this.agentHome, id)
    if (meta === undefined) return
    if (typeof meta.exitedAt === "string" && meta.exitedAt !== "") return
    updateJobMeta(this.agentHome, id, {
      exitedAt: new Date().toISOString(),
      code: exit.code,
      signal: exit.signal,
    })

    const job = readJob(this.agentHome, id)
    if (job !== undefined) this.emitExit(job)
  }

  private emitExit(job: JobView): void {
    const callback = this.onExit
    if (callback === undefined) return
    try {
      const returned: unknown = callback(job)
      if (returned !== null && typeof returned === "object" && "catch" in returned) {
        void (returned as Promise<unknown>).catch((error: unknown) => warnExit(error))
      }
    } catch (error) {
      warnExit(error)
    }
  }

  async sweepTimeouts(now: number = Date.now()): Promise<string[]> {
    const limitMs = this.jobTimeoutMs
    if (limitMs <= 0) return []
    const stopped: string[] = []
    for (const job of listJobs(this.agentHome, { limit: 0, now })) {

      if (job.state !== "running") continue
      if (job.elapsedMs <= limitMs) continue
      const logPath = jobPaths(this.agentHome, job.id).logPath
      appendNote(logPath, `ctrl: job exceeded ${this.jobTimeoutMinutes}m — stopped`)
      const reply = await this.stop(job.id)
      if (reply.ok) stopped.push(job.id)
    }
    return stopped
  }
}

function resolveBinary(requested: string): string | undefined {
  if (requested.includes(path.sep)) return isExecutableFile(requested) ? requested : undefined
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir === "") continue
    const candidate = path.join(dir, requested)
    if (isExecutableFile(candidate)) return candidate
  }
  return undefined
}

function isExecutableFile(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false
    accessSync(file, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

function resolveCwd(requested: string | undefined, fallback: string): string | undefined {
  const raw = nonEmpty(requested) ?? nonEmpty(fallback)
  if (raw === undefined) return undefined
  const resolved = path.resolve(fallback, raw)
  try {
    return statSync(resolved).isDirectory() ? resolved : undefined
  } catch {
    return undefined
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  if (!Number.isInteger(pid) || pid <= 0) return
  try {
    process.kill(-pid, signal)
    return
  } catch {

  }
  try {
    process.kill(pid, signal)
  } catch {

  }
}

function appendNote(logFile: string, note: string): void {
  if (!existsSync(logFile)) return
  try {
    writeFileSync(logFile, `${note}\n`, { encoding: "utf8", flag: "a" })
  } catch {

  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function warnExit(error: unknown): void {
  process.stderr.write(`ctrl: job exit listener failed: ${errorMessage(error)}\n`)
}
