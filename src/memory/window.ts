import type { DatabaseSync } from "node:sqlite"
import { errorMessage, clipChars, charLength, eventChars, eventRole, eventText, sessionChars, type LogEvent } from "./events.ts"

export const DEFAULT_CONTEXT_BUDGET = 40_000

export const MIN_KEPT_EVENTS = 6

export const KEEP_FRACTION = 0.5

export const SUMMARY_MAX_CHARS = 2_000

export const SUMMARY_MAX_TOKENS = 800

export const SUMMARY_INPUT_CHARS = 24_000

const SUMMARY_EVENT_CHARS = 1_200

export interface WindowSink {
  sessionId: string
  events(): LogEvent[]
  appendCompaction(input: { summary: string; firstKeptSeq: number }): unknown
}

export interface SummaryClient {
  complete(request: {
    messages: Array<{ role: "system" | "user" | "assistant" | "tool"; content: string }>
    maxTokens?: number
    signal?: AbortSignal
  }): Promise<{ text: string }>
}

export interface WindowInfo {

  windowStart: number

  chars: number

  events: number
}

export interface CompressOptions {
  llm: SummaryClient
  budget?: number
  minKeep?: number

  db?: DatabaseSync
  signal?: AbortSignal
  now?: () => Date
  summaryChars?: number
  maxTokens?: number
}

export type CompressReason = "under-budget" | "nothing-to-compress" | `summary-failed: ${string}` | "aborted"

export interface CompressOutcome {
  compressed: boolean
  reason?: CompressReason

  summary?: string

  firstKeptSeq?: number

  fromSeq?: number
  toSeq?: number

  chars: number
  kept: number
  dropped: number
  window: WindowInfo
}

export function windowStart(events: LogEvent[]): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined || event.type !== "compaction") continue
    const data = event.data
    const first = typeof data === "object" && data !== null ? (data as { firstKeptSeq?: unknown }).firstKeptSeq : undefined
    const parsed = typeof first === "number" && Number.isFinite(first) ? Math.trunc(first) : 0
    return Math.max(0, Math.min(parsed, event.seq + 1))
  }
  return 0
}

export function windowInfo(events: LogEvent[]): WindowInfo {
  const start = windowStart(events)
  const transcript = events.filter((event) => event.seq >= start)
  return { windowStart: start, chars: sessionChars(transcript), events: transcript.length }
}

export interface WindowPlan {

  cut: number
  kept: number
  dropped: number

  chars: number

  keepChars: number
  fromSeq: number
  toSeq: number
  firstKeptSeq: number
}

export function planCompaction(
  events: LogEvent[],
  opts: { budget?: number; minKeep?: number; keepFraction?: number } = {},
): WindowPlan | undefined {
  const budget = positive(opts.budget, DEFAULT_CONTEXT_BUDGET)
  const minKeep = Math.max(1, Math.floor(opts.minKeep ?? MIN_KEPT_EVENTS))
  const keepFraction = Math.min(0.9, Math.max(0.1, opts.keepFraction ?? KEEP_FRACTION))
  const start = windowStart(events)
  const transcript = events.filter((event) => event.seq >= start)
  const chars = sessionChars(transcript)
  if (chars <= budget) return undefined

  if (transcript.length < 2) return undefined
  const content = transcript.filter((event) => eventChars(event) > 0)
  if (content.length === 0) return undefined
  if (content.length === 1 && content[0]?.type === "user_message") return undefined

  const target = Math.max(1, Math.floor(budget * keepFraction))
  let kept = 0
  let keepChars = 0
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    keepChars += eventChars(transcript[index] as LogEvent)
    kept += 1
    if (kept >= minKeep && keepChars >= target) break
  }

  let cut = transcript.length - kept

  while (cut < transcript.length && transcript[cut]?.type === "tool_result") cut += 1
  if (cut <= 0 || cut >= transcript.length) return undefined

  const dropped = transcript.slice(0, cut)
  const firstKept = transcript[cut] as LogEvent
  const lastDropped = dropped[dropped.length - 1] as LogEvent
  return {
    cut,
    kept: transcript.length - cut,
    dropped: dropped.length,
    chars,
    keepChars: sessionChars(transcript.slice(cut)),
    fromSeq: (dropped[0] as LogEvent).seq,
    toSeq: lastDropped.seq,
    firstKeptSeq: firstKept.seq,
  }
}

