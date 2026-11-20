// The Executor seam (CONTRACT §4, frozen). Both backends — local and ssh —
// implement exactly this; the tools never know which one they got.

export interface ExecOptions {
  cwd?: string
  env?: Record<string, string>
  /** Written to the child's stdin, then stdin is closed. */
  input?: string
  timeoutMs?: number
}

export interface ReadOptions {
  cwd?: string
  /** 1-based line to start at. */
  offset?: number
  limit?: number
}

export interface WriteOptions {
  cwd?: string
}

export interface ListOptions {
  cwd?: string
}

export interface SpawnOptions {
  cwd?: string
  env?: Record<string, string>
  name?: string
}

export interface TaskReadOptions {
  lines?: number
}

export interface ExecResult {
  code: number | null
  stdout: string
  stderr: string
  ms: number
  timedOut: boolean
  truncated: boolean
}

export interface Executor {
  readonly kind: "local" | "ssh"
  /** Shown on every tool card; never part of a tool signature. */
  readonly machine: string
  exec(argv: string[], o?: ExecOptions): Promise<ExecResult>
  /** 1-based lines. */
  read(path: string, o?: ReadOptions): Promise<string>
  write(path: string, data: string, o?: WriteOptions): Promise<void>
  list(path: string, o?: ListOptions): Promise<string[]>
  spawn(argv: string[], o?: SpawnOptions): Promise<{ address: string }>
  readTask(address: string, o?: TaskReadOptions): Promise<string>
  stopTask(address: string): Promise<void>
}

/** Big outputs are cut here, with the `truncated` flag set; the engine caps again. */
export const MAX_CAPTURE_CHARS = 200_000

/** Format the tail of a finished task consistently for both backends. */
export function formatTaskTail(log: string, exitCode: number | null): string {
  const body = log.length > 0 && !log.endsWith("\n") ? `${log}\n` : log
  return exitCode === null ? body : `${body}[exit ${exitCode}]`
}

/** Reject a NUL byte instead of mangling a binary payload (CONTRACT §4). */
export function assertText(payload: string, label: string): string {
  if (payload.includes("\u0000")) throw new Error(`cannot read binary file: ${label}`)
  return payload
}

/** Slice a text body by 1-based lines. Absent offset = whole file. */
export function sliceLines(text: string, offset?: number, limit?: number): string {
  if (offset === undefined && limit === undefined) return text
  const lines = text.split("\n")
  // A trailing newline produces a final empty element that is not a line.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
  const start = Math.max(1, Math.floor(offset ?? 1)) - 1
  const end = limit === undefined ? lines.length : start + Math.max(0, Math.floor(limit))
  return lines.slice(start, end).join("\n")
}

/** Keep the last `lines` lines of a task log; the tail is what you poll for. */
export function tailLines(text: string, lines: number): string {
  if (!Number.isFinite(lines) || lines <= 0) return text
  const all = text.split("\n")
  if (all.length > 0 && all[all.length - 1] === "") all.pop()
  return all.slice(Math.max(0, all.length - Math.floor(lines))).join("\n")
}
