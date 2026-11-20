// The routes of CONTRACT §7, and nothing else (v3: one named agent, no machine).
//
// Shape rules that matter to the page:
//   * `POST /api/agent/messages` answers 202 immediately; the turn runs on.
//   * a second turn on the agent is 409, never a queue.
//   * events has three paging modes with the priority `before` > `tail` > `since`,
//     capped at 200 per call; `since` is a *seq*, never an array index.
//   * there is no sessions route: the log id is "main" and nobody may ask for another.
//   * `/api/jobs` is read straight from disk, so a delegate card keeps updating
//     long after the turn that started the worker has ended.

import type { IncomingMessage, ServerResponse } from "node:http"
import {
  appendRecord,
  asAgentMemory,
  createMemoryStore,
  detectResumePoint,
  openSession,
  repairSession,
  resolvePaths,
  runAgent,
} from "../engine/durable.ts"
import type {
  LlmClient,
  MemoryKind,
  Session,
  SessionEvent,
  ToolSpec,
} from "../engine/durable.ts"
import type { JobRunner } from "../jobs/runner.ts"
import { DEFAULT_LIST_LIMIT, listJobs, readJobLog } from "../jobs/store.ts"
import type { JobView } from "../jobs/store.ts"
import { clampLimit, type MemoryIndex } from "../memory/index.ts"
import { LOG_ID } from "./agents.ts"
import { HttpError, readJson, sendJson } from "./http.ts"
import { readSidecar } from "./sidecar.ts"
import { createAbortableLlm, type TurnRegistry } from "./turns.ts"

export interface AppContext {
  /** `<root>`: holds `agents/` and `trash/`. */
  root: string
  /** The agent name this process serves — its identity, not a title. */
  agent: string
  /** `<root>/agents/<name>` — pi-durable's home for this agent, and the jobs. */
  agentHome: string
  /** The directory the agent (and therefore its workers) works in. */
  workspace: string
  maxSteps: number
  /** Model for a log that has not recorded one yet. */
  defaultModel: string
  /** Starts and stops pi workers; the only thing here that touches a process. */
  jobs: JobRunner
  turns: TurnRegistry
  /** The SQLite mirror of the log (MEMORY.md §4); may be degraded, never absent. */
  memory: MemoryIndex
  tools: ToolSpec[]
  env: NodeJS.ProcessEnv
  createLlm: (model: string) => LlmClient
}

const MEMORY_KINDS = new Set<MemoryKind>(["fact", "preference", "event", "skill"])
/** CONTRACT §7: no call may return more than this many events. */
export const MAX_EVENTS_PER_CALL = 200

export interface EventPage {
  events: SessionEvent[]
  total: number
  since: number
}

export interface EventQuery {
  since?: unknown
  tail?: unknown
  before?: unknown
}

/**
 * The stream (CONTRACT §7, PLAN §3.3).
 *
 *   since=N          events with seq >= N, at most 200
 *   tail=T           the last T events
 *   before=S&tail=T  the T events before seq S (paging up)
 *
 * Priority is `before` > `tail` > `since`. `since` in the answer is the seq of
 * the first returned event; when there is nothing to return it stays where the
 * caller already is (`since` mode) or is 0 (tail/before mode), which is what
 * stops the page from asking "load earlier" forever.
 */
export function pageEvents(events: SessionEvent[], query: EventQuery): EventPage {
  const total = events.length
  const before = intParam(query.before)
  const tail = intParam(query.tail)
  const since = intParam(query.since)

  let picked: SessionEvent[]
  if (before !== undefined) {
    picked = limitTail(events.filter((event) => event.seq < before), tail ?? MAX_EVENTS_PER_CALL)
  } else if (tail !== undefined) {
    picked = limitTail(events, tail)
  } else {
    const from = since !== undefined && since > 0 ? since : 0
    picked = events.filter((event) => event.seq >= from).slice(0, MAX_EVENTS_PER_CALL)
  }

  const first = picked[0]
  if (first !== undefined) return { events: picked, total, since: first.seq }
  // Nothing came back: report where the caller is, clamped into the log.
  if (before === undefined && tail === undefined) {
    return { events: [], total, since: Math.min(since !== undefined && since > 0 ? since : 0, total) }
  }
  return { events: [], total, since: 0 }
}

