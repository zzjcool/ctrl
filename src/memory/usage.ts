import type { DatabaseSync } from "node:sqlite"
import type { LlmClient, LlmCompleteRequest, LlmResponse } from "../engine/durable.ts"
import { errorMessage, isRecord } from "./events.ts"

export const USAGE_DEFAULT_DAYS = 7

export const USAGE_MAX_DAYS = 90

export type UsageKind = "turn" | "dream"

export interface UsageEntry {
  kind: string
  model?: string | null
  promptTokens?: number
  completionTokens?: number
  ms?: number
  ok?: boolean
}

export interface UsageTotals {
  calls: number
  promptTokens: number
  completionTokens: number
  ms: number
}

export interface UsageDay {
  date: string
  calls: number
  promptTokens: number
  completionTokens: number
}

export interface UsageSummary {
  today: UsageTotals
  days: UsageDay[]
  total: UsageTotals
}

export interface RecordingLlmOptions {
  db: DatabaseSync | undefined
  kind: UsageKind
}

export function recordUsage(db: DatabaseSync, entry: UsageEntry): void {
  try {
    db.prepare(
      "INSERT INTO usage(id, ts, kind, model, prompt_tokens, completion_tokens, ms, ok) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      usageId(),
      new Date().toISOString(),
      entry.kind,
      entry.model ?? null,
      count(entry.promptTokens),
      count(entry.completionTokens),
      count(entry.ms),
      entry.ok === false ? 0 : 1,
    )
  } catch (error) {
    process.stderr.write(`ctrl: usage record failed: ${errorMessage(error)}\n`)
  }
}

export function createRecordingLlm(client: LlmClient, opts: RecordingLlmOptions): LlmClient {
  return {
    model: client.model,
    async complete(req: LlmCompleteRequest): Promise<LlmResponse> {
      const startedAt = Date.now()
      let response: LlmResponse
      try {
        response = await client.complete(req)
      } catch (error) {
        writeUsage(opts, client.model, undefined, Date.now() - startedAt, false)
        throw error
      }
      writeUsage(opts, client.model, response, Date.now() - startedAt, true)
      return response
    },
  }
}

export function usageSummary(db: DatabaseSync, opts: { days?: number; now?: Date } = {}): UsageSummary {
  const days = clampUsageDays(opts.days)
  const now = opts.now ?? new Date()
  const dates: string[] = []
  const buckets = new Map<string, UsageDay>()
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = localDate(addDays(now, -offset))
    dates.push(date)
    buckets.set(date, { date, calls: 0, promptTokens: 0, completionTokens: 0 })
  }
  const todayKey = localDate(now)
  const today = emptyTotals()
  const total = emptyTotals()
  const rows = db
    .prepare("SELECT ts, prompt_tokens, completion_tokens, ms FROM usage WHERE ts >= ? AND ts < ? ORDER BY ts ASC")
    .all(
      startOfLocalDay(addDays(now, -(days - 1))).toISOString(),
      startOfLocalDay(addDays(now, 1)).toISOString(),
    ) as unknown[]
  for (const raw of rows) {
    const row = isRecord(raw) ? raw : {}
    const at = typeof row.ts === "string" ? new Date(row.ts) : undefined
    if (at === undefined || Number.isNaN(at.getTime())) continue
    const date = localDate(at)
    const promptTokens = count(row.prompt_tokens)
    const completionTokens = count(row.completion_tokens)
    const ms = count(row.ms)
    const bucket = buckets.get(date)
    if (bucket !== undefined) {
      bucket.calls += 1
      bucket.promptTokens += promptTokens
      bucket.completionTokens += completionTokens
    }
    total.calls += 1
    total.promptTokens += promptTokens
    total.completionTokens += completionTokens
    total.ms += ms
    if (date === todayKey) {
      today.calls += 1
      today.promptTokens += promptTokens
      today.completionTokens += completionTokens
      today.ms += ms
    }
  }
  return { today, days: dates.map((date) => buckets.get(date) as UsageDay), total }
}

export function clampUsageDays(value: unknown): number {
  const parsed = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : USAGE_DEFAULT_DAYS
  return Math.max(1, Math.min(parsed, USAGE_MAX_DAYS))
}

function writeUsage(
  opts: RecordingLlmOptions,
  model: string | undefined,
  response: unknown,
  ms: number,
  ok: boolean,
): void {
  if (opts.db === undefined) return
  const usage = isRecord(response) && isRecord(response.usage) ? response.usage : undefined
  recordUsage(opts.db, {
    kind: opts.kind,
    model: model ?? null,
    promptTokens: count(usage?.promptTokens),
    completionTokens: count(usage?.completionTokens),
    ms,
    ok,
  })
}

function count(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.trunc(value))
  if (typeof value === "bigint") return Math.max(0, Number(value))
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number.parseInt(value.trim(), 10)
  return 0
}

function addDays(at: Date, offset: number): Date {
  const next = new Date(at.getTime())
  next.setHours(12, 0, 0, 0)
  next.setDate(next.getDate() + offset)
  return next
}

function startOfLocalDay(at: Date): Date {
  const start = new Date(at.getTime())
  start.setHours(0, 0, 0, 0)
  return start
}

function localDate(at: Date): string {
  const month = String(at.getMonth() + 1).padStart(2, "0")
  const day = String(at.getDate()).padStart(2, "0")
  return `${at.getFullYear()}-${month}-${day}`
}

function emptyTotals(): UsageTotals {
  return { calls: 0, promptTokens: 0, completionTokens: 0, ms: 0 }
}

function usageId(): string {
  return `usage-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}
