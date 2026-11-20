// The nine routes of CONTRACT §10, and nothing else.
//
// Shape rules that matter to the page:
//   * `POST /messages` answers 202 immediately; the turn runs in the background.
//   * a second turn on the same session is 409, never a queue.
//   * `GET /events?since=N` treats `N` as an index into the event array (seq is
//     dense and 0-based, so the two coincide by construction).

import type { IncomingMessage, ServerResponse } from "node:http"
import {
  appendRecord,
  asAgentMemory,
  createMemoryStore,
  createSession,
  detectResumePoint,
  listSessions,
  openSession,
  repairSession,
  resolvePaths,
  runAgent,
} from "../engine/durable.ts"
import type {
  LlmClient,
  MemoryKind,
  SessionEvent,
  SessionMeta,
  ToolSpec,
} from "../engine/durable.ts"
import type { Executor } from "../exec/types.ts"
import { HttpError, readJson, sendJson } from "./http.ts"
import { isSessionId, readSidecar, writeSidecar } from "./sidecar.ts"
import { createAbortableLlm, type TurnRegistry } from "./turns.ts"

export type MachineKind = "local" | "ssh"

export interface AppContext {
  home?: string
  /** The machine this ctrl instance is bound to (one per session in v1). */
  machine: { name: string; kind: MachineKind }
  executor: Executor
  /** Default working directory for new sessions (remote when kind is ssh). */
  workspace: string
  allowBash: boolean
  maxSteps: number
  /** Model for new sessions when the request does not name one. */
  defaultModel: string
  turns: TurnRegistry
  tools: ToolSpec[]
  env: NodeJS.ProcessEnv
  createLlm: (model: string) => LlmClient
  /** Every machine the page may show in the chip: `local` plus ssh hosts. */
  machines: string[]
}

const MEMORY_KINDS = new Set<MemoryKind>(["fact", "preference", "event", "skill"])
const MAX_TITLE_CHARS = 60
const PAGE_SIZE = 30

export interface SessionView extends SessionMeta {
  machine: string
  remoteCwd: string
}