export async function handleApiRequest(
  request: IncomingMessage,
  response: ServerResponse,
  ctx: AppContext,
): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1")
  if (!url.pathname.startsWith("/api/")) return false
  const method = request.method ?? "GET"
  const segments = url.pathname.split("/").filter((part) => part.length > 0)
  // ["api", ...]

  try {
    if (method === "GET" && url.pathname === "/api/health") {
      sendJson(response, 200, { status: "ok", agent: ctx.agent })
      return true
    }

    if (url.pathname === "/api/jobs") {
      if (method !== "GET") {
        sendJson(response, 405, { error: `method ${method} not allowed` })
        return true
      }
      sendJson(response, 200, {
        jobs: listJobs(ctx.agentHome, { limit: DEFAULT_LIST_LIMIT }).map((job) => jobSummary(job, ctx.agentHome)),
      })
      return true
    }

    if (url.pathname === "/api/search") {
      if (method !== "GET") {
        sendJson(response, 405, { error: `method ${method} not allowed` })
        return true
      }
      const q = (url.searchParams.get("q") ?? "").trim()
      // A blank query is a caller error, not "search everything": /api/search
      // never dumps the log, it only ever answers a query.
      if (q === "") {
        throw new HttpError(400, "q must be a non-empty string (GET /api/search?q=<text>&limit=<1-20>&before=<seq>)")
      }
      const requested = url.searchParams.get("limit")
      // One clamp for both paths: 1..20, default 8 (task M1 §6).
      const limit = clampLimit(requested === null ? undefined : requested)
      const before = intParam(url.searchParams.get("before"))
      // The mirror is derived, so refresh it before answering: an event appended
      // between turns (by hand, or by a turn that just ended) is searchable at
      // once. A refresh that fails must not fail the read.
      try {
        ctx.memory.importEvents()
      } catch {
        // search answers from whatever the mirror already holds, or with nothing.
      }
      const hits = ctx.memory.search(q, {
        limit,
        ...(before !== undefined && before >= 0 ? { beforeSeq: before } : {}),
      })
      sendJson(response, 200, { query: q, hits, count: hits.length })
      return true
    }

    if (segments[1] === "agent") {
      const action = segments[2]
      if (segments[3] !== undefined) {
        // `/api/agent/events/anything` is not a route, and neither is any
        // other path with a tail on it.
        sendJson(response, 404, { error: "not found" })
        return true
      }

      if (action === undefined) {
        if (method !== "GET") {
          sendJson(response, 405, { error: `method ${method} not allowed` })
          return true
        }
        sendJson(response, 200, describeAgent(ctx))
        return true
      }

      if (action === "events") {
        if (method !== "GET") {
          sendJson(response, 405, { error: `method ${method} not allowed` })
          return true
        }
        const log = openSession(LOG_ID, { home: ctx.agentHome })
        const page = pageEvents(log.events(), {
          since: url.searchParams.get("since"),
          tail: url.searchParams.get("tail"),
          before: url.searchParams.get("before"),
        })
        sendJson(response, 200, { ...page, turn: ctx.turns.state(LOG_ID) })
        return true
      }

      if (action === "messages") {
        if (method !== "POST") {
          sendJson(response, 405, { error: `method ${method} not allowed` })
          return true
        }
        const body = await readJson(request)
        const text = typeof body.text === "string" ? body.text.trim() : ""
        if (text === "") throw new HttpError(400, "text must be a non-empty string")
        const log = openSession(LOG_ID, { home: ctx.agentHome })
        const started = ctx.turns.start(LOG_ID, (signal) => runTurn(ctx, log, text, signal))
        if (!started) throw new HttpError(409, "a turn is already running for this agent")
        sendJson(response, 202, { accepted: true, turn: ctx.turns.state(LOG_ID) })
        return true
      }

      if (action === "abort") {
        if (method !== "POST") {
          sendJson(response, 405, { error: `method ${method} not allowed` })
          return true
        }
        sendJson(response, 200, { aborted: ctx.turns.abort(LOG_ID) })
        return true
      }

      sendJson(response, 404, { error: "not found" })
      return true
    }

    if (segments[1] === "memory") {
      const id = segments[2]
      const store = createMemoryStore(resolvePaths(ctx.agentHome))
      if (id === undefined) {
        if (method === "GET") {
          const includeSuperseded = url.searchParams.get("all") === "1"
          sendJson(response, 200, { memories: store.all(includeSuperseded ? { includeSuperseded: true } : {}) })
          return true
        }
        if (method === "POST") {
          const body = await readJson(request)
          const kind = body.kind
          if (typeof kind !== "string" || !MEMORY_KINDS.has(kind as MemoryKind)) {
            throw new HttpError(400, "kind must be fact, preference, event, or skill")
          }
          if (typeof body.text !== "string" || body.text.trim() === "") {
            throw new HttpError(400, "text must be a non-empty string")
          }
          if (body.tags !== undefined && (!Array.isArray(body.tags) || body.tags.some((tag) => typeof tag !== "string"))) {
            throw new HttpError(400, "tags must be an array of strings")
          }
          const salience = typeof body.salience === "number" && Number.isFinite(body.salience) ? body.salience : undefined
          const memory = store.add({
            kind: kind as MemoryKind,
            text: body.text,
            ...(Array.isArray(body.tags) ? { tags: body.tags as string[] } : {}),
            ...(salience !== undefined ? { salience } : {}),
          })
          sendJson(response, 201, { memory })
          return true
        }
        sendJson(response, 405, { error: `method ${method} not allowed` })
        return true
      }

      if (method === "DELETE") {
        if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new HttpError(400, "invalid memory id")
        const entry = store.get(id)
        if (!entry || entry.supersededBy) throw new HttpError(404, "memory not found")
        // Tombstone, not a rewrite: the append-only log stays the truth and the
        // store already hides superseded rows.
        appendRecord(resolvePaths(ctx.agentHome).memoryLog, { ...entry, supersededBy: `deleted:${id}` })
        sendJson(response, 200, { deleted: id })
        return true
      }

      sendJson(response, 405, { error: `method ${method} not allowed` })
      return true
    }

    sendJson(response, 404, { error: "not found" })
    return true
  } catch (error) {
    const status =
      error instanceof HttpError
        ? error.status
        : errorMessage(error).startsWith("Session not found:")
          ? 404
          : 500
    sendJson(response, status, { error: errorMessage(error) })
    return true
  }
}

