#!/usr/bin/env node
// ctrl [serve] — one process, one conversation log, one machine.
//
//   node --experimental-strip-types src/cli/index.ts --machine hw-nj --workspace /srv/proj
//
// Flags are deliberately few: everything else is the page's business.

import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { DEFAULT_HOST, DEFAULT_MAX_STEPS, DEFAULT_PORT, readSshHosts, startServer } from "../server/server.ts"

interface Flags {
  mode: "serve" | "help" | "version"
  port: number
  host: string
  workspace?: string
  home?: string
  machine: string
  allowBash: boolean
  maxSteps: number
}

const USAGE = `ctrl — the conversation stays here, the hands work there.

Usage:
  ctrl [serve] [options]

Options:
  --port <n>         port to listen on (default ${DEFAULT_PORT})
  --host <addr>      address to bind (default ${DEFAULT_HOST})
  --workspace <dir>  working directory for new sessions
                     (default: current directory for --machine local, ~ for ssh)
  --home <dir>       pi-durable home (default ~/.pi-durable)
  --machine <name>   "local" or an ssh Host alias from ~/.ssh/config (default local)
  --allow-bash       advertise the bash tool to the model (hidden otherwise)
  --max-steps <n>    tool-loop budget per turn (default ${DEFAULT_MAX_STEPS})
  --help             show this message
  --version          show the version
`

export class UsageError extends Error {}

export function parseArgs(argv: string[]): Flags {
  const flags: Flags = {
    mode: "serve",
    port: DEFAULT_PORT,
    host: DEFAULT_HOST,
    machine: "local",
    allowBash: false,
    maxSteps: DEFAULT_MAX_STEPS,
  }
  const rest = [...argv]
  // An optional `serve` subcommand, so `ctrl` and `ctrl serve` both work.
  const first = rest[0]
  if (first !== undefined && !first.startsWith("-")) {
    if (first !== "serve") throw new UsageError(`unknown command: ${first}`)
    rest.shift()
  }

  for (let index = 0; index < rest.length; index += 1) {
    const raw = rest[index] ?? ""
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
      case "--home":
        flags.home = value()
        break
      case "--machine":
        flags.machine = value()
        break
      case "--max-steps":
        flags.maxSteps = integer(value(), "--max-steps", 1, 200)
        break
      case "--allow-bash":
        if (inline !== undefined) throw new UsageError("--allow-bash takes no value")
        flags.allowBash = true
        break
      default:
        throw new UsageError(`unknown option: ${raw}`)
    }
  }
  return flags
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

  if (flags.mode === "help") {
    process.stdout.write(USAGE)
    return 0
  }
  if (flags.mode === "version") {
    process.stdout.write(`${version()}\n`)
    return 0
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
      ...(flags.home !== undefined ? { home: flags.home } : {}),
      port: flags.port,
      host: flags.host,
      machine: flags.machine,
      workspace,
      allowBash: flags.allowBash,
      maxSteps: flags.maxSteps,
    })
  } catch (error) {
    if (isPortInUse(error)) {
      process.stderr.write(
        `ctrl: port ${flags.port} is already in use — another ctrl is probably running (try --port ${flags.port + 1})\n`,
      )
      return 1
    }
    process.stderr.write(`ctrl: failed to start: ${errorMessage(error)}\n`)
    return 1
  }

  process.stdout.write(
    `ctrl ${version()} listening on ${running.url}\n` +
      `  machine: ${flags.machine}${isLocal ? " (local)" : " (ssh)"}\n` +
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
