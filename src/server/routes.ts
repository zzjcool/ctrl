import type { IncomingMessage, ServerResponse } from "node:http"
import { appendRecord, createMemoryStore, resolvePaths } from "../engine/durable.ts"
import type { AgentMemory, LlmClient, MemoryKind, SessionEvent, ToolSpec } from "../engine/durable.ts"
import type { JobRunner } from "../jobs/runner.ts"
import type { DreamController } from "../memory/dream.ts"
import type { MemoryIndex } from "../memory/index.ts"
import { handleAgentRoutes } from "./agent-routes.ts"
import { HttpError, readJson, sendJson } from "./http.ts"
import { handleJobsRoute } from "./job-routes.ts"
import { handleMemoryRoutes, isMemoryPath } from "./memory-routes.ts"
import type { TurnRegistry } from "./turns.ts"
import type { Waker } from "./wake.ts"

export { agentSystemPrompt, buildSystemPrompt, runTurn } from "./agent-routes.ts"
export { dreamOnce } from "./memory-routes.ts"
export { jobSummary } from "./job-routes.ts"

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

function limitTail(events: SessionEvent[], requested: number): SessionEvent[] {
  const limit = Math.min(Math.floor(requested), MAX_EVENTS_PER_CALL)
  if (limit <= 0) return []
  return events.slice(-limit)
}

export function intParam(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value)
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  if (!/^-?\d+$/.test(trimmed)) return undefined
  const parsed = Number.parseInt(trimmed, 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function methodNotAllowed(response: ServerResponse, method: string): void {
  sendJson(response, 405, { error: `method ${method} not allowed` })
}

export function notFound(response: ServerResponse): void {
  sendJson(response, 404, { error: "not found" })
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
      handleJobsRoute(response, ctx, method)
      return true
    }

    if (isMemoryPath(url.pathname, segments)) {
      await handleMemoryRoutes(request, response, ctx, url, method, segments)
      return true
    }

    if (segments[1] === "agent") {
      await handleAgentRoutes(request, response, ctx, url, method, segments)
      return true
    }

    if (segments[1] === "memory") {
      await handleMemoryStoreRoutes(request, response, ctx, url, method, segments)
      return true
    }

    notFound(response)
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

async function handleMemoryStoreRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  ctx: AppContext,
  url: URL,
  method: string,
  segments: string[],
): Promise<void> {
  const id = segments[2]
  const store = createMemoryStore(resolvePaths(ctx.agentHome))
  if (id === undefined) {
    if (method === "GET") {
      const includeSuperseded = url.searchParams.get("all") === "1"
      sendJson(response, 200, { memories: store.all(includeSuperseded ? { includeSuperseded: true } : {}) })
      return
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
      return
    }
    methodNotAllowed(response, method)
    return
  }

  if (method === "DELETE") {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new HttpError(400, "invalid memory id")
    const entry = store.get(id)
    if (!entry || entry.supersededBy) throw new HttpError(404, "memory not found")
    appendRecord(resolvePaths(ctx.agentHome).memoryLog, { ...entry, supersededBy: `deleted:${id}` })
    sendJson(response, 200, { deleted: id })
    return
  }

  methodNotAllowed(response, method)
}