// ---------------------------------------------------------------------------
// `GET /api/agent` — everything the page's head needs, in one call
// ---------------------------------------------------------------------------

function describeAgent(ctx: AppContext): Record<string, unknown> {
  repairSession(LOG_ID, { home: ctx.agentHome })
  const log = openSession(LOG_ID, { home: ctx.agentHome })
  const events = log.events()
  const meta = log.meta()
  const sidecar = readSidecar(ctx.agentHome, LOG_ID)
  return {
    agent: ctx.agent,
    session: {
      ...meta,
      // The sidecar is the workspace the agent was last started with; the
      // log's own cwd is the fallback when there is no sidecar yet.
      cwd: sidecar?.cwd ?? meta.cwd,
    },
    resumePoint: detectResumePoint(events),
    turn: ctx.turns.state(LOG_ID),
  }
}

/** CONTRACT §7: the six fields the page polls for a delegate card. */
export function jobSummary(job: JobView, agentHome?: string): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    id: job.id,
    state: job.state,
    task: job.task,
    startedAt: job.startedAt,
    elapsedMs: job.elapsedMs,
    ...(typeof job.code === "number" ? { code: job.code } : {}),
  }
  // The page shows a delegate card long after the turn that started it, and
  // the tool result only says "started job …". A tail of the worker's own log
  // is what makes the card worth looking at.
  if (agentHome !== undefined) {
    const log = readJobLog(agentHome, job.id, { lines: 15 })
    const text = log.text.trimEnd()
    if (text !== "") summary.output = text.length > 3_000 ? `…${text.slice(-3_000)}` : text
  }
  return summary
}

// ---------------------------------------------------------------------------
// A turn
// ---------------------------------------------------------------------------

