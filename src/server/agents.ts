import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { createSession, openSession, resolvePaths } from "../engine/durable.ts"
import type { Session } from "../engine/durable.ts"

export const LOG_ID = "main"

export const DEFAULT_AGENT = "main"
export const AGENT_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/
export const AGENT_FILENAME = "agent.json"

export interface AgentMeta {
  name: string
  model: string
  createdAt: string
}

export interface AgentSummary {
  name: string
  model: string
  createdAt: string
  events: number
  lastActivity: string
}

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

export function resolveRoot(root?: string, env: NodeJS.ProcessEnv = process.env): string {
  const explicit = root?.trim()
  if (explicit !== undefined && explicit !== "") return expandHome(explicit)
  const fromEnv = env.CTRL_ROOT?.trim()
  if (fromEnv !== undefined && fromEnv !== "") return expandHome(fromEnv)
  return join(homedir(), ".ctrl")
}

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

export function openAgentLog(home: string): Session {
  return openSession(LOG_ID, { home })
}

export function createAgentLog(home: string, opts: { cwd: string; model: string }): Session {
  return createSession({ sessionId: LOG_ID, home, cwd: opts.cwd, model: opts.model })
}

export function hasAgentLog(home: string): boolean {
  return existsSync(logPath(home))
}

export function logPath(home: string): string {
  return resolvePaths(home).eventsFile(LOG_ID)
}

export interface EnsureAgentOptions {
  root: string
  name: string

  cwd: string

  model: string
}

export interface EnsuredAgent {
  name: string
  home: string
  meta: AgentMeta
  session: Session

  created: boolean
}

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

  now?: Date
}

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

  purge?: boolean
  now?: Date
}

export interface RemovedAgent {
  name: string
  from: string

  to?: string
  purged: boolean
}

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

  }
  return {
    name,
    model: meta?.model ?? "",
    createdAt: meta?.createdAt ?? lastActivity,
    events,
    lastActivity,
  }
}

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

function expandHome(value: string): string {
  if (value === "~") return homedir()
  if (value.startsWith("~/")) return join(homedir(), value.slice(2))
  return value
}

function uniquePath(dir: string, base: string): string {
  let candidate = join(dir, base)
  for (let suffix = 2; existsSync(candidate); suffix += 1) candidate = join(dir, `${base}-${suffix}`)
  return candidate
}
