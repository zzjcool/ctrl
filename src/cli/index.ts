#!/usr/bin/env node

import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { createChatCompletionsClient } from "../engine/durable.ts"
import { runDream } from "../memory/dream.ts"
import { createMemoryIndex } from "../memory/index.ts"
import { DEFAULT_CONTEXT_BUDGET } from "../memory/window.ts"
import {
  DEFAULT_AGENT,
  AgentError,
  agentHome,
  ensureAgent,
  isAgentName,
  listAgents,
  logPath,
  newAgent,
  openAgentLog,
  removeAgent,
  resolveRoot,
} from "../server/agents.ts"
import {
  DEFAULT_HEARTBEAT_IDLE_MINUTES,
  DEFAULT_HEARTBEAT_MAX_PER_DAY,
  DEFAULT_HEARTBEAT_TOKEN_BUDGET,
} from "../server/heartbeat.ts"
import type { Heartbeat } from "../server/heartbeat.ts"
import {
  DEFAULT_HOST,
  DEFAULT_MAX_STEPS,
  DEFAULT_MODEL,
  DEFAULT_PORT,
  DEFAULT_REASONING_EFFORT,
  DEFAULT_SWEEP_INTERVAL_MS,
  startServer,
} from "../server/server.ts"
import { DEFAULT_JOB_TIMEOUT_MINUTES, DEFAULT_MAX_WORKERS, DEFAULT_PI_BIN, DEFAULT_PI_PROVIDER } from "../jobs/runner.ts"

export type Mode = "serve" | "agent-list" | "agent-new" | "agent-rm" | "dream" | "help" | "version"

interface Flags {
  mode: Mode

  name?: string
  port: number
  host: string
  workspace?: string
  root?: string
  agent: string

  piBin: string

  piProvider: string

  maxWorkers: number

  jobTimeoutMinutes: number
  maxSteps: number

  contextBudget?: number

  heartbeatMinutes: number

  heartbeatBudget: number

  heartbeatMax: number

  model?: string
  reasoningEffort?: string

  json: boolean

  purge: boolean
}

const AGENT_SUBCOMMANDS = ["list", "new", "rm"] as const

const USAGE = `ctrl — one named agent, one log, one workspace.

Usage:
  ctrl [serve] [options]
  ctrl agent list [--root <dir>] [--json]
  ctrl agent new <name> [--model <id>] [--root <dir>] [--json]
  ctrl agent rm <name> [--root <dir>] [--purge]
  ctrl dream [--agent <name>] [--root <dir>] [--json]

Serve options:
  --agent <name>     the agent to serve (default ${DEFAULT_AGENT}); its directory
                     is created on first start
  --root <dir>       where agents live (default $CTRL_ROOT or ~/.ctrl)
  --workspace <dir>  directory the agent works in (default: current directory)
  --pi-bin <path>    the pi binary a worker is spawned as (default ${DEFAULT_PI_BIN})
  --pi-provider <p>  provider a worker passes to pi (default ${DEFAULT_PI_PROVIDER})
  --max-workers <n>  how many workers may run at once (default ${DEFAULT_MAX_WORKERS})
  --job-timeout <m>  kill a worker that has run longer than m minutes, and report it
                     (default ${DEFAULT_JOB_TIMEOUT_MINUTES}; 0 = no limit)
  --max-steps <n>    tool-loop budget per turn (default ${DEFAULT_MAX_STEPS})
  --context-budget <n>
                     characters of transcript the model sees before the oldest
                     half is compressed into a summary (default ${DEFAULT_CONTEXT_BUDGET})
  --heartbeat <m>    wake on its own after m idle minutes to look at focus and
                     pending proposals (default ${DEFAULT_HEARTBEAT_IDLE_MINUTES}; 0 = off)
  --heartbeat-budget <tokens>
                     tokens a day the heartbeat may spend before it goes quiet
                     (default ${DEFAULT_HEARTBEAT_TOKEN_BUDGET})
  --heartbeat-max <n>
                     heartbeats per day at most (default ${DEFAULT_HEARTBEAT_MAX_PER_DAY}; 0 = off)
  --model <id>       model for a brand-new log (default workbuddy/deepseek-v4.1-flash,
                     or $PI_DURABLE_MODEL); afterwards the log decides
  --reasoning-effort <level>
                     thinking budget: off|low|medium|high|max
                     (default ${DEFAULT_REASONING_EFFORT})
  --port <n>         port to listen on (default ${DEFAULT_PORT})
  --host <addr>      address to bind (default ${DEFAULT_HOST})
  --help             show this message
  --version          show the version

Dream:
  ctrl dream         run one consolidation pass now (MEMORY.md §7): read the new
                     events, write memories/focus, rewrite profile.md if needed

Agent commands:
  list               every agent under <root>/agents
  new <name>         create <root>/agents/<name>/ and its empty log
  rm <name>          move the directory to <root>/trash/<name>-<stamp>/
                     (--purge deletes it for real)
`

