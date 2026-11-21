import type { IncomingMessage, ServerResponse } from "node:http"
import type { DatabaseSync } from "node:sqlite"
import { openSession } from "../engine/durable.ts"
import { listDreamRuns, runDream } from "../memory/dream.ts"
import type { DreamLlm, DreamResult } from "../memory/dream.ts"
import { FOCUS_STATES, FocusError, completeFocus, isFocusState, listFocus, upsertFocusStrict } from "../memory/focus.ts"
import type { FocusItem } from "../memory/focus.ts"
import { clampLimit } from "../memory/index.ts"
import { addMemory, isMemoryKind, listMemories, tombstoneMemory } from "../memory/memories.ts"
import type { MemoryRow } from "../memory/memories.ts"
import { USAGE_MAX_DAYS, usageSummary } from "../memory/usage.ts"
import { LOG_ID } from "./agents.ts"
import { HttpError, readJson, sendJson } from "./http.ts"
import { intParam, methodNotAllowed, notFound } from "./routes.ts"
import type { AppContext } from "./routes.ts"

const MEMORY_ROOT_PATHS = new Set(["/api/search", "/api/dreams", "/api/dream", "/api/usage"])

export function isMemoryPath(pathname: string, segments: string[]): boolean {
  return MEMORY_ROOT_PATHS.has(pathname) || segments[1] === "focus" || segments[1] === "memories"
}

export async function handleMemoryRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  ctx: AppContext,
  url: URL,
  method: string,
  segments: string[],
): Promise<void> {
  if (url.pathname === "/api/search") {
    handleSearch(response, ctx, url, method)
    return
  }
  if (url.pathname === "/api/dreams") {
    handleDreams(response, ctx, url, method)
    return
  }
  if (url.pathname === "/api/dream") {
    handleDream(response, ctx, method)
    return
  }
  if (url.pathname === "/api/usage") {
    handleUsage(response, ctx, url, method)
    return
  }
  if (segments[1] === "focus") {
    await handleFocus(request, response, ctx, url, method, segments)
    return
  }
  await handleMemories(request, response, ctx, url, method, segments)
}

function handleSearch(response: ServerResponse, ctx: AppContext, url: URL, method: string): void {
  if (method !== "GET") {
    methodNotAllowed(response, method)
    return
  }
  const q = (url.searchParams.get("q") ?? "").trim()
  if (q === "") {
    throw new HttpError(400, "q must be a non-empty string (GET /api/search?q=<text>&limit=<1-20>&before=<seq>)")
  }
  const limit = clampLimit(url.searchParams.get("limit"))
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
}

async function handleFocus(
  request: IncomingMessage,
  response: ServerResponse,
  ctx: AppContext,
  url: URL,
  method: string,
  segments: string[],
): Promise<void> {
  const db = requireMemoryDb(ctx)
  const id = segments[2]
  if (segments[3] !== undefined) {
    notFound(response)
    return
  }
  if (id === undefined) {
    await handleFocusRoot(request, response, db, url, method)
    return
  }
  if (method === "DELETE") {
    const item = completeFocus(db, id)
    if (item === undefined) throw new HttpError(404, "focus item not found")
    sendJson(response, 200, { item: focusView(item) })
    return
  }
  methodNotAllowed(response, method)
}

async function handleFocusRoot(
  request: IncomingMessage,
  response: ServerResponse,
  db: DatabaseSync,
  url: URL,
  method: string,
): Promise<void> {
  if (method === "GET") {
    const items = listFocus(db, {
      includeDone: url.searchParams.get("all") === "1",
      limit: intParam(url.searchParams.get("limit")) ?? undefined,
    })
    sendJson(response, 200, { items: items.map(focusView) })
    return
  }
  if (method === "POST") {
    const body = await readJson(request)
    const text = typeof body.text === "string" ? body.text.trim() : undefined
    const updateId = typeof body.id === "string" ? body.id.trim() : undefined
    if ((text === undefined || text === "") && (updateId === undefined || updateId === "")) {
      throw new HttpError(400, "text is required (or an id to update)")
    }
    if (body.state !== undefined && !isFocusState(body.state)) {
      throw new HttpError(400, `state must be one of ${FOCUS_STATES.join(", ")}`)
    }
    if (body.evidence !== undefined && (!Array.isArray(body.evidence) || body.evidence.some((value) => typeof value !== "string"))) {
      throw new HttpError(400, "evidence must be an array of strings")
    }
    let item: FocusItem
    try {
      item = upsertFocusStrict(db, {
        ...(updateId !== undefined && updateId !== "" ? { id: updateId } : {}),
        ...(text !== undefined && text !== "" ? { text } : {}),
        ...(body.state !== undefined ? { state: String(body.state) } : {}),
        ...(Array.isArray(body.evidence) ? { evidence: body.evidence as string[] } : {}),
        ...(typeof body.accept === "string" ? { accept: body.accept } : {}),
        ...(typeof body.why === "string" ? { why: body.why } : {}),
        ...(typeof body.reason === "string" ? { reason: body.reason } : {}),
        source: "user",
      })
    } catch (error) {
      if (error instanceof FocusError) {
        sendJson(response, 400, { error: error.message, code: error.code })
        return
      }
      throw error
    }
    sendJson(response, 200, { item: focusView(item) })
    return
  }
  methodNotAllowed(response, method)
}

