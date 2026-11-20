import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { DatabaseSync } from "node:sqlite"
import { readMeta, writeMeta } from "./db.ts"
import { clipChars, errorMessage, eventRole, eventText, isRecord, type LogEvent } from "./events.ts"
import { listFocus, upsertFocus, type FocusItem } from "./focus.ts"
import {
  addMemory,
  cleanKindHint,
  keywords,
  searchMemories,
  supersedeMemory,
  type MemoryRow,
} from "./memories.ts"
import { RETRO_MAX_TOKENS, applyLessons, buildRetroPrompt, parseRetroPayload } from "./retro.ts"

export const META_LAST_DREAM_SEQ = "last_dream_seq"
export const META_LAST_DREAM_AT = "last_dream_at"

export const DREAM_MAX_EVENTS = 40
export const DREAM_MAX_CHARS = 12_000

export const DREAM_MAX_TOKENS = 3_000

export const DREAM_EXISTING_MEMORIES = 8

export const DREAM_IDLE_MS = 10 * 60_000

export const DREAM_TICK_MS = 60_000

export const PROFILE_FILENAME = "profile.md"
export const PROFILE_HISTORY_DIR = "profile.history"

export interface DreamLlm {
  complete(request: {
    messages: Array<{ role: "system" | "user" | "assistant" | "tool"; content: string }>
    maxTokens?: number
    signal?: AbortSignal
  }): Promise<{ text: string }>
}

export interface DreamEvent {
  seq: number
  type: string
  role: string
  text: string
}

export interface DreamBatch {
  events: DreamEvent[]

  fromSeq: number
  toSeq: number
  chars: number
}

export interface DreamMemoryDraft {
  text: string
  kind?: string
  tags?: string[]
  importance?: number
  sourceSeqs?: number[]
  supersedes?: string[]
}

export interface DreamFocusDraft {
  text?: string
  state?: string
  id?: string
}

export interface DreamPayload {
  memories: DreamMemoryDraft[]
  focus: DreamFocusDraft[]
  profileRewrite?: string
}

export interface DreamContext {
  db: DatabaseSync

  agentHome: string

  events: LogEvent[]
  llm: DreamLlm
  signal?: AbortSignal
  now?: () => Date
  maxTokens?: number
  maxEvents?: number
  maxChars?: number

  warn?: (message: string) => void

  force?: boolean
}

export interface DreamResult {
  id: string
  startedAt: string
  endedAt: string

  fromSeq: number
  toSeq: number
  added: number
  merged: number
  superseded: number

  focus: number
  profileRewritten: boolean
  batchEvents: number
  lessons: number

  skipped?: boolean
  error?: string
}

export function lastDreamSeq(db: DatabaseSync): number {
  const raw = readMeta(db, META_LAST_DREAM_SEQ)
  if (raw === undefined) return -1
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : -1
}

export function lastDreamAt(db: DatabaseSync): string | undefined {
  return readMeta(db, META_LAST_DREAM_AT)
}

export function dreamBatch(
  events: LogEvent[],
  afterSeq: number,
  opts: { maxEvents?: number; maxChars?: number } = {},
): DreamBatch {
  const maxEvents = Math.max(1, Math.floor(opts.maxEvents ?? DREAM_MAX_EVENTS))
  const maxChars = Math.max(1, Math.floor(opts.maxChars ?? DREAM_MAX_CHARS))
  const batch: DreamEvent[] = []
  let chars = 0
  for (const event of events) {
    if (event.seq <= afterSeq) continue
    if (batch.length >= maxEvents) break
    const text = eventText(event)
    const cost = text === undefined ? 0 : Array.from(text).length
    if (batch.length > 0 && chars + cost > maxChars) break
    chars += cost
    batch.push({ seq: event.seq, type: event.type, role: eventRole(event), text: text ?? "" })
  }
  const first = batch[0]
  const last = batch[batch.length - 1]
  return {
    events: batch,
    fromSeq: first?.seq ?? afterSeq,
    toSeq: last?.seq ?? afterSeq,
    chars,
  }
}

