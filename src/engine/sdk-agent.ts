import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent"
import type { AgentSession, ToolDefinition } from "@earendil-works/pi-coding-agent"
import {
  createAssistantMessageEventStream,
  createProvider,
  getSystemMessageText,
} from "@earendil-works/pi-ai"
import type {
  AssistantMessage,
  AssistantMessageEventStream,
  Message,
  JsonObject,
  Model,
  TranscriptContext,
  Usage,
} from "@earendil-works/pi-ai"
import type { Session } from "./log.ts"
import type { MemoryStore } from "./memory.ts"
import { executeTool, toLlmTools } from "./tools.ts"
import type {
  LlmClient,
  LlmCompleteRequest,
  LlmContentPart,
  LlmDelta,
  LlmMessage,
  LlmResponse,
  LlmToolCall,
  MemoryEntry,
  MemoryHit,
  MemoryKind,
  MemoryQuery,
  SessionEvent,
  ToolCall,
  ToolContext,
  ToolResult,
  ToolSpec,
} from "./types.ts"

export type SessionSink = Pick<
  Session,
  | "sessionId"
  | "events"
  | "appendUserMessage"
  | "appendAssistantMessage"
  | "appendAssistantPending"
  | "appendToolCall"
  | "appendToolResult"
  | "appendMemoryWrite"
  | "appendMemoryRecall"
  | "appendCompaction"
  | "appendError"
>

export interface AgentMemory {
  remember(input: { kind: MemoryKind; text: string; tags?: string[] }): MemoryEntry
  recall(query: MemoryQuery): MemoryHit[]
}

export interface AgentRunOptions {
  sessionId: string
  input: string
  llm: LlmClient
  tools: ToolSpec[]
  cwd?: string
  maxSteps?: number
  allowBash?: boolean
  onProgress?: (line: string) => void
}

export interface AgentRunResult {
  sessionId: string
  reply: string
  steps: number
  toolCalls: number
  memoriesWritten: string[]
  memoriesRecalled: string[]
  compacted: boolean
  usage: LlmUsage
}

export interface LlmUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export interface CompactionRecord {
  summary: string
  firstKeptSeq: number
  fromSeq: number
  toSeq: number
}

export type DurableAgentRunOptions = AgentRunOptions & {
  session: SessionSink
  memory?: AgentMemory
  systemPrompt?: string
  agentDir?: string
  maxRecall?: number
  maxMemoryChars?: number
  onDelta?: LlmDelta
  onCompaction?: (record: CompactionRecord) => void
}

const DEFAULT_MAX_STEPS = 12
const DEFAULT_MAX_RECALL = 8
const DEFAULT_MAX_MEMORY_CHARS = 2_000
const TOOL_TIMEOUT_MS = 10_000
const TOOL_OUTPUT_CHARS = 8_000
const SDK_PROVIDER = "ctrl"
const SDK_MODEL_ID = "ctrl"
const SDK_CONTEXT_WINDOW = 128_000
const SDK_MAX_TOKENS = 8_192
const STEP_LIMIT_NOTE = "[Maximum steps reached; stopping the tool loop.]"

