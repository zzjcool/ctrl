export interface LogEvent {
  seq: number
  ts?: string
  type: string
  data: unknown
}

export const EVENT_TEXT_LIMIT = 2_000

export function eventRecord(event: LogEvent): Record<string, unknown> {
  return isRecord(event.data) ? event.data : {}
}

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
