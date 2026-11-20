import { DEFAULT_TAIL_LINES } from "./store.ts"

export const MAX_FIELD_CHARS = 120

export interface RenderStreamOptions {
  maxLines?: number
}

type JsonRecord = Record<string, unknown>

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonRecord) : undefined
}

function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

function clip(value: string, max: number = MAX_FIELD_CHARS): string {
  const flat = collapse(value)
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function parseEvent(line: string): JsonRecord | undefined {
  const text = line.trim()
  if (!text.startsWith("{")) return undefined
  try {
    const parsed: unknown = JSON.parse(text)
    const record = asRecord(parsed)
    if (record === undefined) return undefined
    return typeof record.type === "string" ? record : undefined
  } catch {
    return undefined
  }
}

function argsSummary(args: unknown): string {
  const record = asRecord(args)
  if (record === undefined) return ""
  const command = record.command
  if (typeof command === "string") return clip(command)
  return clip(JSON.stringify(record))
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value
  if (Array.isArray(value)) {
    const parts: string[] = []
    for (const part of value) {
      const record = asRecord(part)
      if (record !== undefined && typeof record.text === "string") parts.push(record.text)
      else if (typeof part === "string") parts.push(part)
    }
    return parts.join("\n")
  }
  const record = asRecord(value)
  if (record !== undefined && typeof record.text === "string") return record.text
  return ""
}

function resultSummary(result: unknown): string {
  const record = asRecord(result)
  if (record === undefined) return clip(contentText(result))
  if ("content" in record) return clip(contentText(record.content))
  if (typeof record.output === "string") return clip(record.output)
  return clip(JSON.stringify(record))
}

function assistantText(message: unknown): string {
  const record = asRecord(message)
  if (record === undefined) return ""
  if (record.role !== "assistant") return ""
  return contentText(record.content)
}

function tail(lines: string[], max: number): string {
  if (!Number.isFinite(max) || max <= 0) return lines.join("\n")
  return lines.slice(Math.max(0, lines.length - Math.floor(max))).join("\n")
}

export function renderStream(raw: string, opts: RenderStreamOptions = {}): string {
  const lines: string[] = []
  const seen = new Set<string>()
  let pending = ""
  let sawText = false

  const flush = () => {
    const body = collapse(pending)
    pending = ""
    if (body !== "") lines.push(`assistant: ${body}`)
  }

  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue
    const event = parseEvent(line)
    if (event === undefined) {
      flush()
      lines.push(line)
      continue
    }
    const type = typeof event.type === "string" ? event.type : ""

    if (type === "message_update") {
      const update = asRecord(event.assistantMessageEvent)
      if (update === undefined) continue
      if (update.type === "text_delta" && typeof update.delta === "string") {
        sawText = true
        pending += update.delta
      }
      continue
    }

    if (type === "message_start") {
      sawText = false
      continue
    }

    if (type === "message_end") {
      const message = asRecord(event.message)
      if (pending.trim() !== "") {
        flush()
      } else if (message !== undefined && message.role === "assistant" && !sawText) {
        const body = assistantText(message)
        if (body.trim() !== "") lines.push(`assistant: ${collapse(body)}`)
      }
      continue
    }

    if (type === "tool_execution_start" || type === "tool_call") {
      flush()
      const callId = typeof event.toolCallId === "string" ? event.toolCallId : typeof event.id === "string" ? event.id : ""
      if (callId !== "" && seen.has(callId)) continue
      if (callId !== "") seen.add(callId)
      const name = typeof event.toolName === "string" ? event.toolName : typeof event.name === "string" ? event.name : "tool"
      const summary = argsSummary(event.args)
      lines.push(summary === "" ? `→ ${name}` : `→ ${name}: ${summary}`)
      continue
    }

    if (type === "tool_execution_end") {
      flush()
      const summary = resultSummary(event.result)
      lines.push(summary === "" ? "← (no output)" : `← ${summary}`)
      continue
    }

    if (type === "turn_end" || type === "agent_end" || type === "agent_settled") {
      flush()
      continue
    }

    if (type === "session" || type === "agent_start" || type === "turn_start" || type === "tool_execution_update") continue
  }

  flush()
  return tail(lines, opts.maxLines ?? DEFAULT_TAIL_LINES)
}