export async function runAgent(opts: DurableAgentRunOptions): Promise<AgentRunResult> {
  const { session } = opts
  const cwd = opts.cwd ?? process.cwd()
  const maxSteps = positiveInteger(opts.maxSteps ?? environmentMaxSteps() ?? DEFAULT_MAX_STEPS, DEFAULT_MAX_STEPS)
  const memoriesWritten: string[] = []
  const memoriesRecalled: string[] = []
  const seqByEntry = new Map<string, number>()
  let usage: LlmUsage = zeroUsage()
  let steps = 0
  let toolCalls = 0
  let compacted = false
  let lastText = ""
  let failure: Error | undefined
  let inCompaction = false

  failDanglingCalls(session)
  const history = buildHistory(session.events())
  const windowStart = windowOf(session.events())
  session.appendUserMessage(opts.input)

  const recallBlock = recallInto(opts, session, memoriesRecalled)
  const toolContext = buildToolContext(opts, session, memoriesWritten, memoriesRecalled)

  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: true },
    retry: { enabled: false },
    enableInstallTelemetry: false,
    enableAnalytics: false,
    quietStartup: true,
  })
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: opts.agentDir ?? cwd,
    settingsManager,
    noExtensions: true,
    noPromptTemplates: true,
    noThemes: true,
    ...(opts.systemPrompt !== undefined ? { systemPrompt: opts.systemPrompt } : {}),
    ...(recallBlock !== "" ? { appendSystemPrompt: [recallBlock] } : {}),
  })
  await loader.reload()

  const model = sdkModel()
  const modelTools = toLlmTools(opts.tools)
  const completeTurn = async (
    context: TranscriptContext,
    signal: AbortSignal | undefined,
    stream: AssistantMessageEventStream,
  ): Promise<TurnAnswer> => {
    const compacting = inCompaction
    if (!compacting) {
      steps += 1
      session.appendAssistantPending({ model: opts.llm.model, step: steps - 1 })
    }
    const request: LlmCompleteRequest = {
      messages: toWire(context.messages),
      tools: modelTools,
      ...(signal !== undefined ? { signal } : {}),
    }
    const streamed = !compacting ? opts.llm.completeStream : undefined
    const live = streamed === undefined ? undefined : openStream(stream)
    let response: LlmResponse
    if (streamed !== undefined && live !== undefined) {
      response = await streamed.call(opts.llm, request, (text, info) => {
        if (info?.reset === true) resetStream(live)
        else if (info?.kind === "thinking") pushStreamThinking(stream, live, text)
        else pushStreamText(stream, live, text)
        opts.onDelta?.(text, info)
      })
      pushStreamTextEnd(stream, live)
    } else {
      response = await opts.llm.complete(request)
    }
    usage = addUsage(usage, response.usage)
    const answered = toAssistantMessage(response, steps >= maxSteps)
    if (!compacting) {
      lastText = answered.text
      if (live === undefined) {
        if (response.thinking !== undefined && response.thinking !== "") {
          opts.onDelta?.(response.thinking, { kind: "thinking" })
        }
        if (answered.text !== "") opts.onDelta?.(answered.text)
      }
      session.appendAssistantMessage({
        text: answered.text,
        ...(answered.calls.length > 0 ? { toolCalls: answered.calls } : {}),
      })
      opts.onDelta?.("", { reset: true })
    }
    return { message: answered.message, live }
  }

  const answer = (context: TranscriptContext, signal: AbortSignal | undefined): AssistantMessageEventStream => {
    const stream = createAssistantMessageEventStream()
    void (async () => {
      let result: TurnAnswer
      try {
        result = await completeTurn(context, signal, stream)
      } catch (error) {
        const failed = recordFailure(error, session, inCompaction, (value) => {
          failure = value
        })
        stream.push({ type: "error", reason: "error", error: failed })
        stream.end(failed)
        return
      }
      if (result.live === undefined) replayAnswer(stream, result.message)
      else closeStream(stream, result.live, result.message)
      stream.push({
        type: "done",
        reason: result.message.stopReason as "stop" | "toolUse" | "length",
        message: result.message,
      })
      stream.end(result.message)
    })()
    return stream
  }

  const provider = createProvider({
    id: SDK_PROVIDER,
    name: SDK_PROVIDER,
    auth: { apiKey: { name: SDK_PROVIDER, resolve: async () => ({ auth: {} }) } },
    models: [model],
    api: { stream: (_requestModel, context, options) => answer(context, options?.signal), streamSimple: (_requestModel, context, options) => answer(context, options?.signal) },
  })

  const modelRuntime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false })
  modelRuntime.registerNativeProvider(provider)

  const sessionManager = SessionManager.inMemory(cwd)
  for (const item of history) seqByEntry.set(sessionManager.appendMessage(item.message), item.seq)

  const steering: { session?: AgentSession } = {}
  const customTools = buildSdkTools(opts, toolContext, session, {
    onCall: () => {
      toolCalls += 1
    },
    steer: (text) => {
      void steering.session?.steer(text)
    },
  })

  const created = await createAgentSession({
    cwd,
    agentDir: opts.agentDir ?? cwd,
    model,
    thinkingLevel: "off",
    modelRuntime,
    resourceLoader: loader,
    sessionManager,
    settingsManager,
    customTools,
    noTools: "all",
    tools: customTools.map((tool) => tool.name),
  })
  const agent = created.session
  steering.session = agent

  const unsubscribe = agent.subscribe((event) => {
    switch (event.type) {
      case "compaction_start":
        inCompaction = true
        break
      case "compaction_end":
        inCompaction = false
        if (event.result === undefined) break
        compacted = true
        recordCompaction(opts, session, event.result.summary, event.result.firstKeptEntryId, seqByEntry, windowStart)
        break
      default:
        break
    }
  })

  try {
    await agent.prompt(opts.input)
  } finally {
    unsubscribe()
    agent.dispose()
  }

  if (failure !== undefined) throw failure

  return {
    sessionId: opts.sessionId || session.sessionId,
    reply: lastText,
    steps,
    toolCalls,
    memoriesWritten,
    memoriesRecalled,
    compacted,
    usage,
  }
}