export const DREAM_INSTRUCTIONS =
  "You consolidate an agent's long-term memory. You get new events from its log, plus the memories it already holds. " +
  "Reply with ONE JSON object and nothing else — no prose, no code fence:\n" +
  '{"memories":[{"kind":"fact|preference|decision|event|skill","text":"...","tags":["..."],' +
  '"importance":0.0,"sourceSeqs":[1,2],"supersedes":["mem-id"]}],' +
  '"focus":[{"text":"...","state":"open|doing|blocked|done","id":"foc-id"}],' +
  '"profileRewrite":"..."}\n' +
  "Rules:\n" +
  "- One memory is one durable statement, in the language the user writes in. No narration of what happened, " +
  "no speculation, no secrets that were not asked to be kept.\n" +
  "- Before writing a memory, check the existing memories listed: if one says the same thing, do not repeat it; " +
  "if one is now wrong, put its id in `supersedes`.\n" +
  "- `focus` is what the agent is working on right now, at most 10 items: add what is new, pass the id of an item " +
  "whose text or state changes, and `state: \"done\"` for what finished. Each item's `after:` lines are the events " +
  "that followed it — if they show it was completed, close it.\n" +
  "- `profileRewrite` only when a stable preference or habit changed; omit it otherwise.\n" +
  '- Reply `{}` when nothing is worth keeping.'

export type FocusWithAfter = FocusItem & { after?: Array<{ seq: number; role: string; text: string }> }

export function focusIsStale(db: DatabaseSync, now: () => Date, ageMs = 30 * 60_000): boolean {
  const last = lastDreamAt(db)
  if (last === undefined) return true
  const at = Date.parse(last)
  return !Number.isFinite(at) || now().getTime() - at >= ageMs
}

export function focusWithAfter(
  events: LogEvent[],
  focus: FocusItem[],
  perItem = 3,
): FocusWithAfter[] {
  return focus.map((item) => ({
    ...item,
    after: events
      .filter((event) => item.seq !== undefined && event.seq > item.seq)
      .slice(0, perItem)
      .map((event) => ({ seq: event.seq, role: eventRole(event), text: eventText(event) ?? "" })),
  }))
}

export function buildDreamPrompt(batch: DreamBatch, existing: MemoryRow[], focus: FocusWithAfter[] = []): string {
  const transcript = batch.events
    .filter((event) => event.text !== "")
    .map((event) => `[seq ${event.seq}] ${event.role}: ${event.text.replace(/\s+/g, " ").trim()}`)
    .join("\n")
  const memories =
    existing.length === 0
      ? "(none yet)"
      : existing
          .map(
            (memory) =>
              `- [${memory.id}] (${memory.kind}, importance ${memory.importance.toFixed(2)}) ${memory.text.replace(/\s+/g, " ").trim()}`,
          )
          .join("\n")

  const focusBlock =
    focus.length === 0
      ? "(no open items)"
      : focus
          .map((item) => {
            const line = `- [${item.id}] (${item.state}) ${item.text.replace(/\s+/g, " ").trim()}`
            const after = (item.after ?? [])
              .map((event) => `[seq ${event.seq}] ${event.role}: ${event.text.replace(/\s+/g, " ").trim().slice(0, 220)}`)
              .join(" / ")
            return after === "" ? line : `${line}\n  after: ${after}`
          })
          .join("\n")
  const emptyNote =
    batch.events.length === 0
      ? "No new events. Review the focus list only: close what its `after:` lines show as finished, " +
        "and do not invent memories.\n\n"
      : ""
  return (
    emptyNote +
    `Current focus (open/doing):\n${focusBlock}\n\n` +
    `Existing memories:\n${memories}\n\n` +
    `New events (seq ${batch.fromSeq}..${batch.toSeq}):\n${transcript === "" ? "(no prose, only markers)" : transcript}`
  )
}

