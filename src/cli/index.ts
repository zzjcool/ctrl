#!/usr/bin/env node
// ctrl — one process, one named agent, one log, one machine.
//
//   node --experimental-strip-types src/cli/index.ts --agent builder --machine hw-nj
//   node --experimental-strip-types src/cli/index.ts agent new builder --model workbuddy/deepseek-v4.1-flash
//   node --experimental-strip-types src/cli/index.ts agent list
//
// There is no `--home` and no session id anywhere: an agent is a directory
// under `--root`, and that directory is the whole of its state.

import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import {
  DEFAULT_AGENT,
  AgentError,
  agentHome,
  isAgentName,
  listAgents,
  logPath,
  newAgent,
  removeAgent,
  resolveRoot,
} from "../server/agents.ts"
import {
  DEFAULT_HOST,
  DEFAULT_MAX_STEPS,
  DEFAULT_MODEL,
  DEFAULT_PORT,
  DEFAULT_REASONING_EFFORT,
  readSshHosts,
  startServer,
} from "../server/server.ts"

export type Mode = "serve" | "agent-list" | "agent-new" | "agent-rm" | "help" | "version"

interface Flags {
  mode: Mode
  /** The name an `agent` subcommand acts on. */
  name?: string
  port: number
  host: string
  workspace?: string
  root?: string
  agent: string
  machine: string
  allowBash: boolean
  maxSteps: number
  /** Undefined means "let the server resolve": PI_DURABLE_MODEL, then the default. */
  model?: string
  reasoningEffort?: string
  /** `agent list` / `agent new` output as JSON. */
  json: boolean
  /** `agent rm`: delete instead of archiving. */
  purge: boolean
}

const AGENT_SUBCOMMANDS = ["list", "new", "rm"] as const

const USAGE = `ctrl — one named agent, one log, one machine.

Usage:
  ctrl [serve] [options]
  ctrl agent list [--root <dir>] [--json]
  ctrl agent new <name> [--model <id>] [--root <dir>] [--json]
  ctrl agent rm <name> [--root <dir>] [--purge]

Serve options:
  --agent <name>     the agent to serve (default ${DEFAULT_AGENT}); its directory
                     is created on first start
  --root <dir>       where agents live (default $CTRL_ROOT or ~/.ctrl)
  --machine <name>   local only for now (remote machines are parked)
  --workspace <dir>  working directory for the agent's hands
                     (default: current directory for --machine local, ~ for ssh)
  --allow-bash       advertise the bash tool to the model (hidden otherwise)
  --max-steps <n>    tool-loop budget per turn (default ${DEFAULT_MAX_STEPS})
  --model <id>       model for a brand-new log (default workbuddy/deepseek-v4.1-flash,
                     or $PI_DURABLE_MODEL); afterwards the log decides
  --reasoning-effort <level>
                     thinking budget: off|low|medium|high|max
                     (default ${DEFAULT_REASONING_EFFORT})
  --port <n>         port to listen on (default ${DEFAULT_PORT})
  --host <addr>      address to bind (default ${DEFAULT_HOST})
  --help             show this message
  --version          show the version

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
    machine: "local",
    allowBash: false,
    maxSteps: DEFAULT_MAX_STEPS,
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
  } else if (first !== undefined && !first.startsWith("-")) {
    // An optional `serve` subcommand, so `ctrl` and `ctrl serve` both work.
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
      case "--machine": {
        // The ssh executor exists in the tree, but remote machines are parked:
        // one local agent is the whole v1. Reopening this is a two-line change.
        const machine = word(value(), "--machine")
        if (machine !== "local") {
          throw new UsageError(`remote machines are parked for now: v1 is local-only (got "${machine}")`)
        }
        flags.machine = machine
        break
      }
      case "--max-steps":
        flags.maxSteps = integer(value(), "--max-steps", 1, 200)
        break
      case "--model":
        flags.model = word(value(), "--model")
        break
      case "--reasoning-effort":
        flags.reasoningEffort = effort(value())
        break
      case "--allow-bash":
        noValue(name, inline)
        flags.allowBash = true
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

/** `--agent` is validated here so a typo is exit 2, not a directory named `Foo`. */
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
    case "serve":
      return serveCommand(flags)
  }
}

// ---------------------------------------------------------------------------
// ctrl agent …
// ---------------------------------------------------------------------------

function rootOf(flags: Flags): string {
  // Nothing is created here: `agent list` on a fresh machine must not mkdir.
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

/** --model > PI_DURABLE_MODEL > DEFAULT_MODEL (CONTRACT §6). */
function resolveModel(flags: Flags): string {
  return flags.model?.trim() || process.env.PI_DURABLE_MODEL?.trim() || DEFAULT_MODEL
}

/** Where `agent new` puts the log: current directory locally, ~ on an ssh host. */
function defaultWorkspace(flags: Flags): string {
  return flags.workspace ?? (flags.machine === "local" ? process.cwd() : "~")
}

function report(error: unknown): number {
  process.stderr.write(`ctrl: ${errorMessage(error)}\n`)
  if (error instanceof AgentError) return error.kind === "invalid-name" ? 2 : 1
  return 1
}

// ---------------------------------------------------------------------------
// ctrl [serve]
// ---------------------------------------------------------------------------

async function serveCommand(flags: Flags): Promise<number> {
  let root: string
  try {
    root = rootOf(flags)
    // Fail before binding a port if the name could not be a directory.
    agentHome(root, flags.agent)
  } catch (error) {
    return report(error)
  }

  const isLocal = flags.machine === "local"
  const workspace = flags.workspace ?? (isLocal ? process.cwd() : "~")
  if (!isLocal && !readSshHosts().includes(flags.machine)) {
    // Not fatal: a plain host name that resolves is a legitimate machine too.
    // No probing either — the first real tool call is the probe (PLAN §4).
    process.stderr.write(
      `ctrl: "${flags.machine}" is not a Host in ~/.ssh/config; using it anyway\n`,
    )
  }

  let running
  try {
    running = await startServer({
      root,
      agent: flags.agent,
      port: flags.port,
      host: flags.host,
      machine: flags.machine,
      workspace,
      allowBash: flags.allowBash,
      maxSteps: flags.maxSteps,
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
      `  agent: ${running.ctx.agent} (log ${summary?.events ?? 0} events) / machine: ${running.ctx.machine.name} / model: ${model}\n` +
      `  directory: ${running.ctx.agentHome}\n` +
      `  workspace: ${workspace}\n` +
      `  bash: ${flags.allowBash ? "advertised" : "hidden (--allow-bash to enable)"}\n`,
  )

  const shutdown = (signal: string) => {
    process.stdout.write(`\nctrl: ${signal} — closing\n`)
    void running.close().then(() => process.exit(0))
  }
  process.once("SIGINT", () => shutdown("SIGINT"))
  process.once("SIGTERM", () => shutdown("SIGTERM"))
  // Keep the process alive until a signal or a fatal error closes the server.
  await new Promise<void>((resolve) => running.server.once("close", resolve))
  return 0
}

function isPortInUse(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "EADDRINUSE"
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Are we being run as an entry point (as opposed to imported by a test)? */
const entry = process.argv[1]
if (entry !== undefined && fileURLToPath(import.meta.url) === entry) {
  const code = await main(process.argv.slice(2))
  process.exitCode = code
}