function recordCompaction(
  opts: DurableAgentRunOptions,
  session: SessionSink,
  summary: string,
  firstKeptEntryId: string | undefined,
  seqByEntry: Map<string, number>,
  windowStart: number,
): void {
  const firstKeptSeq = firstKeptEntryId === undefined ? undefined : seqByEntry.get(firstKeptEntryId)
  if (firstKeptSeq === undefined || firstKeptSeq <= windowStart) return
  const record: CompactionRecord = {
    summary,
    firstKeptSeq,
    fromSeq: windowStart,
    toSeq: firstKeptSeq - 1,
  }
  session.appendCompaction({ summary, firstKeptSeq })
  opts.onCompaction?.(record)
}

function recordFailure(
  error: unknown,
  session: SessionSink,
  inCompaction: boolean,
  save: (error: Error) => void,
): AssistantMessage {
  const detail = error instanceof Error ? error.message : String(error)
  const message = detail.startsWith("LLM request failed") ? detail : `LLM request failed: ${detail}`
  if (!inCompaction) {
    session.appendError({ message, fatal: true })
    save(new Error(message))
  }
  return {
    role: "assistant",
    content: [],
    api: SDK_PROVIDER,
    provider: SDK_PROVIDER,
    model: SDK_MODEL_ID,
    usage: zeroSdkUsage(),
    stopReason: "error",
    errorMessage: message,
    timestamp: Date.now(),
  }
}

interface TurnAnswer {
  message: AssistantMessage
  live: LiveAnswer | undefined
}

export interface LiveAnswer {
  partial: AssistantMessage
  textIndex: number
  text: string
  textOpen: boolean
  thinkingIndex: number
  thinking: string
  thinkingOpen: boolean
}

export function openStream(stream: AssistantMessageEventStream): LiveAnswer {
  const partial: AssistantMessage = {
    role: "assistant",
    content: [],
    api: SDK_PROVIDER,
    provider: SDK_PROVIDER,
    model: SDK_MODEL_ID,
    usage: zeroSdkUsage(),
    stopReason: "pending",
    timestamp: Date.now(),
  }
  stream.push({ type: "start", partial })
  return {
    partial,
    textIndex: -1,
    text: "",
    textOpen: false,
    thinkingIndex: -1,
    thinking: "",
    thinkingOpen: false,
  }
}

