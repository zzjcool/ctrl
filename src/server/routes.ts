import type { IncomingMessage, ServerResponse } from "node:http"
import type { DatabaseSync } from "node:sqlite"
import {
  appendRecord,

  createMemoryStore,
  detectResumePoint,
  openSession,
  repairSession,
  resolvePaths,
  runAgent,
} from "../engine/durable.ts"
import type {
  AgentMemory,
  LlmClient,
  MemoryKind,
  Session,
  SessionEvent,
  ToolSpec,
} from "../engine/durable.ts"
import type { JobRunner } from "../jobs/runner.ts"
import { DEFAULT_LIST_LIMIT, listJobs, readJobLog } from "../jobs/store.ts"
import type { JobView } from "../jobs/store.ts"
import {
  listDreamRuns,
  lastDreamAt,
  readProfile,
  runDream,
  type DreamController,
  type DreamLlm,
  type DreamResult,
} from "../memory/dream.ts"
import { completeFocus, isFocusState, listFocus, openFocusCount, upsertFocus, type FocusItem } from "../memory/focus.ts"
import { clampLimit, type MemoryIndex } from "../memory/index.ts"
import {
  addMemory,
  isMemoryKind,
  liveMemoryCount,
  listMemories,
  tombstoneMemory,
  type MemoryRow,
} from "../memory/memories.ts"
import { compressWindow, windowInfo } from "../memory/window.ts"
import { LOG_ID } from "./agents.ts"
import { HttpError, readJson, sendJson } from "./http.ts"
import { readSidecar } from "./sidecar.ts"
import { createAbortableLlm, type TurnRegistry } from "./turns.ts"
import type { Waker } from "./wake.ts"

export interface AppContext {

  root: string

  agent: string

  agentHome: string

  workspace: string
  maxSteps: number

  defaultModel: string

  jobs: JobRunner

  jobTimeoutMinutes: number

  wake: Waker
  turns: TurnRegistry

  memory: MemoryIndex

  contextBudget: number

  dreams: DreamController

  agentMemory: AgentMemory
  tools: ToolSpec[]
  env: NodeJS.ProcessEnv
  createLlm: (model: string) => LlmClient
}

