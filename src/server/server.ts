// node:http assembly: API routes plus the one page (CONTRACT §9).
//
// No framework, no middleware, no dependency. The process holds one
// conversation log and one machine binding; that is the whole surface.

import { readFileSync } from "node:fs"
import { createServer } from "node:http"
import type { IncomingMessage, Server, ServerResponse } from "node:http"
import { homedir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createChatCompletionsClient, DEFAULT_LLM_MODEL } from "../engine/durable.ts"
import type { LlmClient } from "../engine/durable.ts"
import { LocalExecutor } from "../exec/local.ts"
import { SshExecutor } from "../exec/ssh.ts"
import { createTools } from "../tools/index.ts"
import { sendJson, serveStatic } from "./http.ts"
import { handleApiRequest, type AppContext, type MachineKind } from "./routes.ts"
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
  /** pi-durable home; defaults to ~/.pi-durable. */
  home?: string
  port?: number
  host?: string
  /** `local` or an ssh host alias from ~/.ssh/config. */
  machine?: string
  /** Working directory new sessions start in (remote when kind is ssh). */
  workspace?: string
  allowBash?: boolean
  maxSteps?: number
  /** Model id for new sessions; falls back to PI_DURABLE_MODEL, then DEFAULT_MODEL. */
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

  return {
    ...(config.home !== undefined ? { home: config.home } : {}),
    machine: { name: machineName, kind },
    executor,
    workspace,
    allowBash,
    maxSteps,
    defaultModel: model,
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