export function pushStreamThinking(stream: AssistantMessageEventStream, live: LiveAnswer, delta: string): void {
  if (delta === "") return
  closeText(stream, live)
  if (!live.thinkingOpen) {
    live.partial.content.push({ type: "thinking", thinking: "" })
    live.thinkingIndex = live.partial.content.length - 1
    live.thinking = ""
    live.thinkingOpen = true
    stream.push({ type: "thinking_start", contentIndex: live.thinkingIndex, partial: live.partial })
  }
  live.thinking += delta
  const block = live.partial.content[live.thinkingIndex]
  if (block !== undefined && block.type === "thinking") block.thinking = live.thinking
  stream.push({ type: "thinking_delta", contentIndex: live.thinkingIndex, delta, partial: live.partial })
}

export function pushStreamText(stream: AssistantMessageEventStream, live: LiveAnswer, delta: string): void {
  if (delta === "") return
  closeThinking(stream, live)
  if (!live.textOpen) {
    live.partial.content.push({ type: "text", text: "" })
    live.textIndex = live.partial.content.length - 1
    live.text = ""
    live.textOpen = true
    stream.push({ type: "text_start", contentIndex: live.textIndex, partial: live.partial })
  }
  live.text += delta
  const block = live.partial.content[live.textIndex]
  if (block !== undefined && block.type === "text") block.text = live.text
  stream.push({ type: "text_delta", contentIndex: live.textIndex, delta, partial: live.partial })
}

function closeThinking(stream: AssistantMessageEventStream, live: LiveAnswer): void {
  if (!live.thinkingOpen) return
  live.thinkingOpen = false
  if (live.thinking === "") {
    if (live.thinkingIndex === live.partial.content.length - 1) {
      live.partial.content.pop()
      live.thinkingIndex = -1
    }
    return
  }
  stream.push({ type: "thinking_end", contentIndex: live.thinkingIndex, content: live.thinking, partial: live.partial })
}

function closeText(stream: AssistantMessageEventStream, live: LiveAnswer): void {
  if (!live.textOpen) return
  live.textOpen = false
  stream.push({ type: "text_end", contentIndex: live.textIndex, content: live.text, partial: live.partial })
}

export function resetStream(live: LiveAnswer): void {
  live.text = ""
  const block = live.partial.content[live.textIndex]
  if (block !== undefined && block.type === "text") block.text = ""
  live.thinking = ""
  const thinkingBlock = live.partial.content[live.thinkingIndex]
  if (thinkingBlock !== undefined && thinkingBlock.type === "thinking") thinkingBlock.thinking = ""
}

export function pushStreamTextEnd(stream: AssistantMessageEventStream, live: LiveAnswer): void {
  closeThinking(stream, live)
  closeText(stream, live)
}

export function closeStream(stream: AssistantMessageEventStream, live: LiveAnswer, message: AssistantMessage): void {
  for (const block of message.content) {
    if (block.type !== "toolCall") continue
    live.partial.content.push(block)
    const contentIndex = live.partial.content.length - 1
    stream.push({ type: "toolcall_start", contentIndex, partial: live.partial })
    stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: live.partial })
  }
}

function replayAnswer(stream: AssistantMessageEventStream, message: AssistantMessage): void {
  const partial: AssistantMessage = { ...message, content: [], stopReason: "pending" }
  stream.push({ type: "start", partial })
  for (let index = 0; index < message.content.length; index += 1) {
    const block = message.content[index]
    if (block === undefined) continue
    if (block.type === "text") {
      partial.content = [...partial.content, { type: "text", text: "" }]
      stream.push({ type: "text_start", contentIndex: index, partial })
      partial.content[index] = { type: "text", text: block.text }
      stream.push({ type: "text_delta", contentIndex: index, delta: block.text, partial })
      stream.push({ type: "text_end", contentIndex: index, content: block.text, partial })
      continue
    }
    if (block.type === "toolCall") {
      partial.content = [
        ...partial.content,
        { type: "toolCall", id: block.id, name: block.name, arguments: block.arguments },
      ]
      stream.push({ type: "toolcall_start", contentIndex: index, partial })
      stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial })
    }
  }
}