/** `since` is an event-array index, clamped into `[0, total]`. */
export function sliceEvents(
  events: SessionEvent[],
  since: unknown,
): { events: SessionEvent[]; total: number; since: number } {
  const total = events.length
  let requested = 0
  if (typeof since === "string" && since.trim() !== "") requested = Number.parseInt(since, 10)
  else if (typeof since === "number" && Number.isFinite(since)) requested = Math.floor(since)
  const from = Number.isFinite(requested) && requested > 0 ? Math.min(Math.floor(requested), total) : 0
  return { events: events.slice(from), total, since: from }
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
      sendJson(response, 200, { status: "ok", machine: ctx.machine.name, kind: ctx.machine.kind })
      return true
    }

    if (method === "GET" && url.pathname === "/api/machines") {
      const machines = unique([ctx.machine.name, ...ctx.machines])
        .map((name) => ({
          name,
          kind: name === "local" ? ("local" as const) : ("ssh" as const),
          current: name === ctx.machine.name,
        }))
      sendJson(response, 200, { machines })
      return true
    }

    if (segments[1] === "sessions") {
      const id = segments[2]
      const action = segments[3]
      if (id === undefined) {
        if (method === "GET") {
          const sessions = listSessions({ home: ctx.home }).slice(0, PAGE_SIZE).map((meta) => ({
            ...meta,
            title: titleOf(ctx.home, meta),
          }))
          sendJson(response, 200, { sessions })
          return true
        }
        if (method === "POST") {
          const body = await readJson(request)
          const cwd = stringOrUndefined(body.cwd) ?? ctx.workspace
          const model = stringOrUndefined(body.model)
          const session = createSession({ ...(ctx.home !== undefined ? { home: ctx.home } : {}), cwd, model: model ?? ctx.defaultModel })
          const meta = session.meta()
          const sidecar = writeSidecar(ctx.home, session.sessionId, {
            machine: ctx.machine.name,
            remoteCwd: cwd,
            createdAt: meta.createdAt,
          })
          sendJson(response, 201, {
            session: { ...meta, machine: sidecar.machine, remoteCwd: sidecar.remoteCwd } satisfies SessionView,
          })
          return true
        }
        sendJson(response, 405, { error: `method ${method} not allowed` })
        return true
      }

      if (!isSessionId(id)) throw new HttpError(400, "invalid session id")
      const session = openSessionWith(ctx, id)

      if (action === undefined) {
        if (method !== "GET") {
          sendJson(response, 405, { error: `method ${method} not allowed` })
          return true
        }
        repairSession(id, { home: ctx.home })
        const events = session.events()
        sendJson(response, 200, {
          session: sessionView(ctx, meta(session)),
          events,
          resumePoint: detectResumePoint(events),
          turn: ctx.turns.state(id),
        })
        return true
      }

      if (action === "events") {
        if (method !== "GET") {
          sendJson(response, 405, { error: `method ${method} not allowed` })
          return true
        }
        const slice = sliceEvents(session.events(), url.searchParams.get("since"))
        sendJson(response, 200, { ...slice, turn: ctx.turns.state(id) })
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
        const started = ctx.turns.start(id, (signal) => runTurn(ctx, session, text, signal))
        if (!started) throw new HttpError(409, "a turn is already running for this session")
        sendJson(response, 202, { accepted: true, turn: ctx.turns.state(id) })
        return true
      }

      if (action === "abort") {
        if (method !== "POST") {
          sendJson(response, 405, { error: `method ${method} not allowed` })
          return true
        }
        sendJson(response, 200, { aborted: ctx.turns.abort(id) })
        return true
      }

      throw new HttpError(404, "not found")
    }

    if (segments[1] === "memory") {
      const id = segments[2]
      const store = createMemoryStore(resolvePaths(ctx.home))
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
        appendRecord(resolvePaths(ctx.home).memoryLog, { ...entry, supersededBy: `deleted:${id}` })
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
// A turn
// ---------------------------------------------------------------------------

/**
 * The whole body of a turn (PLAN §2.2). Runs detached from the request.
 *
 * Failure policy: pi-durable already appended an `error` event for a failed
 * model call, so we must not append a second one. Anything else is recorded on
 * the TurnRegistry only — the log stays a transcript, not a stack trace.
 */
async function runTurn(
  ctx: AppContext,
  session: ReturnType<typeof openSession>,
  text: string,
  signal: AbortSignal,
): Promise<void> {
  const sessionId = session.sessionId
  const view = sessionView(ctx, meta(session))
  const store = createMemoryStore(resolvePaths(ctx.home))

  let base: LlmClient
  try {
    base = ctx.createLlm(view.model)
  } catch (error) {
    // No client at all (no API key, say): the user has to see this one, and
    // there is no engine turn to write it for us.
    session.appendError({ message: `LLM unavailable: ${errorMessage(error)}`, fatal: true })
    throw error
  }

  const before = session.events().length
  try {
    await runAgent({
      sessionId,
      input: text,
      session,
      llm: createAbortableLlm(base, signal),
      memory: asAgentMemory(store),
      tools: ctx.tools,
      cwd: view.remoteCwd,
      maxSteps: ctx.maxSteps,
      allowBash: ctx.allowBash,
      systemPrompt: systemPromptFor(view.remoteCwd),
    })
  } catch (error) {
    if (signal.aborted) {
      // The engine saw a failed request; say plainly what happened instead.
      session.appendError({ message: "turn aborted by the user", fatal: false })
      return
    }
    const alreadyLogged = session
      .events()
      .slice(before)
      .some((event) => event.type === "error" && event.data.fatal)
    if (alreadyLogged) return
    throw error
  }
}

/**
 * `~` and relative paths resolve on the machine that runs the tools, so the
 * model is told that once, in the same words regardless of backend (§5).
 * The host name is deliberately absent (§7).
 */
export function systemPromptFor(cwd: string): string {
  return [
    "You are a helpful assistant. Use tools when needed.",
    "",
    `The tools operate with this working directory: ${cwd}`,
    "Relative paths are resolved against it. In a path, `~` means the home directory of the user",
    "who runs the tools, which is not necessarily the home directory of the process.",
    "",
    "Every tool call is capped at about 10 seconds. A build, an install or a test suite must be",
    "started with run_task and polled with task_output; do not wait for it inside one call.",
  ].join("\n")
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function meta(session: ReturnType<typeof openSession>): SessionMeta {
  return session.meta()
}

function sessionView(ctx: AppContext, value: SessionMeta): SessionView {
  const sidecar = readSidecar(ctx.home, value.sessionId)
  return {
    ...value,
    machine: sidecar?.machine ?? ctx.machine.name,
    remoteCwd: sidecar?.remoteCwd ?? value.cwd,
  }
}

function openSessionWith(ctx: AppContext, id: string): ReturnType<typeof openSession> {
  return openSession(id, { home: ctx.home })
}

function titleOf(home: string | undefined, value: SessionMeta): string {
  try {
    const events = openSession(value.sessionId, { home }).events()
    const first = events.find((event) => event.type === "user_message")
    if (first && first.type === "user_message") {
      const text = first.data.text.replace(/\s+/g, " ").trim()
      if (text !== "") return text.length > MAX_TITLE_CHARS ? `${text.slice(0, MAX_TITLE_CHARS - 1)}…` : text
    }
  } catch {
    // A corrupt or vanished session must not break the rail.
  }
  return value.sessionId
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim() !== ""))]
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
