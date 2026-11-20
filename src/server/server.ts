// node:http assembly: API routes plus the one page (CONTRACT §9).
//
// No framework, no middleware, no dependency. The process holds one named
// agent — one log, one memory, one machine binding — and that is the whole
// surface. There is nothing to switch to, so nothing here takes an id.

import { readFileSync } from "node:fs"
import { createServer } from "node:http"
import type { IncomingMessage, Server, ServerResponse } from "node:http"
import { homedir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createChatCompletionsClient } from "../engine/durable.ts"
import type { LlmClient } from "../engine/durable.ts"
import { LocalExecutor } from "../exec/local.ts"
import { SshExecutor } from "../exec/ssh.ts"
import { createTools } from "../tools/index.ts"
import { DEFAULT_AGENT, LOG_ID, ensureAgent, resolveRoot } from "./agents.ts"
import { sendJson, serveStatic } from "./http.ts"
import { handleApiRequest, type AppContext, type MachineKind } from "./routes.ts"
import { readSidecar, writeSidecar } from "./sidecar.ts"
import { TurnRegistry } from "./turns.ts"

export const DEFAULT_PORT = 7333
export const DEFAULT_HOST = "127.0.0.1"
export const DEFAULT_MAX_STEPS = 12
/**
 * The model ctrl starts sessions with. pi-durable's own default (hy4) is a
 * reasoning model that costs seconds on trivial turns; deepseek-flash with a
 * max thinking budget is the daily driver here.
 */
export const DEFAULT_MODEL = "workbuddy/deepseek-v4.1-flash"
export const DEFAULT_REASONING_EFFORT = "max"
/** Reasoning tokens are billed inside `max_tokens`; 2048 truncates tool calls. */
export const DEFAULT_MAX_TOKENS = 8192

export interface ServerConfig {
  /** `<root>`: holds `agents/` and `trash/`. Defaults to CTRL_ROOT, then ~/.ctrl. */
  root?: string
  /** The agent to serve; its directory is created when missing. Defaults to `main`. */
  agent?: string
  port?: number
  host?: string
  /** `local` or an ssh host alias from ~/.ssh/config. */
  machine?: string
  /** Working directory the agent's hands start in (remote when kind is ssh). */
  workspace?: string
  allowBash?: boolean
  maxSteps?: number
  /** Model id for a new log; falls back to PI_DURABLE_MODEL, then DEFAULT_MODEL. */
  model?: string
  /** Sent as reasoning_effort; falls back to PI_DURABLE_REASONING_EFFORT, then "max". */
  reasoningEffort?: string
  /** Completion cap per model call. */
  maxTokens?: number
  publicDir?: string
  env?: NodeJS.ProcessEnv
  /** Injected by tests; by default a real chat/completions client. */
  createLlm?: (model: string) => LlmClient
}

export interface RunningServer {
  server: Server
  ctx: AppContext
  url: string
  port: number
  close(): Promise<void>
}

