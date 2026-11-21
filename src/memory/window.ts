import type { DatabaseSync } from "node:sqlite"
import { sessionChars, type LogEvent } from "./events.ts"

export interface WindowInfo {
  windowStart: number
  chars: number
  events: number
}

export interface CompactionSummary {
  summary: string
  firstKeptSeq: number
  fromSeq: number
  toSeq: number
  at?: Date
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

export function recordCompactionSummary(db: DatabaseSync | undefined, input: CompactionSummary): void {
  if (db === undefined) return
  const at = input.at ?? new Date()
  try {
    db.prepare(
      "INSERT OR REPLACE INTO summaries(id, level, from_seq, to_seq, text, created_at, supersedes) VALUES (?, ?, ?, ?, ?, ?, NULL)",
    ).run(
      `sum-window-${input.firstKeptSeq}-${at.getTime().toString(36)}`,
      "window",
      input.fromSeq,
      input.toSeq,
      input.summary,
      at.toISOString(),
    )
  } catch {

  }
}