export function extractJsonObject(text: string): string | undefined {
  if (typeof text !== "string") return undefined
  let body = text.trim()
  if (body === "") return undefined

  const fence = /```[a-zA-Z0-9_-]*\s*([\s\S]*?)```/.exec(body)
  if (fence !== null && typeof fence[1] === "string" && fence[1].trim() !== "") body = fence[1].trim()

  const start = body.indexOf("{")
  if (start < 0) return undefined
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < body.length; index += 1) {
    const char = body[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === "{") depth += 1
    else if (char === "}") {
      depth -= 1
      if (depth === 0) return body.slice(start, index + 1)
    }
  }
  return undefined
}

export function parseDreamPayload(text: string): DreamPayload | undefined {
  const json = extractJsonObject(text)
  if (json === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return undefined
  }
  if (!isRecord(parsed)) return undefined

  const memories: DreamMemoryDraft[] = []
  for (const draft of asArray(parsed.memories)) {
    if (!isRecord(draft)) continue
    const body = typeof draft.text === "string" ? draft.text.trim() : ""
    if (body === "") continue
    const kind = cleanKindHint(draft.kind)
    const importance = typeof draft.importance === "number" && Number.isFinite(draft.importance) ? draft.importance : undefined
    memories.push({
      text: clipChars(body, 2_000),
      ...(kind !== undefined ? { kind } : {}),
      ...(asArray(draft.tags).filter((tag): tag is string => typeof tag === "string").length > 0
        ? { tags: asArray(draft.tags).filter((tag): tag is string => typeof tag === "string") }
        : {}),
      ...(importance !== undefined ? { importance } : {}),
      ...(seqList(draft.sourceSeqs) !== undefined ? { sourceSeqs: seqList(draft.sourceSeqs) as number[] } : {}),
      ...(idList(draft.supersedes) !== undefined ? { supersedes: idList(draft.supersedes) as string[] } : {}),
    })
  }

  const focus: DreamFocusDraft[] = []
  for (const draft of asArray(parsed.focus)) {
    if (!isRecord(draft)) continue
    const id = typeof draft.id === "string" && draft.id.trim() !== "" ? draft.id.trim() : undefined
    const body = typeof draft.text === "string" && draft.text.trim() !== "" ? draft.text.trim() : undefined
    if (id === undefined && body === undefined) continue
    const state =
      typeof draft.state === "string"
        ? draft.state.trim()
        : typeof draft.status === "string"
          ? draft.status.trim()
          : undefined
    focus.push({
      ...(body !== undefined ? { text: clipChars(body, 500) } : {}),
      ...(state !== undefined ? { state } : {}),
      ...(id !== undefined ? { id } : {}),
    })
  }

  const rewrite = typeof parsed.profileRewrite === "string" ? parsed.profileRewrite.trim() : ""
  return {
    memories,
    focus,
    ...(rewrite !== "" ? { profileRewrite: clipChars(rewrite, 8_000) } : {}),
  }
}

export function profilePath(agentHome: string): string {
  return join(agentHome, PROFILE_FILENAME)
}

export function readProfile(agentHome: string): string | undefined {
  try {
    return readFileSync(profilePath(agentHome), "utf8")
  } catch {
    return undefined
  }
}

export function writeProfile(agentHome: string, text: string, now: Date = new Date()): { path: string; history?: string } {
  const body = text.trim()
  if (body === "") throw new Error("profile text must be a non-empty string")
  const file = profilePath(agentHome)
  let history: string | undefined
  if (existsSync(file)) {
    const dir = join(agentHome, PROFILE_HISTORY_DIR)
    mkdirSync(dir, { recursive: true })
    history = join(dir, `${now.toISOString().replace(/[:.]/g, "")}.md`)
    writeFileSync(history, readFileSync(file))
  }
  mkdirSync(agentHome, { recursive: true })
  writeFileSync(file, `${body}\n`)
  return history === undefined ? { path: file } : { path: file, history }
}