const MEMORY_KINDS = new Set<MemoryKind>(["fact", "preference", "event", "skill"])

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

      if (q === "") {
        throw new HttpError(400, "q must be a non-empty string (GET /api/search?q=<text>&limit=<1-20>&before=<seq>)")
      }
      const requested = url.searchParams.get("limit")

      const limit = clampLimit(requested === null ? undefined : requested)
      const before = intParam(url.searchParams.get("before"))

      try {
        ctx.memory.importEvents()
      } catch {

      }
      const hits = ctx.memory.search(q, {
        limit,
        ...(before !== undefined && before >= 0 ? { beforeSeq: before } : {}),
      })
      sendJson(response, 200, { query: q, hits, count: hits.length })
      return true
    }

    if (segments[1] === "focus") {
      const db = requireMemoryDb(ctx)
      const id = segments[2]
      if (segments[3] !== undefined) {
        sendJson(response, 404, { error: "not found" })
        return true
      }
      if (id === undefined) {
        if (method === "GET") {
          const items = listFocus(db, {
            includeDone: url.searchParams.get("all") === "1",
            limit: intParam(url.searchParams.get("limit")) ?? undefined,
          })
          sendJson(response, 200, { items: items.map(focusView) })
          return true
        }
        if (method === "POST") {
          const body = await readJson(request)
          const text = typeof body.text === "string" ? body.text.trim() : undefined
          const updateId = typeof body.id === "string" ? body.id.trim() : undefined
          if ((text === undefined || text === "") && (updateId === undefined || updateId === "")) {
            throw new HttpError(400, "text is required (or an id to update)")
          }
          if (body.state !== undefined && !isFocusState(body.state)) {
            throw new HttpError(400, "state must be one of open, doing, blocked, done")
          }
          const item = upsertFocus(db, {
            ...(updateId !== undefined && updateId !== "" ? { id: updateId } : {}),
            ...(text !== undefined && text !== "" ? { text } : {}),
            ...(body.state !== undefined ? { state: String(body.state) } : {}),
            source: "user",
          })
          sendJson(response, 200, { item: focusView(item) })
          return true
        }
        sendJson(response, 405, { error: `method ${method} not allowed` })
        return true
      }

      if (method === "DELETE") {
        const item = completeFocus(db, id)
        if (item === undefined) throw new HttpError(404, "focus item not found")
        sendJson(response, 200, { item: focusView(item) })
        return true
      }
      sendJson(response, 405, { error: `method ${method} not allowed` })
      return true
    }

    if (segments[1] === "memories") {
      const db = requireMemoryDb(ctx)
      const id = segments[2]
      if (segments[3] !== undefined) {
        sendJson(response, 404, { error: "not found" })
        return true
      }
      if (id === undefined) {
        if (method === "GET") {
          const query = (url.searchParams.get("query") ?? "").trim()
          const rows = listMemories(db, {
            ...(query !== "" ? { query } : {}),
            includeSuperseded: url.searchParams.get("all") === "1",
            ...(intParam(url.searchParams.get("limit")) !== undefined
              ? { limit: intParam(url.searchParams.get("limit")) as number }
              : {}),
          })
          sendJson(response, 200, { memories: rows.map(memoryView), count: rows.length })
          return true
        }
        if (method === "POST") {
          const body = await readJson(request)
          const text = typeof body.text === "string" ? body.text.trim() : ""
          if (text === "") throw new HttpError(400, "text must be a non-empty string")
          if (body.kind !== undefined && !isMemoryKind(body.kind)) {
            throw new HttpError(400, "kind must be fact, preference, decision, event, or skill")
          }
          if (body.tags !== undefined && (!Array.isArray(body.tags) || body.tags.some((tag) => typeof tag !== "string"))) {
            throw new HttpError(400, "tags must be an array of strings")
          }
          if (body.importance !== undefined && (typeof body.importance !== "number" || !Number.isFinite(body.importance))) {
            throw new HttpError(400, "importance must be a number between 0 and 1")
          }
          const written = addMemory(db, {
            text,
            ...(body.kind !== undefined ? { kind: String(body.kind) } : {}),
            ...(Array.isArray(body.tags) ? { tags: body.tags as string[] } : {}),
            ...(typeof body.importance === "number" ? { importance: body.importance } : {}),
          })
          sendJson(response, 201, { memory: memoryView(written.memory) })
          return true
        }
        sendJson(response, 405, { error: `method ${method} not allowed` })
        return true
      }

      if (method === "DELETE") {
        if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new HttpError(400, "invalid memory id")

        const row = tombstoneMemory(db, id)
        if (row === undefined) throw new HttpError(404, "memory not found")
        sendJson(response, 200, { deleted: id })
        return true
      }
      sendJson(response, 405, { error: `method ${method} not allowed` })
      return true
    }

    if (url.pathname === "/api/dreams") {
      if (method !== "GET") {
        sendJson(response, 405, { error: `method ${method} not allowed` })
        return true
      }
      const db = requireMemoryDb(ctx)
      const limit = intParam(url.searchParams.get("limit"))
      sendJson(response, 200, { runs: listDreamRuns(db, limit !== undefined ? { limit } : {}) })
      return true
    }

    if (url.pathname === "/api/dream") {
      if (method !== "POST") {
        sendJson(response, 405, { error: `method ${method} not allowed` })
        return true
      }
      requireMemoryDb(ctx)

      if (ctx.dreams.running) throw new HttpError(409, "a dream is already running")
      void ctx.dreams.start()
      sendJson(response, 202, { started: true })
      return true
    }

    if (segments[1] === "agent") {
      const action = segments[2]
      if (segments[3] !== undefined) {

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

function describeAgent(ctx: AppContext): Record<string, unknown> {
  repairSession(LOG_ID, { home: ctx.agentHome })
  const log = openSession(LOG_ID, { home: ctx.agentHome })
  const events = log.events()
  const meta = log.meta()
  const sidecar = readSidecar(ctx.agentHome, LOG_ID)
  const db = ctx.memory.handle()
  const window = windowInfo(events)
  return {
    agent: ctx.agent,
    session: {
      ...meta,

      cwd: sidecar?.cwd ?? meta.cwd,
    },
    resumePoint: detectResumePoint(events),
    turn: ctx.turns.state(LOG_ID),

    memory: {
      memories: db === undefined ? 0 : safeCount(() => liveMemoryCount(db)),
      focusOpen: db === undefined ? 0 : safeCount(() => openFocusCount(db)),
      lastDreamAt: db === undefined ? null : (safeMeta(() => lastDreamAt(db)) ?? null),
    },
    context: { windowStart: window.windowStart, chars: window.chars },
  }
}

function safeCount(read: () => number): number {
  try {
    return read()
  } catch {
    return 0
  }
}

function safeMeta(read: () => string | undefined): string | undefined {
  try {
    return read()
  } catch {
    return undefined
  }
}

export function jobSummary(job: JobView, agentHome?: string): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    id: job.id,
    state: job.state,
    task: job.task,
    startedAt: job.startedAt,
    elapsedMs: job.elapsedMs,
    ...(typeof job.code === "number" ? { code: job.code } : {}),
  }

  if (agentHome !== undefined) {
    const log = readJobLog(agentHome, job.id, { lines: 15 })
    const text = log.text.trimEnd()
    if (text !== "") summary.output = text.length > 3_000 ? `…${text.slice(-3_000)}` : text
  }
  return summary
}

