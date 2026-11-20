import { createServer } from "node:http"
import type { IncomingMessage, Server, ServerResponse } from "node:http"
import { fileURLToPath } from "node:url"
import { createChatCompletionsClient, openSession } from "../engine/durable.ts"
import type { LlmClient } from "../engine/durable.ts"
import { DEFAULT_MAX_WORKERS, DEFAULT_JOB_TIMEOUT_MINUTES, DEFAULT_PI_BIN, DEFAULT_PI_PROVIDER, JobRunner } from "../jobs/runner.ts"
import { createSqliteAgentMemory } from "../memory/agent-memory.ts"
import { lastIndexedSeq } from "../memory/db.ts"
import { DREAM_IDLE_MS, DREAM_TICK_MS, DreamController, lastDreamSeq } from "../memory/dream.ts"
import { createMemoryIndex } from "../memory/index.ts"
import { DEFAULT_CONTEXT_BUDGET } from "../memory/window.ts"
import { SelfEditGate } from "../selfedit/gate.ts"
import { createTools } from "../tools/index.ts"
import { DEFAULT_AGENT, LOG_ID, ensureAgent, logPath, resolveRoot } from "./agents.ts"
import { sendJson, serveStatic } from "./http.ts"
import { dreamOnce, handleApiRequest, type AppContext } from "./routes.ts"
import { readSidecar, writeSidecar } from "./sidecar.ts"
import { TurnRegistry } from "./turns.ts"
import { createWaker, type Waker } from "./wake.ts"

export const DEFAULT_PORT = 7333
export const DEFAULT_HOST = "127.0.0.1"
export const DEFAULT_MAX_STEPS = 12

export const DEFAULT_MODEL = "workbuddy/deepseek-v4.1-flash"
export const DEFAULT_REASONING_EFFORT = "max"

export const DEFAULT_MAX_TOKENS = 8192

export const DEFAULT_SWEEP_INTERVAL_MS = 60_000

export interface ServerConfig {

  root?: string

  agent?: string
  port?: number
  host?: string

  workspace?: string
  maxSteps?: number

  model?: string

  reasoningEffort?: string

  maxTokens?: number

  contextBudget?: number

  dreamIdleMs?: number

  dreamIntervalMs?: number

  dream?: boolean

  piBin?: string

  piProvider?: string

  maxWorkers?: number

  jobTimeoutMinutes?: number

  sweepIntervalMs?: number
  publicDir?: string
  selfEdit?: SelfEditConfig
  env?: NodeJS.ProcessEnv

  createLlm?: (model: string) => LlmClient
}

export interface SelfEditConfig {
  repoRoot?: string
  verifyCommands?: string[]
  verifyTimeoutMs?: number
  baseBranch?: string
  restart?: () => void
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
  const workspace = config.workspace?.trim() || process.cwd()
  const model = config.model?.trim() || env.PI_DURABLE_MODEL || DEFAULT_MODEL
  const reasoningEffort =
    config.reasoningEffort?.trim() || env.PI_DURABLE_REASONING_EFFORT || DEFAULT_REASONING_EFFORT
  const maxTokens =
    Number.isFinite(config.maxTokens) && (config.maxTokens ?? 0) > 0
      ? Math.floor(config.maxTokens as number)
      : DEFAULT_MAX_TOKENS
  const maxSteps = Number.isFinite(config.maxSteps) && (config.maxSteps ?? 0) > 0
    ? Math.floor(config.maxSteps as number)
    : DEFAULT_MAX_STEPS
  const contextBudget =
    Number.isFinite(config.contextBudget) && (config.contextBudget ?? 0) > 0
      ? Math.floor(config.contextBudget as number)
      : DEFAULT_CONTEXT_BUDGET

  const jobTimeoutMinutes =
    Number.isFinite(config.jobTimeoutMinutes) && (config.jobTimeoutMinutes ?? 0) >= 0
      ? Math.floor(config.jobTimeoutMinutes as number)
      : DEFAULT_JOB_TIMEOUT_MINUTES

  const root = resolveRoot(config.root, env)
  const requestedAgent = config.agent?.trim()
  const agentName = requestedAgent !== undefined && requestedAgent !== "" ? requestedAgent : DEFAULT_AGENT
  const ensured = ensureAgent({ root, name: agentName, cwd: workspace, model })

  writeSidecar(ensured.home, LOG_ID, {
    cwd: workspace,
    createdAt: readSidecar(ensured.home, LOG_ID)?.createdAt ?? ensured.meta.createdAt,
  })

  const defaultModel = ensured.session.meta().model || model

  const memory = createMemoryIndex({ agentHome: ensured.home, eventsFile: logPath(ensured.home) })

  memory.importEvents()

  const runner = new JobRunner({
    agentHome: ensured.home,
    piBin: config.piBin ?? DEFAULT_PI_BIN,
    piProvider: config.piProvider ?? DEFAULT_PI_PROVIDER,
    maxWorkers: config.maxWorkers ?? DEFAULT_MAX_WORKERS,
    jobTimeoutMinutes,
    model: defaultModel,
    thinking: reasoningEffort,
  })

