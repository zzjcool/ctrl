import { randomBytes } from "node:crypto"
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"

export const JOBS_DIRNAME = "jobs"
export const META_FILENAME = "meta.json"
export const LOG_FILENAME = "out.log"
export const PI_DIRNAME = "pi"

export const JOB_ID_PATTERN = /^\d{8}T\d{6}Z-[a-z0-9]{6}$/

export const MAX_OUTPUT_CHARS = 20_000

export const DEFAULT_TAIL_LINES = 40

export const DEFAULT_LIST_LIMIT = 20

export const DEFAULT_STATUS_LIST = 10

export type JobState = "running" | "exited" | "failed" | "killed" | "lost"

export interface JobMeta {
  id: string
  task: string
  cwd: string
  model: string
  thinking: string
  startedAt: string
  pid: number
  exitedAt?: string
  code?: number | null
  signal?: string | null

  notifiedAt?: string
}

export interface JobView extends JobMeta {
  state: JobState
  elapsedMs: number
}

export interface JobPaths {
  id: string
  dir: string
  metaPath: string
  logPath: string
  piDir: string
}

export function jobsDir(agentHome: string): string {
  return path.join(agentHome, JOBS_DIRNAME)
}

export function isJobId(value: unknown): value is string {
  return typeof value === "string" && JOB_ID_PATTERN.test(value)
}

export function jobTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0")
  return [
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
    "T",
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds()),
    "Z",
  ].join("")
}

export function jobSuffix(): string {
  return randomBytes(4).toString("hex").slice(0, 6)
}

export function newJobId(now: Date = new Date(), suffix: string = jobSuffix()): string {
  return `${jobTimestamp(now)}-${suffix}`
}

export function jobPaths(agentHome: string, id: string): JobPaths {
  if (!isJobId(id)) throw new Error(`invalid job id: ${id}`)
  const dir = path.join(jobsDir(agentHome), id)
  return {
    id,
    dir,
    metaPath: path.join(dir, META_FILENAME),
    logPath: path.join(dir, LOG_FILENAME),
    piDir: path.join(dir, PI_DIRNAME),
  }
}

export function createJobPaths(agentHome: string, now: Date = new Date()): JobPaths {
  mkdirSync(jobsDir(agentHome), { recursive: true })
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const id = newJobId(now)
    const paths = jobPaths(agentHome, id)
    mkdirSync(paths.dir, { recursive: false })
    mkdirSync(paths.piDir, { recursive: true })
    return paths
  }
  throw new Error("could not allocate a job id (8 collisions in one second?)")
}

export function writeJobMeta(agentHome: string, meta: JobMeta): JobMeta {
  const paths = jobPaths(agentHome, meta.id)
  mkdirSync(paths.dir, { recursive: true })
  const record: JobMeta = {
    id: meta.id,
    task: meta.task,
    cwd: meta.cwd,
    model: meta.model,
    thinking: meta.thinking,
    startedAt: meta.startedAt,
    pid: meta.pid,
  }
  if (typeof meta.exitedAt === "string" && meta.exitedAt !== "") record.exitedAt = meta.exitedAt
  if (meta.code !== undefined) record.code = meta.code
  if (meta.signal !== undefined) record.signal = meta.signal
  if (typeof meta.notifiedAt === "string" && meta.notifiedAt !== "") record.notifiedAt = meta.notifiedAt

  const tmp = `${paths.metaPath}.tmp`
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, "utf8")
  renameSync(tmp, paths.metaPath)
  return record
}

export function readJobMeta(agentHome: string, id: string): JobMeta | undefined {
  if (!isJobId(id)) return undefined
  let raw: string
  try {
    raw = readFileSync(jobPaths(agentHome, id).metaPath, "utf8")
  } catch {
    return undefined
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== "object" || parsed === null) return undefined
    const candidate = parsed as Partial<JobMeta>
    if (typeof candidate.startedAt !== "string" || candidate.startedAt === "") return undefined
    const meta: JobMeta = {
      id,
      task: typeof candidate.task === "string" ? candidate.task : "",
      cwd: typeof candidate.cwd === "string" ? candidate.cwd : "",
      model: typeof candidate.model === "string" ? candidate.model : "",
      thinking: typeof candidate.thinking === "string" ? candidate.thinking : "",
      startedAt: candidate.startedAt,
      pid: typeof candidate.pid === "number" && Number.isInteger(candidate.pid) ? candidate.pid : 0,
    }
    if (typeof candidate.exitedAt === "string" && candidate.exitedAt !== "") meta.exitedAt = candidate.exitedAt
    if (typeof candidate.code === "number" || candidate.code === null) meta.code = candidate.code
    if (typeof candidate.signal === "string" || candidate.signal === null) meta.signal = candidate.signal
    if (typeof candidate.notifiedAt === "string" && candidate.notifiedAt !== "") meta.notifiedAt = candidate.notifiedAt
    return meta
  } catch {
    return undefined
  }
}