export function buildContext(config: ServerConfig = {}): AppContext {
  const env = config.env ?? process.env
  const machineName = config.machine && config.machine.trim() !== "" ? config.machine.trim() : "local"
  const kind: MachineKind = machineName === "local" ? "local" : "ssh"
  const workspace = config.workspace ?? (kind === "local" ? process.cwd() : "~")
  const executor =
    kind === "local"
      ? new LocalExecutor({ machine: "local", cwd: workspace })
      : new SshExecutor({ host: machineName, cwd: workspace })
  const model = config.model?.trim() || env.PI_DURABLE_MODEL || DEFAULT_MODEL
  const reasoningEffort =
    config.reasoningEffort?.trim() || env.PI_DURABLE_REASONING_EFFORT || DEFAULT_REASONING_EFFORT
  const maxTokens =
    Number.isFinite(config.maxTokens) && (config.maxTokens ?? 0) > 0
      ? Math.floor(config.maxTokens as number)
      : DEFAULT_MAX_TOKENS
  const allowBash = config.allowBash === true
  const maxSteps = Number.isFinite(config.maxSteps) && (config.maxSteps ?? 0) > 0
    ? Math.floor(config.maxSteps as number)
    : DEFAULT_MAX_STEPS

  // One agent, resolved before anything else: `agents/<name>/` either exists
  // (we open its log) or is created with agent.json and an empty log.
  const root = resolveRoot(config.root, env)
  const requestedAgent = config.agent?.trim()
  const agentName = requestedAgent !== undefined && requestedAgent !== "" ? requestedAgent : DEFAULT_AGENT
  const ensured = ensureAgent({ root, name: agentName, cwd: workspace, model })
  // The machine binding lives next to the log, never inside it (CONTRACT §3).
  // Restarting on another machine is a supported edit; switching mid-run is not.
  writeSidecar(ensured.home, LOG_ID, {
    machine: machineName,
    remoteCwd: workspace,
    createdAt: readSidecar(ensured.home, LOG_ID)?.createdAt ?? ensured.meta.createdAt,
  })

  return {
    root,
    agent: agentName,
    agentHome: ensured.home,
    machine: { name: machineName, kind },
    executor,
    workspace,
    allowBash,
    maxSteps,
    // The log is the truth once it exists (PLAN §5); buildContext only picks
    // the model for a log that is being created right now.
    defaultModel: ensured.session.meta().model || model,
    turns: new TurnRegistry(),
    tools: createTools(executor, { allowBash }),
    env,
    createLlm:
      config.createLlm ??
      ((requested: string) =>
        createChatCompletionsClient({ model: requested || model, env, reasoningEffort, maxTokens })),
    machines: ["local", ...readSshHosts()],
  }
}

export function defaultPublicDir(): string {
  return fileURLToPath(new URL("../web/public", import.meta.url))
}

/** Build the http.Server without binding a port. */
export function createAppServer(config: ServerConfig = {}): { server: Server; ctx: AppContext } {
  const ctx = buildContext(config)
  const publicDir = config.publicDir ?? defaultPublicDir()
  const server = createServer((request, response) => {
    void handleRequest(request, response, ctx, publicDir)
  })
  return { server, ctx }
}

export async function startServer(config: ServerConfig = {}): Promise<RunningServer> {
  const { server, ctx } = createAppServer(config)
  const host = config.host ?? DEFAULT_HOST
  const requestedPort = config.port ?? DEFAULT_PORT
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    server.once("error", onError)
    server.listen(requestedPort, host, () => {
      server.removeListener("error", onError)
      resolve()
    })
  })
  const address = server.address()
  const port = typeof address === "object" && address !== null ? address.port : requestedPort
  return {
    server,
    ctx,
    port,
    url: `http://${host}:${port}`,
    close: async () => {
      await ctx.turns.shutdown()
      await new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
    },
  }
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  ctx: AppContext,
  publicDir: string,
): Promise<void> {
  try {
    if (await handleApiRequest(request, response, ctx)) return
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname
    // The page belongs to W2; until it exists a missing file is a plain 404,
    // not a crash and not an index listing.
    await serveStatic(request, response, pathname, publicDir)
  } catch (error) {
    if (!response.headersSent) sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
    else if (!response.writableEnded) response.end()
  }
}

/**
 * `Host` entries from ~/.ssh/config, in file order.
 *
 * Only the top-level file is read: `Include` targets are skipped on purpose
 * (the machine you want is nearly always declared where you can see it), and
 * wildcards are not machines.
 */
export function readSshHosts(configPath = path.join(homedir(), ".ssh", "config")): string[] {
  let raw: string
  try {
    raw = readFileSync(configPath, "utf8")
  } catch {
    return []
  }
  const hosts: string[] = []
  for (const line of raw.split(/\r?\n/)) {
    const match = /^\s*Host\s+(.+)$/i.exec(line)
    if (!match) continue
    for (const token of (match[1] ?? "").trim().split(/\s+/)) {
      if (token === "") continue
      if (token.includes("*") || token.includes("?") || token.startsWith("!")) continue
      hosts.push(token)
    }
  }
  return [...new Set(hosts)]
}
