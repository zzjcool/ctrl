// An agent is a directory (CONTRACT §4, PLAN §3.1).
//
//   <root>/agents/<name>/agent.json          { name, model, createdAt }
//   <root>/agents/<name>/memory/index.jsonl  pi-durable memory — per agent, so a
//                                            new name starts blank
//   <root>/agents/<name>/sessions/main/*     the single log; the id is always "main"
//   <root>/trash/<name>-<stamp>/             `ctrl agent rm` archives here
//
// Nothing here knows about HTTP or machines: this file is the on-disk truth
// about names, directories, and the one log each directory holds. `agentHome`
// *is* pi-durable's `home`, which is why `resolvePaths(home)` puts memory and
// `sessions/main/` exactly where CONTRACT §4 says they go.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { createSession, openSession, resolvePaths } from "../engine/durable.ts"
import type { Session } from "../engine/durable.ts"

/** The one log an agent has. Not a session id the user ever types. */
export const LOG_ID = "main"
/** `--agent` defaults to this, so `ctrl` alone is a working agent. */
export const DEFAULT_AGENT = "main"
export const AGENT_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/
export const AGENT_FILENAME = "agent.json"

export interface AgentMeta {
  name: string
  model: string
  createdAt: string
}

/** What `ctrl agent list` shows: the directory's facts, cheap enough to scan. */
export interface AgentSummary {
  name: string
  model: string
  createdAt: string
  events: number
  lastActivity: string
}

/**
 * A name or path problem the CLI turns into an exit code:
 * `invalid-name` → 2, `exists` / `not-found` → 1.
 */
export class AgentError extends Error {
  readonly kind: "invalid-name" | "exists" | "not-found"
  constructor(kind: "invalid-name" | "exists" | "not-found", message: string) {
    super(message)
    this.name = "AgentError"
    this.kind = kind
  }
}

export function isAgentName(value: unknown): value is string {
  return typeof value === "string" && AGENT_NAME_PATTERN.test(value)
}

/**
 * `--root` > `CTRL_ROOT` > `~/.ctrl`.
 *
 * Kept separate from `resolvePaths()` on purpose: pi-durable's home is one
 * *agent* directory, this root holds every agent plus the trash.
 */
export function resolveRoot(root?: string, env: NodeJS.ProcessEnv = process.env): string {
  const explicit = root?.trim()
  if (explicit !== undefined && explicit !== "") return expandHome(explicit)
  const fromEnv = env.CTRL_ROOT?.trim()
  if (fromEnv !== undefined && fromEnv !== "") return expandHome(fromEnv)
  return join(homedir(), ".ctrl")
}

/** `<root>/agents/<name>`; the name is validated so this can never escape. */
export function agentHome(root: string, name: string): string {
  if (!isAgentName(name)) {
    throw new AgentError(
      "invalid-name",
      `invalid agent name: "${name}" (must match ${AGENT_NAME_PATTERN.source})`,
    )
  }
  return join(root, "agents", name)
}

export function agentFilePath(home: string): string {
  return join(home, AGENT_FILENAME)
}

/** Undefined for a missing, unreadable or malformed `agent.json` — never throws. */
export function readAgentMeta(home: string): AgentMeta | undefined {
  let raw: string
  try {
    raw = readFileSync(agentFilePath(home), "utf8")
  } catch {
    return undefined
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== "object" || parsed === null) return undefined
    const candidate = parsed as Partial<AgentMeta>
    if (typeof candidate.name !== "string" || candidate.name === "") return undefined
    return {
      name: candidate.name,
      model: typeof candidate.model === "string" ? candidate.model : "",
      createdAt:
        typeof candidate.createdAt === "string" && candidate.createdAt !== ""
          ? candidate.createdAt
          : new Date(0).toISOString(),
    }
  } catch {
    return undefined
  }
}

export function writeAgentMeta(home: string, meta: AgentMeta): AgentMeta {
  const record: AgentMeta = { name: meta.name, model: meta.model, createdAt: meta.createdAt }
  mkdirSync(home, { recursive: true })
  writeFileSync(agentFilePath(home), `${JSON.stringify(record, null, 2)}\n`, "utf8")
  return record
}

/** Open the agent's single log. Throws `Session not found: main` when it is gone. */
export function openAgentLog(home: string): Session {
  return openSession(LOG_ID, { home })
}

/** Create the log with the model baked into `session_created` (PLAN §5). */
export function createAgentLog(home: string, opts: { cwd: string; model: string }): Session {
  return createSession({ sessionId: LOG_ID, home, cwd: opts.cwd, model: opts.model })
}

export function hasAgentLog(home: string): boolean {
  return existsSync(logPath(home))
}

/** `<agentHome>/sessions/main/events.jsonl` — the one file that is the agent. */
export function logPath(home: string): string {
  return resolvePaths(home).eventsFile(LOG_ID)
}

export interface EnsureAgentOptions {
  root: string
  name: string
  /** Working directory the log starts in (remote when the machine kind is ssh). */
  cwd: string
  /** Only used when the log is being created; afterwards `session_created` wins. */
  model: string
}