export class UsageError extends Error {}

export function parseArgs(argv: string[]): Flags {
  const flags: Flags = {
    mode: "serve",
    port: DEFAULT_PORT,
    host: DEFAULT_HOST,
    agent: DEFAULT_AGENT,
    piBin: DEFAULT_PI_BIN,
    piProvider: DEFAULT_PI_PROVIDER,
    maxWorkers: DEFAULT_MAX_WORKERS,
    jobTimeoutMinutes: DEFAULT_JOB_TIMEOUT_MINUTES,
    maxSteps: DEFAULT_MAX_STEPS,
    heartbeatMinutes: DEFAULT_HEARTBEAT_IDLE_MINUTES,
    heartbeatBudget: DEFAULT_HEARTBEAT_TOKEN_BUDGET,
    heartbeatMax: DEFAULT_HEARTBEAT_MAX_PER_DAY,
    json: false,
    purge: false,
  }
  const rest = [...argv]

  const first = rest[0]
  if (first === "agent") {
    rest.shift()
    const sub = rest.shift()
    if (sub === undefined) {
      throw new UsageError(`agent needs a subcommand: ${AGENT_SUBCOMMANDS.join(", ")}`)
    }
    if (!(AGENT_SUBCOMMANDS as readonly string[]).includes(sub)) {
      throw new UsageError(`unknown agent subcommand: ${sub}`)
    }
    flags.mode = `agent-${sub}` as Mode
  } else if (first === "dream") {
    rest.shift()
    flags.mode = "dream"
  } else if (first !== undefined && !first.startsWith("-")) {

    if (first !== "serve") throw new UsageError(`unknown command: ${first}`)
    rest.shift()
  }

  const positional: string[] = []
  for (let index = 0; index < rest.length; index += 1) {
    const raw = rest[index] ?? ""
    if (!raw.startsWith("-")) {
      positional.push(raw)
      continue
    }
    const [name, inline] = raw.includes("=") ? [raw.slice(0, raw.indexOf("=")), raw.slice(raw.indexOf("=") + 1)] : [raw, undefined]
    const value = (): string => {
      if (inline !== undefined) return inline
      const next = rest[index + 1]
      if (next === undefined || next.startsWith("-")) throw new UsageError(`${name} requires a value`)
      index += 1
      return next
    }
    switch (name) {
      case "--help":
      case "-h":
        flags.mode = "help"
        return flags
      case "--version":
      case "-v":
        flags.mode = "version"
        return flags
      case "--port":
        flags.port = integer(value(), "--port", 0, 65_535)
        break
      case "--host":
        flags.host = value()
        break
      case "--workspace":
        flags.workspace = value()
        break
      case "--root":
        flags.root = value()
        break
      case "--agent":
        flags.agent = agentNameFlag("--agent", value())
        break
      case "--pi-bin":
        flags.piBin = word(value(), "--pi-bin")
        break
      case "--pi-provider":

        flags.piProvider = inline !== undefined ? inline.trim() : value().trim()
        break
      case "--max-workers":
        flags.maxWorkers = integer(value(), "--max-workers", 1, 64)
        break
      case "--job-timeout":

        flags.jobTimeoutMinutes = integer(value(), "--job-timeout", 0, 10_080)
        break
      case "--max-steps":
        flags.maxSteps = integer(value(), "--max-steps", 1, 200)
        break
      case "--context-budget":
        flags.contextBudget = integer(value(), "--context-budget", 1_000, 1_000_000)
        break
      case "--heartbeat":
        flags.heartbeatMinutes = integer(value(), "--heartbeat", 0, 10_080)
        break
      case "--heartbeat-budget":
        flags.heartbeatBudget = integer(value(), "--heartbeat-budget", 0, 100_000_000)
        break
      case "--heartbeat-max":
        flags.heartbeatMax = integer(value(), "--heartbeat-max", 0, 96)
        break
      case "--model":
        flags.model = word(value(), "--model")
        break
      case "--reasoning-effort":
        flags.reasoningEffort = effort(value())
        break
      case "--json":
        noValue(name, inline)
        flags.json = true
        break
      case "--purge":
        noValue(name, inline)
        flags.purge = true
        break
      default:
        throw new UsageError(`unknown option: ${raw}`)
    }
  }

  if (flags.mode === "agent-list" || flags.mode === "agent-new" || flags.mode === "agent-rm") {
    if (positional.length > 1) throw new UsageError(`unexpected argument: ${positional[1]}`)
    const name = positional[0]
    if (flags.mode !== "agent-list") {
      if (name === undefined) throw new UsageError(`ctrl agent ${flags.mode.slice("agent-".length)} needs a name`)
      flags.name = name
    } else if (name !== undefined) {
      throw new UsageError(`agent list takes no arguments (got "${name}")`)
    }
    if (flags.json && flags.mode === "agent-rm") throw new UsageError("--json is not a thing for agent rm")
    if (flags.purge && flags.mode !== "agent-rm") throw new UsageError("--purge is only for agent rm")
  } else {
    if (positional.length > 0) throw new UsageError(`unexpected argument: ${positional[0]}`)
    if (flags.purge) throw new UsageError("--purge is only for agent rm")
  }
  return flags
}