/**
 * One turn of the loop, plus the one thing that must happen after it: the
 * mirror catches up with the log (MEMORY.md §11, M1).
 *
 * The import lives in `finally` because an aborted or failed turn still wrote
 * events worth searching, and because a turn must never be held hostage by its
 * index — `importAfterTurn` cannot throw.
 */
async function runTurn(ctx: AppContext, log: Session, text: string, signal: AbortSignal): Promise<void> {
  try {
    await runTurnOnce(ctx, log, text, signal)
  } finally {
    importAfterTurn(ctx)
  }
}

/** Bring `memory.db` up to date after a turn; never throws, never delays a reply. */
function importAfterTurn(ctx: AppContext): void {
  try {
    ctx.memory.importEvents()
  } catch {
    // The mirror is a cache: a failed import degrades search, not the turn.
  }
}

/**
 * The whole body of a turn (PLAN §3.3). Runs detached from the request.
 *
 * Failure policy: pi-durable already appended an `error` event for a failed
 * model call, so we must not append a second one. Anything else is recorded on
 * the TurnRegistry only — the log stays a transcript, not a stack trace.
 */
async function runTurnOnce(ctx: AppContext, log: Session, text: string, signal: AbortSignal): Promise<void> {
  const store = createMemoryStore(resolvePaths(ctx.agentHome))
  const meta = log.meta()
  const sidecar = readSidecar(ctx.agentHome, LOG_ID)
  const cwd = sidecar?.cwd ?? meta.cwd

  let base: LlmClient
  try {
    base = ctx.createLlm(meta.model !== "" ? meta.model : ctx.defaultModel)
  } catch (error) {
    // No client at all (no API key, say): the user has to see this one, and
    // there is no engine turn to write it for us.
    log.appendError({ message: `LLM unavailable: ${errorMessage(error)}`, fatal: true })
    throw error
  }

  const before = log.events().length
  try {
    await runAgent({
      sessionId: LOG_ID,
      input: text,
      session: log,
      llm: createAbortableLlm(base, signal),
      memory: asAgentMemory(store),
      tools: ctx.tools,
      cwd,
      maxSteps: ctx.maxSteps,
      // ctrl has no hands (CONTRACT §2): the engine still takes the flag, but
      // nothing in the tool set can reach it.
      allowBash: false,
      // Rebuilt every turn: a restarted ctrl may be in a different directory,
      // and the model must not be told the old one.
      systemPrompt: agentSystemPrompt({ name: ctx.agent, cwd }),
    })
  } catch (error) {
    if (signal.aborted) {
      // The engine saw a failed request; say plainly what happened instead.
      log.appendError({ message: "turn aborted by the user", fatal: false })
      return
    }
    const alreadyLogged = log
      .events()
      .slice(before)
      .some((event) => event.type === "error" && event.data.fatal)
    if (alreadyLogged) return
    throw error
  }
}

/** CONTRACT §6, verbatim: the agent's name and what it is (and is not). */
export function agentSystemPrompt(opts: { name: string; cwd: string }): string {
  return (
    `You are ${opts.name}, a persistent agent with long-term memory. ` +
    "You do not edit files or run commands yourself: delegate work to a pi worker with the delegate tool, " +
    "then report what it did. The log is your memory; there is no conversation. " +
    // MEMORY.md §5: the window is not the memory. Names the one tool that
    // reaches past it, so the model does not answer "I don't have that" from a
    // short context.
    "You can search your entire history with search_context(query) — use it when the user refers to something not in the recent context. " +
    `Your workspace is ${opts.cwd}.`
  )
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * `slice(-0)` is the whole array, so a T of 0 (or a negative) must be handled
 * as "nothing requested", never as a slice index.
 */
function limitTail(events: SessionEvent[], requested: number): SessionEvent[] {
  const limit = Math.min(Math.floor(requested), MAX_EVENTS_PER_CALL)
  if (limit <= 0) return []
  return events.slice(-limit)
}

function intParam(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value)
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  if (!/^-?\d+$/.test(trimmed)) return undefined
  const parsed = Number.parseInt(trimmed, 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