export interface EnsuredAgent {
  name: string
  home: string
  meta: AgentMeta
  session: Session
  /** True only when this call created the directory. */
  created: boolean
}

/**
 * Serve-time entry point: an existing directory is opened as is, a missing one
 * is created (CONTRACT §4: a new name = a new directory = a blank agent).
 *
 * Self-healing is deliberate — a directory whose log went missing gets a fresh
 * `session_created` instead of a process that refuses to start.
 */
export function ensureAgent(opts: EnsureAgentOptions): EnsuredAgent {
  const home = agentHome(opts.root, opts.name)
  const existing = readAgentMeta(home)
  const meta = existing ?? writeAgentMeta(home, { name: opts.name, model: opts.model, createdAt: new Date().toISOString() })
  const session = hasAgentLog(home)
    ? openAgentLog(home)
    : createAgentLog(home, { cwd: opts.cwd, model: meta.model !== "" ? meta.model : opts.model })
  return { name: opts.name, home, meta, session, created: existing === undefined }
}

export interface NewAgentOptions extends EnsureAgentOptions {
  /** Refuse to overwrite an existing name (`ctrl agent new`). */
  now?: Date
}

/** `ctrl agent new`: create, but never touch an existing name. */
export function newAgent(opts: NewAgentOptions): EnsuredAgent {
  const home = agentHome(opts.root, opts.name)
  if (existsSync(home)) {
    throw new AgentError("exists", `agent "${opts.name}" already exists at ${home} (ctrl agent rm ${opts.name} to start over)`)
  }
  const meta = writeAgentMeta(home, { name: opts.name, model: opts.model, createdAt: (opts.now ?? new Date()).toISOString() })
  const session = createAgentLog(home, { cwd: opts.cwd, model: meta.model })
  return { name: opts.name, home, meta, session, created: true }
}

export interface RemoveAgentOptions {
  root: string
  name: string
  /** Delete for real instead of moving the directory to `trash/`. */
  purge?: boolean
  now?: Date
}

export interface RemovedAgent {
  name: string
  from: string
  /** Where the directory went; absent when `--purge` deleted it. */
  to?: string
  purged: boolean
}

/**
 * `ctrl agent rm` (CONTRACT §4, D9): archive by `renameSync` into `trash/`.
 * Deleting a directory is the only destructive verb in the product, so the
 * default is reversible and `--purge` is the one that is not.
 */
export function removeAgent(opts: RemoveAgentOptions): RemovedAgent {
  const from = agentHome(opts.root, opts.name)
  if (!existsSync(from)) {
    throw new AgentError("not-found", `agent "${opts.name}" not found at ${from}`)
  }
  if (opts.purge === true) {
    rmSync(from, { recursive: true, force: true })
    return { name: opts.name, from, purged: true }
  }
  const trash = join(opts.root, "trash")
  mkdirSync(trash, { recursive: true })
  const to = uniquePath(trash, `${opts.name}-${trashStamp(opts.now ?? new Date())}`)
  renameSync(from, to)
  return { name: opts.name, from, to, purged: false }
}

/** `YYYYMMDDHHMMSS`, local time — the suffix on an archived directory. */
export function trashStamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0")
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("")
}

/** One directory's facts, or undefined when it is not there. */
export function agentSummary(root: string, name: string): AgentSummary | undefined {
  if (!isAgentName(name)) return undefined
  const home = join(root, "agents", name)
  if (!existsSync(home)) return undefined
  const meta = readAgentMeta(home)
  let events = 0
  let lastActivity = meta?.createdAt ?? ""
  try {
    const log = openAgentLog(home).events()
    events = log.length
    lastActivity = log.at(-1)?.ts ?? lastActivity
  } catch {
    // A directory without a log is still an agent; it just has nothing to show.
  }
  return {
    name,
    model: meta?.model ?? "",
    createdAt: meta?.createdAt ?? lastActivity,
    events,
    lastActivity,
  }
}

/** Every agent under `<root>/agents`, oldest first (creation order reads best). */
export function listAgents(root: string): AgentSummary[] {
  const dir = join(root, "agents")
  let names: string[]
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isAgentName(entry.name))
      .map((entry) => entry.name)
  } catch {
    return []
  }
  return names
    .map((name) => agentSummary(root, name))
    .filter((summary): summary is AgentSummary => summary !== undefined)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.name.localeCompare(b.name))
}

/** `~/x` is a shell habit; the flag parser does not run a shell for anyone. */
function expandHome(value: string): string {
  if (value === "~") return homedir()
  if (value.startsWith("~/")) return join(homedir(), value.slice(2))
  return value
}

/** `<dir>/<base>`, then `<dir>/<base>-2`, `-3`, … so nothing is ever clobbered. */
function uniquePath(dir: string, base: string): string {
  let candidate = join(dir, base)
  for (let suffix = 2; existsSync(candidate); suffix += 1) candidate = join(dir, `${base}-${suffix}`)
  return candidate
}