function agentNameFlag(label: string, raw: string): string {
  const trimmed = word(raw, label)
  if (!isAgentName(trimmed)) {
    throw new UsageError(`${label} must match ${/^[a-z0-9][a-z0-9_-]{0,31}$/.source}, got "${raw}"`)
  }
  return trimmed
}

function word(raw: string, label: string): string {
  const trimmed = raw.trim()
  if (trimmed === "") throw new UsageError(`${label} must not be empty`)
  return trimmed
}

function noValue(label: string, inline: string | undefined): void {
  if (inline !== undefined) throw new UsageError(`${label} takes no value`)
}

const EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const

function effort(raw: string): string {
  const level = raw.trim().toLowerCase()
  if (!(EFFORTS as readonly string[]).includes(level)) {
    throw new UsageError(`--reasoning-effort must be one of ${EFFORTS.join(", ")}, got "${raw}"`)
  }
  return level
}

function integer(raw: string, label: string, min: number, max: number): number {
  if (!/^\d+$/.test(raw)) throw new UsageError(`${label} must be a number, got "${raw}"`)
  const value = Number.parseInt(raw, 10)
  if (value < min || value > max) throw new UsageError(`${label} must be between ${min} and ${max}`)
  return value
}

export function version(): string {
  try {
    const file = fileURLToPath(new URL("../../package.json", import.meta.url))
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { version?: unknown }
    return typeof parsed.version === "string" ? parsed.version : "unknown"
  } catch {
    return "unknown"
  }
}

async function main(argv: string[]): Promise<number> {
  let flags: Flags
  try {
    flags = parseArgs(argv)
  } catch (error) {
    process.stderr.write(`ctrl: ${errorMessage(error)}\n\n${USAGE}`)
    return 2
  }

  switch (flags.mode) {
    case "help":
      process.stdout.write(USAGE)
      return 0
    case "version":
      process.stdout.write(`${version()}\n`)
      return 0
    case "agent-list":
      return listCommand(flags)
    case "agent-new":
      return newCommand(flags)
    case "agent-rm":
      return removeCommand(flags)
    case "dream":
      return await dreamCommand(flags)
    case "serve":
      return serveCommand(flags)
  }
}