async function handleMemories(
  request: IncomingMessage,
  response: ServerResponse,
  ctx: AppContext,
  url: URL,
  method: string,
  segments: string[],
): Promise<void> {
  const db = requireMemoryDb(ctx)
  const id = segments[2]
  if (segments[3] !== undefined) {
    notFound(response)
    return
  }
  if (id === undefined) {
    await handleMemoriesRoot(request, response, db, url, method)
    return
  }
  if (method === "DELETE") {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new HttpError(400, "invalid memory id")
    const row = tombstoneMemory(db, id)
    if (row === undefined) throw new HttpError(404, "memory not found")
    sendJson(response, 200, { deleted: id })
    return
  }
  methodNotAllowed(response, method)
}

async function handleMemoriesRoot(
  request: IncomingMessage,
  response: ServerResponse,
  db: DatabaseSync,
  url: URL,
  method: string,
): Promise<void> {
  if (method === "GET") {
    const query = (url.searchParams.get("query") ?? "").trim()
    const kind = (url.searchParams.get("kind") ?? "").trim()
    if (kind !== "" && !isMemoryKind(kind)) {
      throw new HttpError(400, "kind must be fact, preference, decision, event, skill, or lesson")
    }
    const limit = intParam(url.searchParams.get("limit"))
    const rows = listMemories(db, {
      ...(query !== "" ? { query } : {}),
      ...(kind !== "" ? { kind } : {}),
      includeSuperseded: url.searchParams.get("all") === "1",
      ...(limit !== undefined ? { limit } : {}),
    })
    sendJson(response, 200, { memories: rows.map(memoryView), count: rows.length })
    return
  }
  if (method === "POST") {
    const body = await readJson(request)
    const text = typeof body.text === "string" ? body.text.trim() : ""
    if (text === "") throw new HttpError(400, "text must be a non-empty string")
    if (body.kind !== undefined && !isMemoryKind(body.kind)) {
      throw new HttpError(400, "kind must be fact, preference, decision, event, skill, or lesson")
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
    return
  }
  methodNotAllowed(response, method)
}

function handleDreams(response: ServerResponse, ctx: AppContext, url: URL, method: string): void {
  if (method !== "GET") {
    methodNotAllowed(response, method)
    return
  }
  const db = requireMemoryDb(ctx)
  const limit = intParam(url.searchParams.get("limit"))
  sendJson(response, 200, { runs: listDreamRuns(db, limit !== undefined ? { limit } : {}) })
}

function handleDream(response: ServerResponse, ctx: AppContext, method: string): void {
  if (method !== "POST") {
    methodNotAllowed(response, method)
    return
  }
  requireMemoryDb(ctx)
  if (ctx.dreams.running) throw new HttpError(409, "a dream is already running")
  void ctx.dreams.start()
  sendJson(response, 202, { started: true })
}

function handleUsage(response: ServerResponse, ctx: AppContext, url: URL, method: string): void {
  if (method !== "GET") {
    methodNotAllowed(response, method)
    return
  }
  const raw = (url.searchParams.get("days") ?? "").trim()
  const days = raw === "" ? undefined : usageDays(raw)
  const db = requireMemoryDb(ctx)
  sendJson(response, 200, usageSummary(db, days !== undefined ? { days } : {}))
}

function usageDays(raw: string): number {
  const invalid = new HttpError(400, `days must be an integer between 1 and ${USAGE_MAX_DAYS}`)
  if (!/^\d+$/.test(raw)) throw invalid
  const parsed = Number.parseInt(raw, 10)
  if (parsed < 1 || parsed > USAGE_MAX_DAYS) throw invalid
  return parsed
}

function focusView(item: FocusItem): Record<string, unknown> {
  return {
    id: item.id,
    text: item.text,
    state: item.state,
    updatedAt: item.updatedAt,
    seq: item.seq ?? null,
    ...(item.evidence !== undefined && item.evidence.length > 0 ? { evidence: item.evidence } : {}),
    ...(item.accept !== undefined ? { accept: item.accept } : {}),
    ...(item.why !== undefined ? { why: item.why } : {}),
    ...(item.reason !== undefined ? { reason: item.reason } : {}),
  }
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
      const client = ctx.createLlm(model, "dream")
      return await client.complete(request)
    },
  }

  return await runDream({ db, agentHome: ctx.agentHome, events: log.events(), llm, force: true })
}