function toAssistantMessage(response: LlmResponse, limited: boolean): { text: string; calls: ToolCall[]; message: AssistantMessage } {
  const calls: ToolCall[] = response.toolCalls.map((call) => ({ callId: call.callId, name: call.name, args: call.args }))
  const keepCalls = calls.length > 0 && !limited
  const text = limited && calls.length > 0 ? `${response.text}${response.text ? "\n\n" : ""}${STEP_LIMIT_NOTE}` : response.text
  const content: AssistantMessage["content"] = []
  if (text !== "") content.push({ type: "text", text })
  if (keepCalls) {
    for (const call of calls) {
    content.push({ type: "toolCall", id: call.callId, name: call.name, arguments: call.args as JsonObject })
  }
  }
  const message: AssistantMessage = {
    role: "assistant",
    content,
    api: SDK_PROVIDER,
    provider: SDK_PROVIDER,
    model: SDK_MODEL_ID,
    usage: sdkUsage(response.usage),
    stopReason: keepCalls ? "toolUse" : response.finishReason === "length" ? "length" : "stop",
    timestamp: Date.now(),
  }
  return { text, calls: keepCalls ? calls : [], message }
}

function buildSdkTools(
  opts: DurableAgentRunOptions,
  toolContext: ToolContext,
  session: SessionSink,
  hooks: { onCall: () => void; steer: (text: string) => void },
): ToolDefinition[] {
  return opts.tools
    .filter((tool) => !tool.hidden)
    .map((tool) => ({
      name: tool.name,
      label: tool.name,
      description: tool.description,
      parameters: relaxSchema(tool.parameters) as never,
      executionMode: "sequential" as const,
      execute: async (toolCallId: string, params: never) => {
        const args = (params ?? {}) as Record<string, unknown>
        const call: ToolCall = { callId: toolCallId, name: tool.name, args }
        hooks.onCall()
        opts.onProgress?.(`tool ${tool.name}`)
        session.appendToolCall(call)
        const after = session.events().length
        let result: ToolResult
        try {
          result = await executeTool(tool, args, toolContext)
        } catch (error) {
          result = { ok: false, output: error instanceof Error ? error.message : String(error) }
        }
        session.appendToolResult({ callId: toolCallId, name: tool.name, ok: result.ok, output: result.output })
        for (const event of session.events().slice(after)) {
          if (event.type === "user_message") hooks.steer(event.data.text)
        }
        return {
          content: [{ type: "text" as const, text: result.output }],
          details: {},
          ...(result.ok ? {} : { isError: true }),
        }
      },
    }))
}

function relaxSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const relaxed: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(schema)) {
    if (key === "additionalProperties") continue
    if (Array.isArray(value)) {
      relaxed[key] = value.map((item) => (isRecord(item) ? relaxSchema(item) : item))
      continue
    }
    relaxed[key] = isRecord(value) ? relaxSchema(value) : value
  }
  return relaxed
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function buildHistory(events: SessionEvent[]): { message: Message; seq: number }[] {
  const start = windowOf(events)
  const history: { message: Message; seq: number }[] = []
  for (const event of events) {
    if (event.seq < start) continue
    if (event.type === "user_message") {
      history.push({ message: userMessage(event.data.text), seq: event.seq })
      continue
    }
    if (event.type === "assistant_message") {
      history.push({ message: assistantFromLog(event.data.text, event.data.toolCalls ?? []), seq: event.seq })
      continue
    }
    if (event.type === "tool_result") {
      history.push({
        message: toolResultMessage(event.data.callId, event.data.name, event.data.output, event.data.ok),
        seq: event.seq,
      })
    }
  }
  return history
}

function windowOf(events: SessionEvent[]): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined || event.type !== "compaction") continue
    const firstKeptSeq = event.data.firstKeptSeq
    return Math.max(0, Math.min(firstKeptSeq, event.seq + 1))
  }
  return 0
}