function rootOf(flags: Flags): string {

  return resolveRoot(flags.root)
}

function listCommand(flags: Flags): number {
  const root = rootOf(flags)
  const agents = listAgents(root)
  if (flags.json) {
    process.stdout.write(`${JSON.stringify({ root, agents }, null, 2)}\n`)
    return 0
  }
  if (agents.length === 0) {
    process.stdout.write(`no agents in ${root}/agents\n`)
    return 0
  }
  const width = Math.max(...agents.map((agent) => agent.name.length))
  for (const agent of agents) {
    process.stdout.write(
      `${agent.name.padEnd(width)}  ${agent.createdAt}  ${String(agent.events).padStart(4)} events  last ${agent.lastActivity}\n`,
    )
  }
  return 0
}

function newCommand(flags: Flags): number {
  const name = flags.name ?? ""
  try {
    const root = rootOf(flags)
    const created = newAgent({
      root,
      name,
      cwd: defaultWorkspace(flags),
      model: resolveModel(flags),
    })
    if (flags.json) {
      process.stdout.write(
        `${JSON.stringify({ name: created.name, home: created.home, model: created.meta.model, createdAt: created.meta.createdAt }, null, 2)}\n`,
      )
      return 0
    }
    process.stdout.write(
      `created agent ${created.name}\n` +
        `  directory: ${created.home}\n` +
        `  model: ${created.meta.model}\n` +
        `  log: ${logPath(created.home)}\n` +
        `start it with: ctrl --agent ${created.name}${flags.root !== undefined ? ` --root ${flags.root}` : ""}\n`,
    )
    return 0
  } catch (error) {
    return report(error)
  }
}

function removeCommand(flags: Flags): number {
  const name = flags.name ?? ""
  try {
    const root = rootOf(flags)
    const removed = removeAgent({ root, name, purge: flags.purge })
    process.stdout.write(
      removed.purged
        ? `purged agent ${removed.name} (${removed.from})\n`
        : `archived agent ${removed.name}\n  ${removed.from}\n  → ${removed.to}\n`,
    )
    return 0
  } catch (error) {
    return report(error)
  }
}

function resolveModel(flags: Flags): string {
  return flags.model?.trim() || process.env.PI_DURABLE_MODEL?.trim() || DEFAULT_MODEL
}

function defaultWorkspace(flags: Flags): string {
  return flags.workspace ?? process.cwd()
}

function report(error: unknown): number {
  process.stderr.write(`ctrl: ${errorMessage(error)}\n`)
  if (error instanceof AgentError) return error.kind === "invalid-name" ? 2 : 1
  return 1
}

async function dreamCommand(flags: Flags): Promise<number> {
  let ensured
  try {
    const root = rootOf(flags)
    ensured = ensureAgent({
      root,
      name: flags.agent,
      cwd: flags.workspace ?? process.cwd(),
      model: resolveModel(flags),
    })
  } catch (error) {
    return report(error)
  }

  const memory = createMemoryIndex({ agentHome: ensured.home, eventsFile: logPath(ensured.home) })
  try {
    const db = memory.handle()
    if (db === undefined) {
      process.stderr.write(`ctrl: memory database unavailable: ${memory.error ?? "not open"}\n`)
      return 1
    }

    memory.importEvents()

    const log = openAgentLog(ensured.home)
    const model = log.meta().model !== "" ? log.meta().model : resolveModel(flags)
    const llm = {
      complete: async (request: Parameters<ReturnType<typeof createChatCompletionsClient>["complete"]>[0]) => {
        const client = createChatCompletionsClient({
          model,
          env: process.env,
          ...(flags.reasoningEffort !== undefined ? { reasoningEffort: flags.reasoningEffort } : {}),
        })
        return await client.complete(request)
      },
    }

    const result = await runDream({ db, agentHome: ensured.home, events: log.events(), llm })
    if (flags.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    } else if (result.error !== undefined) {
      process.stderr.write(`ctrl: dream failed: ${result.error}\n`)
    } else if (result.skipped === true) {
      process.stdout.write(`nothing new since seq ${result.fromSeq} — no dream needed\n`)
    } else {
      process.stdout.write(
        `dream ${result.id}\n` +
          `  events: ${result.batchEvents} (seq ${result.fromSeq}..${result.toSeq})\n` +
          `  memories: +${result.added} added, ${result.merged} merged, ${result.superseded} superseded\n` +
          `  focus: ${result.focus} item(s) updated\n` +
          `  profile: ${result.profileRewritten ? "rewritten (old version in profile.history/)" : "unchanged"}\n`,
      )
    }
    return result.error === undefined ? 0 : 1
  } finally {
    memory.close()
  }
}

