// What one log event says, in the two shapes the memory layer needs (MEMORY.md §5 §7).
//
// M1 (./index.ts) owns the *indexed* form of an event — clipped to 2 000 chars,
// one line per event, built for bm25. M2/M3 need a different pair of views:
//
//   eventChars(event)   how much of the model's window this event costs, in
//                       characters — the budget M2 measures (MEMORY.md §10.1:
//                       "字符数 > budget"). Deliberately the same accounting
//                       pi-durable's own compaction uses, so switching the
//                       engine's compactor off does not change what "the
//                       transcript" means.
//   eventText(event)    the event as prose for a summary/dream prompt, or
//                       undefined for lifecycle noise that carries no meaning.
//
// This module is a leaf: no database, no engine types, no I/O. `LogEvent` is a
// structural subset of the session event, so a `SessionEvent[]` is assignable
// without importing pi-durable into the memory layer.

/** The part of a session event this layer reads. */
export interface LogEvent {
  seq: number
  ts?: string
  type: string
  data: unknown
}

/** One event's prose is clipped before it enters a prompt (a worker log must not). */
export const EVENT_TEXT_LIMIT = 2_000

export function eventRecord(event: LogEvent): Record<string, unknown> {
  return isRecord(event.data) ? event.data : {}
}

/**
 * The event as prose for a prompt — or undefined when it has nothing to say.
 *
 * `memory_recall`, `session_created` and `assistant_pending` are plumbing: they
 * name ids and models, not what happened. Feeding them to a summariser only
 * spends tokens on noise.
 */
export function eventText(event: LogEvent, limit: number = EVENT_TEXT_LIMIT): string | undefined {
  const data = eventRecord(event)
  const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined)

  let body: string | undefined
  switch (event.type) {
    case "user_message":
    case "assistant_message":
      body = text(data.text)
      break
    case "tool_call": {
      const name = text(data.name) ?? "tool"
      const args = data.args === undefined ? "" : safeJson(data.args)
      body = args === "" ? name : `${name} ${args}`
      break
    }
    case "tool_result":
      body = text(data.output)
      break
    case "error":
      body = text(data.message)
      break
    case "memory_write":
      body = text(data.text)
      break
    case "compaction":
      body = text(data.summary)
      break
    default:
      body = undefined
  }
  if (body === undefined) return undefined
  const clipped = clipChars(body, limit).trim()
  return clipped === "" ? undefined : clipped
}

/** `user` / `assistant` / `tool` read better in a transcript than the wire names. */
export function eventRole(event: LogEvent): string {
  switch (event.type) {
    case "user_message":
      return "user"
    case "assistant_message":
      return "assistant"
    case "tool_result":
      return "tool"
    case "tool_call":
      return "tool_call"
    case "memory_write":
      return "memory"
    case "error":
      return "error"
    default:
      return event.type
  }
}

/**
 * Characters this event costs the model window (MEMORY.md §10.1).
 *
 * Mirrors pi-durable's `eventCharacterCount`: message text, tool output, tool
 * call name+args, memory text/query, summary and error text; markers and
 * `session_created` are free. Counting the same way keeps "over budget" the
 * same number before and after ctrl takes the compactor over.
 */
export function eventChars(event: LogEvent): number {
  const data = eventRecord(event)
  const length = (value: unknown): number => (typeof value === "string" ? charLength(value) : 0)
  switch (event.type) {
    case "user_message":
    case "assistant_message":
    case "memory_write":
      return length(data.text)
    case "tool_result":
      return length(data.output)
    case "tool_call":
      return length(data.name) + (data.args === undefined ? 0 : charLength(safeJson(data.args)))
    case "memory_recall":
      return length(data.query)
    case "compaction":
      return length(data.summary)
    case "error":
      return length(data.message)
    // Markers carry no transcript content.
    case "assistant_pending":
    case "session_created":
      return 0
    default:
      return length(data.text)
  }
}

export function sessionChars(events: LogEvent[]): number {
  let total = 0
  for (const event of events) total += eventChars(event)
  return total
}

/** Code points, so CJK and emoji count as one character each (the budget is chars, not bytes). */
export function charLength(text: string): number {
  return Array.from(text).length
}

export function clipChars(text: string, max: number): string {
  const limit = Math.max(0, Math.floor(max))
  const points = Array.from(text)
  return points.length <= limit ? text : points.slice(0, limit).join("")
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ""
  } catch {
    return String(value)
  }
}