function userMessage(text: string): Message {
  return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() }
}

function toolResultMessage(callId: string, name: string, output: string, ok: boolean): Message {
  return {
    role: "toolResult",
    toolCallId: callId,
    toolName: name,
    content: [{ type: "text", text: output }],
    isError: !ok,
    timestamp: Date.now(),
  }
}

function assistantFromLog(text: string, calls: ToolCall[]): AssistantMessage {
  const content: AssistantMessage["content"] = []
  if (text !== "") content.push({ type: "text", text })
  for (const call of calls) {
    content.push({ type: "toolCall", id: call.callId, name: call.name, arguments: call.args as JsonObject })
  }
  return {
    role: "assistant",
    content,
    api: SDK_PROVIDER,
    provider: SDK_PROVIDER,
    model: SDK_MODEL_ID,
    usage: zeroSdkUsage(),
    stopReason: calls.length > 0 ? "toolUse" : "stop",
    timestamp: Date.now(),
  }
}

function toWire(messages: readonly Message[]): LlmMessage[] {
  const systems: string[] = []
  const wire: LlmMessage[] = []
  for (const message of messages) {
    if (message.role === "system") {
      const text = getSystemMessageText(message)
      if (text !== "") systems.push(text)
      continue
    }
    if (message.role === "user") {
      wire.push({
        role: "user",
        content: typeof message.content === "string" ? message.content : toParts(message.content),
      })
      continue
    }
    if (message.role === "assistant") {
      let text = ""
      const calls: LlmToolCall[] = []
      for (const block of message.content) {
        if (block.type === "text") text += block.text
        if (block.type === "toolCall") {
          calls.push({ callId: block.id, name: block.name, args: block.arguments as Record<string, unknown> })
        }
      }
      wire.push({ role: "assistant", content: text, ...(calls.length > 0 ? { toolCalls: calls } : {}) })
      continue
    }
    const content = toParts(message.content)
    wire.push({
      role: "tool",
      content: typeof content === "string" ? content : contentTextOf(content),
      toolCallId: message.toolCallId,
    })
  }
  if (systems.length > 0) wire.unshift({ role: "system", content: systems.join("\n\n") })
  return wire
}

function contentTextOf(parts: LlmContentPart[]): string {
  return parts
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n")
}

function toParts(content: readonly { type: string; text?: string; data?: string; mimeType?: string }[]): string | LlmContentPart[] {
  const parts: LlmContentPart[] = []
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") {
      parts.push({ type: "text", text: block.text })
      continue
    }
    if (block.type === "image" && typeof block.data === "string") {
      parts.push({ type: "image", mimeType: block.mimeType ?? "image/png", dataBase64: block.data })
    }
  }
  const only = parts[0]
  if (parts.length === 1 && only !== undefined && only.type === "text") return only.text
  return parts
}

function recallInto(opts: DurableAgentRunOptions, session: SessionSink, recalled: string[]): string {
  const memory = opts.memory
  if (memory === undefined) return ""
  try {
    const hits = memory.recall({ text: opts.input, limit: opts.maxRecall ?? DEFAULT_MAX_RECALL })
    const selected = capMemories(hits, opts.maxRecall ?? DEFAULT_MAX_RECALL, opts.maxMemoryChars ?? DEFAULT_MAX_MEMORY_CHARS)
    const ids = selected.map((hit) => hit.entry.id)
    recalled.push(...ids)
    session.appendMemoryRecall({ memoryIds: ids, query: opts.input })
    return renderMemories(selected)
  } catch (error) {
    session.appendError({ message: `memory recall failed: ${errorMessage(error)}`, fatal: false })
    session.appendMemoryRecall({ memoryIds: [], query: opts.input })
    return ""
  }
}