export async function runDream(ctx: DreamContext): Promise<DreamResult> {
  const now = ctx.now ?? (() => new Date())
  const startedAt = now().toISOString()

  const watermark = lastDreamSeq(ctx.db)
  const batch = dreamBatch(ctx.events, watermark, {
    ...(ctx.maxEvents !== undefined ? { maxEvents: ctx.maxEvents } : {}),
    ...(ctx.maxChars !== undefined ? { maxChars: ctx.maxChars } : {}),
  })
  const runId = `dream-${now().getTime().toString(36)}-${Math.floor(Math.random() * 36 ** 3)
    .toString(36)
    .padStart(3, "0")}`

  const result: DreamResult = {
    id: runId,
    startedAt,
    endedAt: startedAt,

    fromSeq: batch.events.length > 0 ? batch.fromSeq : watermark,
    toSeq: batch.toSeq,
    added: 0,
    merged: 0,
    superseded: 0,
    focus: 0,
    profileRewritten: false,
    batchEvents: batch.events.length,
    lessons: 0,
  }

  const openFocus = listFocus(ctx.db, { limit: 10 })

  const reviewFocus = openFocus.length > 0 && (ctx.force === true || focusIsStale(ctx.db, ctx.now ?? (() => new Date())))
  if (batch.events.length === 0 && !reviewFocus) {

    result.skipped = true
    result.toSeq = watermark
    result.endedAt = now().toISOString()
    writeMeta(ctx.db, META_LAST_DREAM_AT, result.endedAt)
    recordRun(ctx.db, result, now())
    return result
  }

  const existing = batch.events.length === 0 ? [] : relevantMemories(ctx.db, batch)
  let payload: DreamPayload | undefined
  try {
    const response = await ctx.llm.complete({
      messages: [
        { role: "system", content: DREAM_INSTRUCTIONS },
        { role: "user", content: buildDreamPrompt(batch, existing, focusWithAfter(ctx.events, listFocus(ctx.db, { limit: 10 }))) },
      ],
      maxTokens: ctx.maxTokens ?? DREAM_MAX_TOKENS,
      ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
    })
    payload = parseDreamPayload(typeof response?.text === "string" ? response.text : "")
  } catch (error) {
    return finishWithError(ctx, result, `dream model call failed: ${errorMessage(error)}`, now)
  }
  if (payload === undefined) {
    return finishWithError(ctx, result, "the model did not return a usable JSON object", now)
  }

  const sourceSeqs = [batch.fromSeq, batch.toSeq]
  try {
    ctx.db.exec("BEGIN")
    try {
      for (const draft of payload.memories) {
        const written = addMemory(ctx.db, {
          text: draft.text,
          ...(draft.kind !== undefined ? { kind: draft.kind } : {}),
          ...(draft.tags !== undefined ? { tags: draft.tags } : {}),
          ...(draft.importance !== undefined ? { importance: draft.importance } : {}),
          sourceSeqs: draft.sourceSeqs ?? sourceSeqs,
          now: now(),
        })
        if (written.created) result.added += 1
        else result.merged += 1
        for (const oldId of draft.supersedes ?? []) {
          if (supersedeMemory(ctx.db, oldId, written.memory.id, now())) result.superseded += 1
        }
      }
      for (const draft of payload.focus) {
        upsertFocus(ctx.db, {
          ...(draft.id !== undefined ? { id: draft.id } : {}),
          ...(draft.text !== undefined ? { text: draft.text } : {}),
          ...(draft.state !== undefined ? { state: draft.state } : {}),
          source: "dream",
          seq: batch.toSeq,
          now: now(),
        })
        result.focus += 1
      }
      if (payload.profileRewrite !== undefined) {
        writeProfile(ctx.agentHome, payload.profileRewrite, now())
        result.profileRewritten = true
      }
      result.endedAt = now().toISOString()
      writeMeta(ctx.db, META_LAST_DREAM_SEQ, String(batch.toSeq))
      writeMeta(ctx.db, META_LAST_DREAM_AT, now().toISOString())
      recordRun(ctx.db, result, now())
      ctx.db.exec("COMMIT")
    } catch (error) {
      rollback(ctx.db)
      throw error
    }
  } catch (error) {

    return finishWithError(ctx, result, `dream write failed: ${errorMessage(error)}`, now)
  }

  await runRetro(ctx, batch, result, now)
  return result
}

