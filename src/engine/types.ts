export type LlmRole = "system" | "user" | "assistant" | "tool"

export type LlmContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; dataBase64: string }

export function contentText(content: string | LlmContentPart[]): string {
  if (typeof content === "string") return content
  return content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n")
}

export interface LlmMessage {
  role: LlmRole

  content: string | LlmContentPart[]

  toolCallId?: string

  toolCalls?: LlmToolCall[]

  name?: string
}

export type JsonSchema = Record<string, unknown>

export interface LlmToolSpec {
  name: string
  description: string
  parameters: JsonSchema
}

export interface LlmToolCall {
  callId: string
  name: string
  args: Record<string, unknown>
}

export interface LlmUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export interface LlmResponse {
  text: string
  thinking?: string
  toolCalls: LlmToolCall[]
  usage: LlmUsage
  finishReason: string
}

export interface LlmCompleteRequest {
  messages: LlmMessage[]
  tools?: LlmToolSpec[]
  maxTokens?: number
  temperature?: number
  signal?: AbortSignal
}

export interface LlmDeltaInfo {
  reset?: boolean
  kind?: "text" | "thinking"
}

export type LlmDelta = (text: string, info?: LlmDeltaInfo) => void

export interface LlmClient {
  readonly model: string
  complete(req: LlmCompleteRequest): Promise<LlmResponse>
  completeStream?(req: LlmCompleteRequest, onDelta: LlmDelta): Promise<LlmResponse>
}

export interface ToolCall {
  callId: string
  name: string
  args: Record<string, unknown>
}

export type SessionEventType =
  | "session_created"
  | "user_message"
  | "assistant_message"

  | "assistant_pending"
  | "tool_call"
  | "tool_result"
  | "memory_write"
  | "memory_recall"
  | "compaction"
  | "error"

export interface EventEnvelope {
  id: string

  seq: number

  ts: string
}

export type SessionEvent = EventEnvelope &
  (
    | { type: "session_created"; data: { cwd: string; model: string } }
    | { type: "user_message"; data: { text: string } }
    | { type: "assistant_message"; data: { text: string; toolCalls?: ToolCall[] } }

    | { type: "assistant_pending"; data: { model: string; step: number } }
    | { type: "tool_call"; data: { callId: string; name: string; args: unknown } }
    | { type: "tool_result"; data: { callId: string; name: string; ok: boolean; output: string } }
    | { type: "memory_write"; data: { memoryId: string; kind: string; text: string } }
    | { type: "memory_recall"; data: { memoryIds: string[]; query: string } }
    | { type: "compaction"; data: { summary: string; firstKeptSeq: number } }
    | { type: "error"; data: { message: string; fatal: boolean } }
  )

export type EventOf<T extends SessionEventType> = Extract<SessionEvent, { type: T }>

export interface SessionMeta {
  sessionId: string
  createdAt: string
  updatedAt: string
  cwd: string
  model: string
  eventCount: number
  lastSeq: number
}

export type MemoryKind = "fact" | "preference" | "event" | "skill" | "lesson"

export interface MemoryEntry {
  id: string
  seq: number
  ts: string
  kind: MemoryKind
  text: string
  tags: string[]

  salience: number

  supersededBy?: string
}

export interface MemoryQuery {
  text: string
  limit?: number
  kinds?: MemoryKind[]

  includeSuperseded?: boolean
}

export interface MemoryHit {
  entry: MemoryEntry
  score: number
}

export interface ToolResult {
  ok: boolean
  output: string
}

export interface ToolContext {
  cwd: string

  allowBash: boolean

  timeoutMs: number

  maxOutputChars: number

  remember?: (input: { kind: MemoryKind; text: string; tags?: string[]; salience?: number }) => MemoryEntry

  recall?: (query: MemoryQuery) => MemoryHit[]

  setCleanup?: (fn: () => void) => void
}

export interface ToolSpec {
  name: string
  description: string

  parameters: JsonSchema

  hidden?: boolean
  timeoutMs?: number
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>
}
