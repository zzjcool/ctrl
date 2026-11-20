// node:http assembly: API routes plus the one page (CONTRACT §9).
//
// No framework, no middleware, no dependency. The process holds one named
// agent — one log, one memory, one workspace — and that is the whole surface.
// There is nothing to switch to, so nothing here takes an id, and there is no
// executor: work happens in pi workers (src/jobs), not in ctrl.

import { createServer } from "node:http"
import type { IncomingMessage, Server, ServerResponse } from "node:http"
import { fileURLToPath } from "node:url"
import { createChatCompletionsClient, openSession } from "../engine/durable.ts"
import type { LlmClient } from "../engine/durable.ts"
import { DEFAULT_MAX_WORKERS, DEFAULT_PI_BIN, DEFAULT_PI_PROVIDER, JobRunner } from "../jobs/runner.ts"
import { createSqliteAgentMemory } from "../memory/agent-memory.ts"
import { lastIndexedSeq } from "../memory/db.ts"
import { DREAM_IDLE_MS, DREAM_TICK_MS, DreamController, lastDreamSeq } from "../memory/dream.ts"
import { createMemoryIndex } from "../memory/index.ts"
import { DEFAULT_CONTEXT_BUDGET } from "../memory/window.ts"
import { createTools } from "../tools/index.ts"
import { DEFAULT_AGENT, LOG_ID, ensureAgent, logPath, resolveRoot } from "./agents.ts"
import { sendJson, serveStatic } from "./http.ts"
import { dreamOnce, handleApiRequest, type AppContext } from "./routes.ts"
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
  /** The one directory the agent and its workers live in. Defaults to cwd. */
  workspace?: string
  maxSteps?: number
  /** Model id for a new log; falls back to PI_DURABLE_MODEL, then DEFAULT_MODEL. */
  model?: string
  /** Sent as reasoning_effort; falls back to PI_DURABLE_REASONING_EFFORT, then "max". */
  reasoningEffort?: string
  /** Completion cap per model call. */
  maxTokens?: number
  /** Characters the model's transcript may cost before M2 compresses it. */
  contextBudget?: number
  /** Idle time before the background dream fires; defaults to DREAM_IDLE_MS (10 min). */
  dreamIdleMs?: number
  /** How often the idle check runs; defaults to DREAM_TICK_MS (60 s). */
  dreamIntervalMs?: number
  /** Turn the background dream off entirely (tests that must not call a model). */
  dream?: boolean
  /** The `pi` binary a worker is spawned as. Defaults to `pi` on PATH. */
  piBin?: string
  /** Provider a worker is told to use; `pi -p` is ambiguous without one. */
  piProvider?: string
  /** How many workers may run at once. Defaults to 3. */
  maxWorkers?: number
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

  // One agent, resolved before anything else: `agents/<name>/` either exists
  // (we open its log) or is created with agent.json and an empty log.
  const root = resolveRoot(config.root, env)
  const requestedAgent = config.agent?.trim()
  const agentName = requestedAgent !== undefined && requestedAgent !== "" ? requestedAgent : DEFAULT_AGENT
  const ensured = ensureAgent({ root, name: agentName, cwd: workspace, model })
  // The workspace lives next to the log, never inside it (CONTRACT §3).
  // Moving the agent to another directory is a supported edit; a half-remembered
  // one is not, so `createdAt` is carried over rather than rewritten.
  writeSidecar(ensured.home, LOG_ID, {
    cwd: workspace,
    createdAt: readSidecar(ensured.home, LOG_ID)?.createdAt ?? ensured.meta.createdAt,
  })

  // The log is the truth once it exists (PLAN §5); buildContext only picks
  // the model for a log that is being created right now.
  const defaultModel = ensured.session.meta().model || model

  // The memory mirror (MEMORY.md §4 §10): `<agentHome>/memory.db`, derived from
  // the log. Opening it may fail — a broken or read-only database must not stop
  // the server — so the index degrades and every search answers with nothing.
  const memory = createMemoryIndex({ agentHome: ensured.home, eventsFile: logPath(ensured.home) })
  // One incremental import at startup: a brand-new agent mirrors nothing, an
  // older directory gets its whole log backfilled the first time it is opened.
  memory.importEvents()

  const runner = new JobRunner({
    agentHome: ensured.home,
    piBin: config.piBin ?? DEFAULT_PI_BIN,
    piProvider: config.piProvider ?? DEFAULT_PI_PROVIDER,
    maxWorkers: config.maxWorkers ?? DEFAULT_MAX_WORKERS,
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
    turns: new TurnRegistry(),
    memory,
    contextBudget,
    // MEMORY.md §2: the loop's remember/recall go to SQLite, so a dream-written
    // memory is recalled by the next turn. A degraded database answers recall
    // with nothing and keeps the turn alive.
    agentMemory: createSqliteAgentMemory({
      db: memory.handle(),
      warn: (message) => process.stderr.write(`${message}\n`),
    }),
    // Replaced right below, once the context object exists: a dream reads the
    // log, the database and the turn registry — the same three things every
    // request reads — so it is built from the finished context, not before it.
    dreams: undefined as unknown as DreamController,
    tools: createTools({ agentHome: ensured.home, runner, memory }),
    env,
    createLlm:
      config.createLlm ??
      ((requested: string) =>
        createChatCompletionsClient({ model: requested || model, env, reasoningEffort, maxTokens })),
  }

  // MEMORY.md §10.1 M3: one dream at a time, at most every 60 s, only when the
  // agent has been idle for ten minutes and the log has moved since the last
  // dream. `startTimer()` is called by startServer, never by buildContext: a
  // timer in a context a test builds and drops would outlive the test.
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
  return ctx
}

/** When something last happened in this agent's log, in ms; undefined when unknown. */
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
  // MEMORY.md §7: a timer inside the process, plus one catch-up check at start —
  // an agent that has been idle since ctrl was last closed gets its dream as
  // soon as the server is up. Both are gated by the same idle rule, so a fresh
  // agent never dreams about nothing.
  if (config.dream !== false) {
    ctx.dreams.startTimer()
    ctx.dreams.tick()
  }
  return {
    server,
    ctx,
    port,
    url: `http://${host}:${port}`,
    close: async () => {
      // The dream's timer must not keep the process (or a test) alive, and a
      // dream in flight must not be cut in half while the database closes.
      ctx.dreams.stopTimer()
      await ctx.dreams.settle()
      // Workers are detached on purpose: closing ctrl does not cancel a job.
      await ctx.turns.shutdown()
      await new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
      // The mirror is a derived cache: close it last, and never fail a shutdown
      // over it.
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
    // The page belongs to W2; until it exists a missing file is a plain 404,
    // not a crash and not an index listing.
    await serveStatic(request, response, pathname, publicDir)
  } catch (error) {
    if (!response.headersSent) sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
    else if (!response.writableEnded) response.end()
  }
}