async function runRetro(ctx: DreamContext, batch: DreamBatch, result: DreamResult, now: () => Date): Promise<void> {
  if (batch.events.length === 0) return
  try {
    const response = await ctx.llm.complete({
      messages: [{ role: "user", content: buildRetroPrompt(batch) }],
      maxTokens: RETRO_MAX_TOKENS,
      ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
    })
    const lessons = parseRetroPayload(typeof response?.text === "string" ? response.text : "")
    if (lessons.length === 0) return
    const written = applyLessons(ctx.db, lessons, { sourceSeqs: [batch.fromSeq, batch.toSeq], now: now() })
    result.lessons = written.created + written.merged
    recordRun(ctx.db, result, now())
  } catch (error) {
    warn(ctx, `dream retro failed: ${errorMessage(error)}`)
  }
}

function warn(ctx: DreamContext, message: string): void {
  if (ctx.warn !== undefined) {
    ctx.warn(message)
    return
  }
  process.stderr.write(`${message}\n`)
}

function finishWithError(ctx: DreamContext, result: DreamResult, message: string, now: () => Date): DreamResult {
  result.error = message
  result.endedAt = now().toISOString()
  try {
    recordRun(ctx.db, result, now())
  } catch {

  }
  return result
}

function recordRun(db: DatabaseSync, result: DreamResult, at: Date): void {
  db.prepare(
    "INSERT OR REPLACE INTO dream_runs(id, started_at, ended_at, from_seq, to_seq, added, merged, superseded, lessons, " +
      "summary_id, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)",
  ).run(
    result.id,
    result.startedAt,
    result.endedAt || at.toISOString(),
    result.fromSeq,
    result.toSeq,
    result.added,
    result.merged,
    result.superseded,
    result.lessons,
    result.error ?? null,
  )
}

function rollback(db: DatabaseSync): void {
  try {
    db.exec("ROLLBACK")
  } catch {

  }
}

function relevantMemories(db: DatabaseSync, batch: DreamBatch): MemoryRow[] {
  const words = new Set<string>()
  for (const event of batch.events) {
    for (const word of keywords(event.text)) {
      if (word.length >= 2) words.add(word)
    }
  }
  const query = [...words].sort((a, b) => b.length - a.length).slice(0, 12).join(" ")
  if (query.trim() === "") return []
  return searchMemories(db, query, { limit: DREAM_EXISTING_MEMORIES })
}

export interface DreamRunRow {
  id: string
  startedAt: string
  endedAt?: string
  fromSeq?: number
  toSeq?: number
  added: number
  merged: number
  superseded: number
  lessons: number
  error?: string
}