  const ctx: AppContext = {
    root,
    agent: agentName,
    agentHome: ensured.home,
    workspace,
    maxSteps,
    defaultModel,
    jobs: runner,
    jobTimeoutMinutes,

    wake: undefined as unknown as Waker,
    turns: new TurnRegistry(),
    memory,
    contextBudget,

    agentMemory: createSqliteAgentMemory({
      db: memory.handle(),
      warn: (message) => process.stderr.write(`${message}\n`),
    }),

    dreams: undefined as unknown as DreamController,
    selfEdit: undefined as unknown as SelfEditGate,
    tools: [],
    env,
    createLlm:
      config.createLlm ??
      ((requested: string) =>
        createChatCompletionsClient({ model: requested || model, env, reasoningEffort, maxTokens })),
  }

  ctx.selfEdit = new SelfEditGate({
    repoRoot: config.selfEdit?.repoRoot ?? defaultRepoRoot(),
    runner,
    db: memory.handle(),
    agentHome: ensured.home,
    ...(config.selfEdit?.verifyCommands !== undefined ? { verifyCommands: config.selfEdit.verifyCommands } : {}),
    ...(config.selfEdit?.verifyTimeoutMs !== undefined ? { verifyTimeoutMs: config.selfEdit.verifyTimeoutMs } : {}),
    ...(config.selfEdit?.baseBranch !== undefined ? { baseBranch: config.selfEdit.baseBranch } : {}),
    ...(config.selfEdit?.restart !== undefined ? { restart: config.selfEdit.restart } : {}),
    warn: (message) => process.stderr.write(`ctrl: ${message}\n`),
  })

  ctx.tools = createTools({ agentHome: ensured.home, runner, memory, selfEdit: ctx.selfEdit })

  ctx.dreams = new DreamController({
    run: () => dreamOnce(ctx),
    hasWork: () => {
      const db = memory.handle()
      if (db === undefined) return false
      try {
        return lastIndexedSeq(db) > lastDreamSeq(db)
      } catch {
        return false
      }
    },
    busy: () => ctx.turns.isRunning(LOG_ID),
    lastActivity: () => lastActivityMs(ctx.agentHome),
    idleMs:
      Number.isFinite(config.dreamIdleMs) && (config.dreamIdleMs ?? 0) >= 0
        ? Math.floor(config.dreamIdleMs as number)
        : DREAM_IDLE_MS,
    intervalMs:
      Number.isFinite(config.dreamIntervalMs) && (config.dreamIntervalMs ?? 0) > 0
        ? Math.floor(config.dreamIntervalMs as number)
        : DREAM_TICK_MS,
    warn: (message) => process.stderr.write(`${message}\n`),
  })

  ctx.wake = createWaker(ctx)
  runner.onExit = (job) => {
    ctx.wake.notify(job)
    return ctx.selfEdit.handleExit(job)
  }
  return ctx
}

function lastActivityMs(agentHome: string): number | undefined {
  try {
    const log = openSession(LOG_ID, { home: agentHome })
    const last = log.events().at(-1)
    if (last === undefined) return undefined
    const at = Date.parse(last.ts)
    return Number.isFinite(at) ? at : undefined
  } catch {
    return undefined
  }
}

export function defaultPublicDir(): string {
  return fileURLToPath(new URL("../web/public", import.meta.url))
}

export function defaultRepoRoot(): string {
  return fileURLToPath(new URL("../..", import.meta.url))
}

function sweepJobs(ctx: AppContext): void {
  void ctx.jobs.sweepTimeouts().catch((error: unknown) => {
    process.stderr.write(`ctrl: job timeout sweep failed: ${error instanceof Error ? error.message : String(error)}\n`)
  })
}

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

  if (config.dream !== false) {
    ctx.dreams.startTimer()
    ctx.dreams.tick()
  }

  const sweepIntervalMs =
    Number.isFinite(config.sweepIntervalMs) && (config.sweepIntervalMs ?? 0) > 0
      ? Math.floor(config.sweepIntervalMs as number)
      : DEFAULT_SWEEP_INTERVAL_MS
  let sweepTimer: NodeJS.Timeout | undefined
  if (ctx.jobTimeoutMinutes > 0) {
    sweepJobs(ctx)
    sweepTimer = setInterval(() => sweepJobs(ctx), sweepIntervalMs)
    sweepTimer.unref()
  }
  return {
    server,
    ctx,
    port,
    url: `http://${host}:${port}`,
    close: async () => {

      ctx.wake.stop()
      if (sweepTimer !== undefined) {
        clearInterval(sweepTimer)
        sweepTimer = undefined
      }

      ctx.dreams.stopTimer()
      await ctx.dreams.settle()

      await ctx.turns.shutdown()
      await new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })

      ctx.memory.close()
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

    await serveStatic(request, response, pathname, publicDir)
  } catch (error) {
    if (!response.headersSent) sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
    else if (!response.writableEnded) response.end()
  }
}
