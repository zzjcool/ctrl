import type { SessionEvent, SessionSink } from "../engine/durable.ts"
import { imageMarker } from "./images.ts"

export class ImageAttachments {
  private readonly pending = new Map<string, string[]>()

  queue(sessionId: string, file: string): void {
    const waiting = this.pending.get(sessionId)
    if (waiting === undefined) this.pending.set(sessionId, [imageMarker(file)])
    else waiting.push(imageMarker(file))
  }

  queued(sessionId: string): number {
    return this.pending.get(sessionId)?.length ?? 0
  }

  take(sessionId: string): string[] {
    const waiting = this.pending.get(sessionId)
    if (waiting === undefined) return []
    this.pending.delete(sessionId)
    return waiting
  }
}

export function hasDanglingCall(events: SessionEvent[]): boolean {
  const answered = new Set(
    events.filter((event) => event.type === "tool_result").map((event) => event.data.callId),
  )
  return events.some((event) => event.type === "tool_call" && !answered.has(event.data.callId))
}

export function attachmentSink(
  base: SessionSink,
  attachments: ImageAttachments,
  appendUserMessage?: (text: string) => void,
): SessionSink {
  const write = appendUserMessage ?? ((text: string) => base.appendUserMessage(text))
  const flush = (): void => {
    if (attachments.queued(base.sessionId) === 0) return
    if (hasDanglingCall(base.events())) return
    for (const marker of attachments.take(base.sessionId)) write(marker)
  }
  return {
    sessionId: base.sessionId,
    events: () => base.events(),
    appendUserMessage: (text) => base.appendUserMessage(text),
    appendAssistantMessage: (input) => base.appendAssistantMessage(input),
    appendAssistantPending: (input) => base.appendAssistantPending(input),
    appendToolCall: (input) => base.appendToolCall(input),
    appendToolResult: (input) => {
      const result = base.appendToolResult(input)
      flush()
      return result
    },
    appendMemoryWrite: (input) => base.appendMemoryWrite(input),
    appendMemoryRecall: (input) => base.appendMemoryRecall(input),
    appendCompaction: (input) => base.appendCompaction(input),
    appendError: (input) => base.appendError(input),
  }
}