export function listDreamRuns(db: DatabaseSync, opts: { limit?: number } = {}): DreamRunRow[] {
  const limit = Math.max(1, Math.min(Math.floor(opts.limit ?? 20), 200))
  const rows = db.prepare("SELECT * FROM dream_runs ORDER BY started_at DESC, id DESC LIMIT ?").all(limit) as unknown[]
  return rows.map((raw) => {
    const row = isRecord(raw) ? raw : {}
    const number = (value: unknown): number | undefined => {
      if (typeof value === "number" && Number.isFinite(value)) return value
      if (typeof value === "bigint") return Number(value)
      if (typeof value === "string" && /^-?\d+$/.test(value)) return Number.parseInt(value, 10)
      return undefined
    }
    const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined)
    return {
      id: text(row.id) ?? "",
      startedAt: text(row.started_at) ?? "",
      ...(text(row.ended_at) !== undefined ? { endedAt: text(row.ended_at) as string } : {}),
      ...(number(row.from_seq) !== undefined ? { fromSeq: number(row.from_seq) as number } : {}),
      ...(number(row.to_seq) !== undefined ? { toSeq: number(row.to_seq) as number } : {}),
      added: number(row.added) ?? 0,
      merged: number(row.merged) ?? 0,
      superseded: number(row.superseded) ?? 0,
      lessons: number(row.lessons) ?? 0,
      ...(text(row.error) !== undefined ? { error: text(row.error) as string } : {}),
    }
  })
}

export interface DreamControllerOptions {

  run: () => Promise<DreamResult>

  hasWork?: () => boolean

  busy?: () => boolean

  lastActivity?: () => number | undefined
  idleMs?: number
  intervalMs?: number
  now?: () => number
  warn?: (message: string) => void
}

export class DreamController {
  private readonly opts: DreamControllerOptions
  private current: Promise<DreamResult> | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  private readonly warned = new Set<string>()

  constructor(opts: DreamControllerOptions) {
    this.opts = opts
  }

  get running(): boolean {
    return this.current !== undefined
  }

  start(): Promise<DreamResult> {
    if (this.current !== undefined) return this.current
    const promise = (async (): Promise<DreamResult> => {
      try {
        return await this.opts.run()
      } catch (error) {

        this.warnOnce(`run:${errorMessage(error)}`, `dream failed: ${errorMessage(error)}`)
        return {
          id: "dream-failed",
          startedAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
          fromSeq: -1,
          toSeq: -1,
          added: 0,
          merged: 0,
          superseded: 0,
          focus: 0,
          profileRewritten: false,
          batchEvents: 0,
          lessons: 0,
          error: errorMessage(error),
        }
      } finally {
        this.current = undefined
      }
    })()
    this.current = promise
    return promise
  }

  tick(): boolean {
    if (this.running) return false
    if (this.opts.busy?.() === true) return false
    if (this.opts.hasWork !== undefined && !this.opts.hasWork()) return false
    const last = this.opts.lastActivity?.()
    if (last === undefined || !Number.isFinite(last)) return false
    const now = this.opts.now?.() ?? Date.now()
    if (now - last < (this.opts.idleMs ?? DREAM_IDLE_MS)) return false
    void this.start()
    return true
  }

  startTimer(): void {
    if (this.timer !== undefined) return
    this.timer = setInterval(() => {
      this.tick()
    }, Math.max(1, Math.floor(this.opts.intervalMs ?? DREAM_TICK_MS)))

    this.timer.unref?.()
  }

  stopTimer(): void {
    if (this.timer === undefined) return
    clearInterval(this.timer)
    this.timer = undefined
  }

  async settle(): Promise<void> {
    const current = this.current
    if (current === undefined) return
    await current.catch(() => undefined)
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return
    this.warned.add(key)
    this.opts.warn?.(message)
  }
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function seqList(value: unknown): number[] | undefined {
  const raw = Array.isArray(value) ? value : typeof value === "number" ? [value] : []
  const seqs = raw.filter((item): item is number => typeof item === "number" && Number.isFinite(item)).map(Math.trunc)
  return seqs.length === 0 ? undefined : seqs
}

function idList(value: unknown): string[] | undefined {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? [value] : []
  const ids = raw
    .map((item) => {
      if (typeof item === "string") return item.trim()

      if (isRecord(item) && typeof item.id === "string") return item.id.trim()
      return ""
    })
    .filter((item) => item !== "")
  return ids.length === 0 ? undefined : ids
}