export async function runTurn(ctx: AppContext, log: Session, text: string, signal: AbortSignal): Promise<void> {
  try {
    await runTurnOnce(ctx, log, text, signal)
  } finally {
    importAfterTurn(ctx)
  }
}

function importAfterTurn(ctx: AppContext): void {
  try {
    ctx.memory.importEvents()
  } catch {

  }
}

async function runTurnOnce(ctx: AppContext, log: Session, text: string, signal: AbortSignal): Promise<void> {
  const meta = log.meta()
  const sidecar = readSidecar(ctx.agentHome, LOG_ID)
  const cwd = sidecar?.cwd ?? meta.cwd

  let base: LlmClient
  try {
    base = ctx.createLlm(meta.model !== "" ? meta.model : ctx.defaultModel)
  } catch (error) {

    log.appendError({ message: `LLM unavailable: ${errorMessage(error)}`, fatal: true })
    throw error
  }

  try {
    await compressWindow(log, {
      llm: createAbortableLlm(base, signal),
      budget: ctx.contextBudget,
      ...(ctx.memory.handle() !== undefined ? { db: ctx.memory.handle() } : {}),
      signal,
    })
  } catch {

  }

  const before = log.events().length
  try {
    await runAgent({
      sessionId: LOG_ID,
      input: text,
      session: log,
      llm: createAbortableLlm(base, signal),

      memory: ctx.agentMemory,
      tools: ctx.tools,
      cwd,
      maxSteps: ctx.maxSteps,

      compactThreshold: Number.MAX_SAFE_INTEGER,

      allowBash: false,

      systemPrompt: buildSystemPrompt({
        name: ctx.agent,
        cwd,
        agentHome: ctx.agentHome,
        db: ctx.memory.handle(),
      }),
    })
  } catch (error) {
    if (signal.aborted) {

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

export function buildSystemPrompt(opts: {
  name: string
  cwd: string
  agentHome: string
  db?: DatabaseSync
}): string {
  const parts = [agentSystemPrompt({ name: opts.name, cwd: opts.cwd })]
  const profile = readProfile(opts.agentHome) ?? ""
  if (profile !== "") parts.push(`# What you know about this person\n${profile}`)
  if (opts.db !== undefined) {
    const focus = listFocus(opts.db, { limit: 5 })
    if (focus.length > 0) {
      parts.push(`# Focus\n${focus.map((item) => `- [${item.state}] ${item.text}`).join("\n")}`)
    }
  }
  return parts.join("\n\n")
}

export function agentSystemPrompt(opts: { name: string; cwd: string }): string {
  return (
    `You are ${opts.name}, a persistent agent with long-term memory. ` +
    "You do not edit files or run commands yourself: delegate work to a pi worker with the delegate tool, " +
    "then report what it did. The log is your memory; there is no conversation. " +

    "You can search your entire history with search_context(query) — use it when the user refers to something not in the recent context. " +
    `Your workspace is ${opts.cwd}.`
  )
}

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

function focusView(item: FocusItem): Record<string, unknown> {
  return { id: item.id, text: item.text, state: item.state, updatedAt: item.updatedAt, seq: item.seq ?? null }
}

function memoryView(row: MemoryRow): Record<string, unknown> {
  return {
    id: row.id,
    kind: row.kind,
    text: row.text,
    tags: row.tags,
    importance: row.importance,
    confidence: row.confidence,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.supersededBy !== undefined ? { supersededBy: row.supersededBy } : {}),
    ...(row.sourceFrom !== undefined ? { sourceFrom: row.sourceFrom } : {}),
    ...(row.sourceTo !== undefined ? { sourceTo: row.sourceTo } : {}),
  }
}

function requireMemoryDb(ctx: AppContext): DatabaseSync {
  const db = ctx.memory.handle()
  if (db === undefined) throw new HttpError(503, `memory database unavailable${ctx.memory.error !== undefined ? `: ${ctx.memory.error}` : ""}`)
  return db
}

export async function dreamOnce(ctx: AppContext): Promise<DreamResult> {
  const db = requireMemoryDb(ctx)
  const log = openSession(LOG_ID, { home: ctx.agentHome })
  const model = log.meta().model !== "" ? log.meta().model : ctx.defaultModel
  const llm: DreamLlm = {
    complete: async (request) => {
      const client = ctx.createLlm(model)
      return await client.complete(request)
    },
  }

  return await runDream({ db, agentHome: ctx.agentHome, events: log.events(), llm, force: true })
}
