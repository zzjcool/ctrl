import type { IncomingMessage, ServerResponse } from "node:http"
import type { DatabaseSync } from "node:sqlite"
import {
  detectResumePoint,
  makeUserMessage,
  openSession,
  repairSession,
  runAgent,
} from "../engine/durable.ts"
import type { LlmClient, Session, SessionSink } from "../engine/durable.ts"
import type { UsageKind } from "../memory/usage.ts"
import { lastDreamAt, readProfile } from "../memory/dream.ts"
import { listFocus, openFocusCount } from "../memory/focus.ts"
import { liveMemoryCount } from "../memory/memories.ts"
import { compressWindow, windowInfo } from "../memory/window.ts"
import { LOG_ID } from "./agents.ts"
import { HttpError, readJson, sendJson } from "./http.ts"
import { conversationEvents, errorMessage, JOB_MESSAGE_KIND, methodNotAllowed, notFound, pageEvents } from "./routes.ts"
import type { AppContext } from "./routes.ts"
import { createAbortableLlm } from "./turns.ts"
import { readSidecar } from "./sidecar.ts"

const processStartedAt = Date.now()

export async function handleAgentRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  ctx: AppContext,
  url: URL,
  method: string,
  segments: string[],
): Promise<void> {
  const action = segments[2]
  if (segments[3] !== undefined) {
    notFound(response)
    return
  }

  if (action === undefined) {
    sendAgentDetail(response, ctx, method)
    return
  }

  if (action === "events") {
    sendAgentEvents(response, ctx, url, method)
    return
  }

  if (action === "messages") {
    await acceptMessage(request, response, ctx, method)
    return
  }

  if (action === "abort") {
    sendAbort(response, ctx, method)
    return
  }

  notFound(response)
}

function sendAgentDetail(response: ServerResponse, ctx: AppContext, method: string): void {
  if (method !== "GET") {
    methodNotAllowed(response, method)
    return
  }
  sendJson(response, 200, describeAgent(ctx))
}

function sendAgentEvents(response: ServerResponse, ctx: AppContext, url: URL, method: string): void {
  if (method !== "GET") {
    methodNotAllowed(response, method)
    return
  }
  const log = openSession(LOG_ID, { home: ctx.agentHome })
  const page = pageEvents(log.events(), {
    since: url.searchParams.get("since"),
    tail: url.searchParams.get("tail"),
    before: url.searchParams.get("before"),
  })
  const events = url.searchParams.get("view") === "conversation" ? conversationEvents(page.events) : page.events
  sendJson(response, 200, { ...page, events, turn: ctx.turns.state(LOG_ID) })
}

async function acceptMessage(
  request: IncomingMessage,
  response: ServerResponse,
  ctx: AppContext,
  method: string,
): Promise<void> {
  if (method !== "POST") {
    methodNotAllowed(response, method)
    return
  }
  const body = await readJson(request)
  const text = typeof body.text === "string" ? body.text.trim() : ""
  if (text === "") throw new HttpError(400, "text must be a non-empty string")
  const log = openSession(LOG_ID, { home: ctx.agentHome })
  const started = ctx.turns.start(LOG_ID, (signal) => runTurn(ctx, log, text, signal))
  if (!started) throw new HttpError(409, "a turn is already running for this agent")
  sendJson(response, 202, { accepted: true, turn: ctx.turns.state(LOG_ID) })
}

function sendAbort(response: ServerResponse, ctx: AppContext, method: string): void {
  if (method !== "POST") {
    methodNotAllowed(response, method)
    return
  }
  sendJson(response, 200, { aborted: ctx.turns.abort(LOG_ID) })
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
      uptimeSeconds: uptimeSeconds(),
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

function uptimeSeconds(): number {
  return Math.max(0, Math.floor((Date.now() - processStartedAt) / 1000))
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

export async function runTurn(
  ctx: AppContext,
  log: Session,
  text: string,
  signal: AbortSignal,
  origin: UsageKind = "turn",
): Promise<void> {
  try {
    await runTurnOnce(ctx, log, text, signal, origin)
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

function jobLifecycleSession(log: Session): SessionSink {
  return {
    sessionId: log.sessionId,
    events: () => log.events(),
    appendUserMessage: (text) => log.append(taggedUserMessage(text)),
    appendAssistantMessage: (input) => log.appendAssistantMessage(input),
    appendAssistantPending: (input) => log.appendAssistantPending(input),
    appendToolCall: (input) => log.appendToolCall(input),
    appendToolResult: (input) => log.appendToolResult(input),
    appendMemoryWrite: (input) => log.appendMemoryWrite(input),
    appendMemoryRecall: (input) => log.appendMemoryRecall(input),
    appendCompaction: (input) => log.appendCompaction(input),
    appendError: (input) => log.appendError(input),
  }
}

function taggedUserMessage(text: string): ReturnType<typeof makeUserMessage> {
  const draft = makeUserMessage(text)
  const tagged = draft as typeof draft & { data: { kind?: string } }
  tagged.data.kind = JOB_MESSAGE_KIND
  return draft
}

async function runTurnOnce(
  ctx: AppContext,
  log: Session,
  text: string,
  signal: AbortSignal,
  origin: UsageKind,
): Promise<void> {
  const meta = log.meta()
  const sidecar = readSidecar(ctx.agentHome, LOG_ID)
  const cwd = sidecar?.cwd ?? meta.cwd

  let base: LlmClient
  try {
    base = ctx.createLlm(meta.model !== "" ? meta.model : ctx.defaultModel, origin)
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
  const session = origin === "wake" ? jobLifecycleSession(log) : log
  try {
    await runAgent({
      sessionId: LOG_ID,
      input: text,
      session,
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