async function serveCommand(flags: Flags): Promise<number> {
  let root: string
  try {
    root = rootOf(flags)

    agentHome(root, flags.agent)
  } catch (error) {
    return report(error)
  }

  const workspace = flags.workspace ?? process.cwd()

  let running
  try {
    running = await startServer({
      root,
      agent: flags.agent,
      port: flags.port,
      host: flags.host,
      workspace,
      piBin: flags.piBin,
      piProvider: flags.piProvider,
      maxWorkers: flags.maxWorkers,
      jobTimeoutMinutes: flags.jobTimeoutMinutes,
      maxSteps: flags.maxSteps,
      heartbeatIdleMinutes: flags.heartbeatMinutes,
      heartbeatBudget: flags.heartbeatBudget,
      heartbeatMaxPerDay: flags.heartbeatMax,
      ...(flags.contextBudget !== undefined ? { contextBudget: flags.contextBudget } : {}),
      ...(flags.model !== undefined ? { model: flags.model } : {}),
      ...(flags.reasoningEffort !== undefined ? { reasoningEffort: flags.reasoningEffort } : {}),
    })
  } catch (error) {
    if (error instanceof AgentError) return report(error)
    if (isPortInUse(error)) {
      process.stderr.write(
        `ctrl: port ${flags.port} is already in use — another ctrl is probably running (try --port ${flags.port + 1})\n`,
      )
      return 1
    }
    process.stderr.write(`ctrl: failed to start: ${errorMessage(error)}\n`)
    return 1
  }

  const summary = listAgents(root).find((agent) => agent.name === running.ctx.agent)
  const model = running.ctx.defaultModel
  process.stdout.write(
    `ctrl ${version()} listening on ${running.url}\n` +
      `  agent: ${running.ctx.agent} (log ${summary?.events ?? 0} events)\n` +
      `  workspace: ${workspace}\n` +
      `  model: ${model}\n` +
      `  pi bin: ${running.ctx.jobs.piBin} (provider ${running.ctx.jobs.piProvider || "default"})\n` +
      `  max workers: ${running.ctx.jobs.maxWorkers}\n` +
      `  job timeout: ${running.ctx.jobTimeoutMinutes > 0 ? `${running.ctx.jobTimeoutMinutes}m (swept every ${Math.round(DEFAULT_SWEEP_INTERVAL_MS / 1000)}s)` : "none"}\n` +
      `  context budget: ${running.ctx.contextBudget} chars\n` +
      `  heartbeat: ${heartbeatLine(running.ctx.heartbeat)}\n` +
      `  directory: ${running.ctx.agentHome}\n`,
  )

  const shutdown = (signal: string) => {
    process.stdout.write(`\nctrl: ${signal} — closing\n`)
    void running.close().then(() => process.exit(0))
  }
  process.once("SIGINT", () => shutdown("SIGINT"))
  process.once("SIGTERM", () => shutdown("SIGTERM"))

  await new Promise<void>((resolve) => running.server.once("close", resolve))
  return 0
}

function heartbeatLine(heartbeat: Heartbeat): string {
  if (heartbeat.idleMinutes <= 0 || heartbeat.maxPerDay <= 0) return "off"
  return `after ${heartbeat.idleMinutes}m idle, max ${heartbeat.maxPerDay}/day, ${heartbeat.dailyTokenBudget} tokens/day`
}

function isPortInUse(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "EADDRINUSE"
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const entry = process.argv[1]
if (entry !== undefined && fileURLToPath(import.meta.url) === entry) {
  const code = await main(process.argv.slice(2))
  process.exitCode = code
}