export async function compressWindow(session: WindowSink, opts: CompressOptions): Promise<CompressOutcome> {
  const now = opts.now ?? (() => new Date())
  const events = session.events()
  const before = windowInfo(events)
  const plan = planCompaction(events, {
    ...(opts.budget !== undefined ? { budget: opts.budget } : {}),
    ...(opts.minKeep !== undefined ? { minKeep: opts.minKeep } : {}),
  })
  if (plan === undefined) {
    const reason: CompressReason = before.chars > positive(opts.budget, DEFAULT_CONTEXT_BUDGET) ? "nothing-to-compress" : "under-budget"
    return { compressed: false, reason, chars: before.chars, kept: before.events, dropped: 0, window: before }
  }
  if (opts.signal?.aborted === true) {
    return { compressed: false, reason: "aborted", chars: plan.chars, kept: plan.kept, dropped: plan.dropped, window: before }
  }

  let summary: string
  try {
    summary = await summarise(events, plan, opts)
  } catch (error) {

    return {
      compressed: false,
      reason: `summary-failed: ${errorMessage(error)}`,
      chars: plan.chars,
      kept: plan.kept,
      dropped: plan.dropped,
      window: before,
    }
  }
  if (summary === "") {
    return {
      compressed: false,
      reason: "summary-failed: the model returned nothing",
      chars: plan.chars,
      kept: plan.kept,
      dropped: plan.dropped,
      window: before,
    }
  }

  try {
    session.appendCompaction({ summary, firstKeptSeq: plan.firstKeptSeq })
  } catch (error) {
    return {
      compressed: false,
      reason: `summary-failed: ${errorMessage(error)}`,
      chars: plan.chars,
      kept: plan.kept,
      dropped: plan.dropped,
      window: before,
    }
  }

  recordSummary(opts.db, { plan, summary, at: now() })

  return {
    compressed: true,
    summary,
    firstKeptSeq: plan.firstKeptSeq,
    fromSeq: plan.fromSeq,
    toSeq: plan.toSeq,
    chars: plan.chars,
    kept: plan.kept,
    dropped: plan.dropped,
    window: windowInfo(session.events()),
  }
}

async function summarise(events: LogEvent[], plan: WindowPlan, opts: CompressOptions): Promise<string> {
  const start = windowStart(events)
  const previous = previousSummary(events)
  const dropped = events.filter((event) => event.seq >= start && event.seq <= plan.toSeq)
  const body = clipTranscript(dropped, SUMMARY_INPUT_CHARS)
  const messages: Array<{ role: "system" | "user"; content: string }> = [
    {
      role: "system",
      content:
        "You compress the earlier part of an agent's conversation into a durable summary. " +
        "Keep what a colleague would need later: decisions, names, numbers, file paths, open threads, " +
        "and anything the user said about how they want things done. Drop pleasantries and tool noise. " +
        "Write plain prose in the user's language, at most about 1200 characters, no headings, no preamble.",
    },
    {
      role: "user",
      content:
        (previous !== undefined ? `Earlier summary (already known):\n${previous}\n\n` : "") +
        `Conversation to compress:\n${body}`,
    },
  ]
  const response = await opts.llm.complete({
    messages,
    maxTokens: opts.maxTokens ?? SUMMARY_MAX_TOKENS,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  })
  const text = typeof response?.text === "string" ? response.text.trim() : ""
  return clipChars(text, opts.summaryChars ?? SUMMARY_MAX_CHARS).trim()
}

function previousSummary(events: LogEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined || event.type !== "compaction") continue
    const text = eventText(event, SUMMARY_MAX_CHARS)
    if (text !== undefined) return text
  }
  return undefined
}

function clipTranscript(events: LogEvent[], max: number): string {
  const lines: string[] = []
  for (const event of events) {
    const text = eventText(event, SUMMARY_EVENT_CHARS)
    if (text === undefined) continue
    lines.push(`${eventRole(event)}: ${text.replace(/\s+/g, " ").trim()}`)
  }
  const body = lines.join("\n")
  if (charLength(body) <= max) return body
  const points = Array.from(body)
  const half = Math.floor(max / 2)
  const head = points.slice(0, half).join("")
  const tail = points.slice(points.length - half).join("")
  return `${head}\n…(middle elided)…\n${tail}`
}

function recordSummary(
  db: DatabaseSync | undefined,
  opts: { plan: WindowPlan; summary: string; at: Date },
): void {
  if (db === undefined) return
  try {
    db.prepare(
      "INSERT OR REPLACE INTO summaries(id, level, from_seq, to_seq, text, created_at, supersedes) VALUES (?, ?, ?, ?, ?, ?, NULL)",
    ).run(
      `sum-window-${opts.plan.firstKeptSeq}-${opts.at.getTime().toString(36)}`,
      "window",
      opts.plan.fromSeq,
      opts.plan.toSeq,
      opts.summary,
      opts.at.toISOString(),
    )
  } catch {

  }
}

function positive(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value)
  return fallback
}