function buildToolContext(
  opts: DurableAgentRunOptions,
  session: SessionSink,
  written: string[],
  recalled: string[],
): ToolContext {
  const context: ToolContext = {
    cwd: opts.cwd ?? process.cwd(),
    allowBash: opts.allowBash === true,
    timeoutMs: TOOL_TIMEOUT_MS,
    maxOutputChars: TOOL_OUTPUT_CHARS,
  }
  const memory = opts.memory
  if (memory === undefined) return context
  context.remember = (input) => {
    const entry = memory.remember(input)
    written.push(entry.id)
    session.appendMemoryWrite({ memoryId: entry.id, kind: entry.kind, text: entry.text })
    return entry
  }
  context.recall = (query) => {
    const hits = memory.recall(query)
    const ids = hits.map((hit) => hit.entry.id)
    recalled.push(...ids)
    session.appendMemoryRecall({ memoryIds: ids, query: query.text })
    return hits
  }
  return context
}

function failDanglingCalls(session: SessionSink): void {
  const events = session.events()
  const answered = new Set(events.filter((event) => event.type === "tool_result").map((event) => event.data.callId))
  const seen = new Set<string>()
  const fail = (callId: string, name: string): void => {
    if (answered.has(callId) || seen.has(callId)) return
    seen.add(callId)
    session.appendToolResult({
      callId,
      name,
      ok: false,
      output: "Interrupted before tool completion; not re-executed to avoid repeating side effects.",
    })
  }
  for (const event of events) {
    if (event.type === "tool_call") {
      fail(event.data.callId, event.data.name)
      continue
    }
    if (event.type !== "assistant_message") continue
    for (const call of event.data.toolCalls ?? []) fail(call.callId, call.name)
  }
}

function sdkModel(): Model<string> {
  return {
    id: SDK_MODEL_ID,
    name: SDK_PROVIDER,
    api: SDK_PROVIDER,
    provider: SDK_PROVIDER,
    baseUrl: "http://127.0.0.1",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: SDK_CONTEXT_WINDOW,
    maxTokens: SDK_MAX_TOKENS,
  }
}

function zeroSdkUsage(): Usage {
  return {
    input: 0,
    output: 0,
    totalTokens: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

function sdkUsage(usage: LlmUsage): Usage {
  return {
    input: usage.promptTokens,
    output: usage.completionTokens,
    totalTokens: usage.totalTokens,
    cacheRead: 0,
    cacheWrite: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

function capMemories(hits: MemoryHit[], maxRecall: number, maxChars: number): MemoryHit[] {
  const selected: MemoryHit[] = []
  let chars = 0
  const limit = positiveInteger(maxRecall, DEFAULT_MAX_RECALL)
  const charLimit = positiveInteger(maxChars, DEFAULT_MAX_MEMORY_CHARS)
  for (const hit of hits.slice(0, limit)) {
    const size = hit.entry.text.length
    if (chars + size > charLimit) continue
    selected.push(hit)
    chars += size
  }
  return selected
}

function renderMemories(hits: MemoryHit[]): string {
  if (!hits.length) return ""
  return `Recalled memory:\n${hits.map(({ entry }) => `- [${entry.kind}; ${entry.id}] ${entry.text}`).join("\n")}`
}

function addUsage(left: LlmUsage, right: LlmUsage): LlmUsage {
  return {
    promptTokens: left.promptTokens + right.promptTokens,
    completionTokens: left.completionTokens + right.completionTokens,
    totalTokens: left.totalTokens + right.totalTokens,
  }
}

function zeroUsage(): LlmUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
}

function positiveInteger(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

function environmentMaxSteps(): number | undefined {
  const raw = process.env.PI_DURABLE_MAX_STEPS
  if (!raw) return undefined
  const value = Number.parseInt(raw, 10)
  return Number.isInteger(value) && value > 0 ? value : undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function asAgentMemory(store: MemoryStore): AgentMemory {
  return {
    remember: (input) => store.add(input),
    recall: (query) => store.search(query),
  }
}