export function updateJobMeta(agentHome: string, id: string, patch: Partial<Omit<JobMeta, "id">>): JobMeta | undefined {
  const meta = readJobMeta(agentHome, id)
  if (meta === undefined) return undefined
  return writeJobMeta(agentHome, { ...meta, ...patch })
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

export function deriveState(meta: JobMeta): JobState {
  const finished = typeof meta.exitedAt === "string" && meta.exitedAt !== ""
  if (finished) {
    if (typeof meta.signal === "string" && meta.signal !== "") return "killed"
    if (meta.code === 0) return "exited"

    return "failed"
  }

  return isProcessAlive(meta.pid) ? "running" : "lost"
}

export function elapsedMs(meta: JobMeta, now: number = Date.now()): number {
  const started = Date.parse(meta.startedAt)
  if (!Number.isFinite(started)) return 0
  const end = typeof meta.exitedAt === "string" && meta.exitedAt !== "" ? Date.parse(meta.exitedAt) : now
  const span = (Number.isFinite(end) ? end : now) - started
  return span > 0 ? span : 0
}

export async function waitForJob(
  agentHome: string,
  id: string,
  waitMs: number,
): Promise<JobView | undefined> {
  const deadline = Date.now() + Math.max(0, waitMs)
  let job = readJob(agentHome, id)
  while (job !== undefined && job.state === "running" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    job = readJob(agentHome, id)
  }
  return job
}

export function readJob(agentHome: string, id: string, now: number = Date.now()): JobView | undefined {
  const meta = readJobMeta(agentHome, id)
  if (meta === undefined) return undefined
  return { ...meta, state: deriveState(meta), elapsedMs: elapsedMs(meta, now) }
}

export function listJobIds(agentHome: string): string[] {
  let names: string[]
  try {
    names = readdirSync(jobsDir(agentHome), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isJobId(entry.name))
      .map((entry) => entry.name)
  } catch {
    return []
  }
  return names.sort().reverse()
}

export function listJobs(
  agentHome: string,
  opts: { limit?: number; now?: number } = {},
): JobView[] {
  const now = opts.now ?? Date.now()
  const limit = opts.limit !== undefined && Number.isFinite(opts.limit) ? Math.floor(opts.limit) : DEFAULT_LIST_LIMIT
  const jobs = listJobIds(agentHome)
    .map((id) => readJob(agentHome, id, now))
    .filter((job): job is JobView => job !== undefined)
  jobs.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id))
  return limit > 0 ? jobs.slice(0, limit) : jobs
}

export function countRunning(agentHome: string, now: number = Date.now()): number {
  return listJobs(agentHome, { limit: 0, now }).filter((job) => job.state === "running").length
}

export interface JobLog {
  text: string

  truncated: boolean
}

export function readJobLog(
  agentHome: string,
  id: string,
  opts: { lines?: number; full?: boolean } = {},
): JobLog {
  if (!isJobId(id)) return { text: "", truncated: false }
  let raw: string
  try {
    raw = readFileSync(jobPaths(agentHome, id).logPath, "utf8")
  } catch {
    return { text: "", truncated: false }
  }
  if (opts.full === true) {
    if (raw.length <= MAX_OUTPUT_CHARS) return { text: raw, truncated: false }

    return { text: raw.slice(raw.length - MAX_OUTPUT_CHARS), truncated: true }
  }
  const lines = opts.lines !== undefined && Number.isFinite(opts.lines) ? Math.floor(opts.lines) : DEFAULT_TAIL_LINES
  return { text: tailLines(raw, lines), truncated: false }
}

export function tailLines(text: string, lines: number): string {
  if (!Number.isFinite(lines) || lines <= 0) return text
  const all = text.split("\n")
  if (all.length > 0 && all[all.length - 1] === "") all.pop()
  return all.slice(Math.max(0, all.length - Math.floor(lines))).join("\n")
}
