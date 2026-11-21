import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type {
  LlmClient,
  LlmCompleteRequest,
  LlmContentPart,
  LlmDelta,
  LlmMessage,
  LlmResponse,
  LlmToolCall,
  LlmToolSpec,
  LlmUsage,
} from "./types.ts"

export const DEFAULT_LLM_MODEL = "workbuddy/hy4-preview-ioa"
export const DEFAULT_LLM_BASE_URL = "http://localhost:3425/v1"
export const DEFAULT_MAX_TOKENS = 2048

export interface ResolveApiKeyOptions {
  env?: NodeJS.ProcessEnv
  authPath?: string
}

export function resolveApiKey(options: ResolveApiKeyOptions = {}): string | undefined {
  const env = options.env ?? process.env
  const environmentKey = env.PI_DURABLE_API_KEY
  if (environmentKey) return environmentKey

  const authPath = options.authPath ?? join(homedir(), ".pi", "agent", "auth.json")
  try {
    const auth = JSON.parse(readFileSync(authPath, "utf8")) as {
      [key: string]: unknown
    }
    const endpoint = auth["any-endpoint"]
    if (typeof endpoint !== "object" || endpoint === null) return undefined
    const access = (endpoint as Record<string, unknown>).access
    return typeof access === "string" && access.length > 0 ? access : undefined
  } catch {
    return undefined
  }
}

export interface ChatCompletionsClientOptions {
  baseUrl?: string
  model?: string

  apiKey?: string

  fetch?: typeof fetch

  sleep?: (milliseconds: number) => Promise<void>

  attempts?: number

  baseDelayMs?: number

  random?: () => number
  env?: NodeJS.ProcessEnv
  authPath?: string

  reasoningEffort?: string

  maxTokens?: number
}

const REASONING_EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const

const STREAM_DONE = "[DONE]"

function normalizeEffort(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const effort = value.trim().toLowerCase()
  if (effort === "") return undefined
  if (!(REASONING_EFFORTS as readonly string[]).includes(effort)) {
    throw new Error(`Invalid reasoning effort "${value}": expected one of ${REASONING_EFFORTS.join(", ")}`)
  }
  return effort
}

export function createChatCompletionsClient(
  opts: ChatCompletionsClientOptions = {},
): LlmClient {
  const env = opts.env ?? process.env
  const model = opts.model ?? env.PI_DURABLE_MODEL ?? DEFAULT_LLM_MODEL
  const baseUrl = (opts.baseUrl ?? env.PI_DURABLE_BASE_URL ?? DEFAULT_LLM_BASE_URL).replace(/\/+$/, "")
  const apiKey = opts.apiKey ?? resolveApiKey({ env, authPath: opts.authPath })
  if (!apiKey) {
    throw new Error("Missing API key: set PI_DURABLE_API_KEY or configure auth.json")
  }

  const fetchImpl = opts.fetch ?? fetch
  const attempts = normalizeAttempts(opts.attempts ?? 3)
  const baseDelayMs = Math.max(0, opts.baseDelayMs ?? 500)
  const sleep = opts.sleep ?? delay
  const random = opts.random ?? Math.random
  const reasoningEffort = normalizeEffort(opts.reasoningEffort ?? env.PI_DURABLE_REASONING_EFFORT)
  const defaultMaxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS

  return {
    model,
    async complete(req: LlmCompleteRequest): Promise<LlmResponse> {
      const body = toRequestBody(model, req, reasoningEffort, defaultMaxTokens)
      let lastError: Error | undefined

      for (let attempt = 1; attempt <= attempts; attempt++) {
        let response: Response | undefined
        try {
          response = await fetchImpl(`${baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${apiKey}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(body),
            signal: req.signal,
          })
        } catch {
          if (req.signal?.aborted) throw new Error("LLM request aborted")

          lastError = new Error("LLM network request failed")
        }

        if (response !== undefined) {
          if (!response.ok) {
            if (!isRetryableStatus(response.status)) {
              throw new Error(`LLM request failed with HTTP ${response.status}`)
            }
            lastError = new Error(`LLM request failed with HTTP ${response.status}`)
          } else {
            let payload: unknown
            try {
              payload = await response.json()
            } catch {

              lastError = new Error("Invalid LLM response: malformed JSON")
            }
            if (payload !== undefined) return parseResponse(payload)
          }
        }

        if (attempt < attempts) await waitBeforeRetry(attempt, baseDelayMs, random, sleep)
      }

      throw new Error(`LLM request failed after ${attempts} attempts: ${lastError?.message ?? "unknown error"}`)
    },
    async completeStream(req: LlmCompleteRequest, onDelta: LlmDelta): Promise<LlmResponse> {
      const body: ChatCompletionRequestBody = {
        ...toRequestBody(model, req, reasoningEffort, defaultMaxTokens),
        stream: true,
      }
      let lastError: Error | undefined

      for (let attempt = 1; attempt <= attempts; attempt++) {
        if (attempt > 1) onDelta("", { reset: true })
        let response: Response | undefined
        try {
          response = await fetchImpl(`${baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${apiKey}`,
              "content-type": "application/json",
              accept: "text/event-stream",
            },
            body: JSON.stringify(body),
            signal: req.signal,
          })
        } catch {
          if (req.signal?.aborted) throw new Error("LLM request aborted")

          lastError = new Error("LLM network request failed")
        }

        if (response !== undefined) {
          if (!response.ok) {
            if (!isRetryableStatus(response.status)) {
              throw new Error(`LLM request failed with HTTP ${response.status}`)
            }
            lastError = new Error(`LLM request failed with HTTP ${response.status}`)
          } else {
            try {
              return await readStreamResponse(response, onDelta)
            } catch (error) {
              if (req.signal?.aborted) throw new Error("LLM request aborted")
              lastError = error instanceof Error ? error : new Error(String(error))
            }
          }
        }

        if (attempt < attempts) await waitBeforeRetry(attempt, baseDelayMs, random, sleep)
      }

      throw new Error(`LLM request failed after ${attempts} attempts: ${lastError?.message ?? "unknown error"}`)
    },
  }
}

interface ChatCompletionRequestBody {
  model: string
  messages: Record<string, unknown>[]
  max_tokens: number
  temperature?: number
  tools?: Record<string, unknown>[]
  reasoning_effort?: string
  stream?: boolean
}

function toRequestBody(
  model: string,
  req: LlmCompleteRequest,
  reasoningEffort?: string,
  defaultMaxTokens: number = DEFAULT_MAX_TOKENS,
): ChatCompletionRequestBody {
  const body: ChatCompletionRequestBody = {
    model,
    messages: req.messages.map(toProviderMessage),
    max_tokens: req.maxTokens ?? defaultMaxTokens,
  }
  if (req.temperature !== undefined) body.temperature = req.temperature
  if (req.tools !== undefined) body.tools = req.tools.map(toProviderTool)
  if (reasoningEffort !== undefined) body.reasoning_effort = reasoningEffort
  return body
}

function toProviderMessage(message: LlmMessage): Record<string, unknown> {
  const result: Record<string, unknown> = { role: message.role, content: toProviderContent(message.content) }
  if (message.toolCallId !== undefined) result.tool_call_id = message.toolCallId
  if (message.name !== undefined) result.name = message.name
  if (message.toolCalls !== undefined) {
    result.tool_calls = message.toolCalls.map((call) => ({
      id: call.callId,
      type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.args) },
    }))
  }
  return result
}

function toProviderContent(content: string | LlmContentPart[]): string | Record<string, unknown>[] {
  if (typeof content === "string") return content
  return content.map((part) =>
    part.type === "text"
      ? { type: "text", text: part.text }
      : { type: "image_url", image_url: { url: `data:${part.mimeType};base64,${part.dataBase64}` } },
  )
}

function toProviderTool(tool: LlmToolSpec): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }
}

function parseResponse(payload: unknown): LlmResponse {
  if (typeof payload !== "object" || payload === null) {
    throw new Error("Invalid LLM response")
  }
  const response = payload as Record<string, unknown>
  const firstChoice = Array.isArray(response.choices) ? response.choices[0] : undefined
  if (typeof firstChoice !== "object" || firstChoice === null) {
    throw new Error("Invalid LLM response: missing choice")
  }
  const choice = firstChoice as Record<string, unknown>
  const rawMessage = choice.message
  if (typeof rawMessage !== "object" || rawMessage === null) {
    throw new Error("Invalid LLM response: missing message")
  }
  const message = rawMessage as Record<string, unknown>
  const usage = parseUsage(response.usage)
  const toolCalls = Array.isArray(message.tool_calls)
    ? message.tool_calls.map(parseToolCall)
    : []
  return {
    text: completionText(message.content),
    toolCalls,
    usage,
    finishReason: typeof choice.finish_reason === "string" ? choice.finish_reason : "unknown",
  }
}

function completionText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .filter((part): part is { text: string } =>
      typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string",
    )
    .map((part) => part.text)
    .join("")
}

function parseToolCall(value: unknown): LlmToolCall {
  if (typeof value !== "object" || value === null) {
    return { callId: "", name: "", args: {} }
  }
  const call = value as Record<string, unknown>
  const fn = typeof call.function === "object" && call.function !== null
    ? call.function as Record<string, unknown>
    : {}
  return {
    callId: typeof call.id === "string" ? call.id : "",
    name: typeof fn.name === "string" ? fn.name : "",
    args: parseToolArguments(fn.arguments),
  }
}

function parseToolArguments(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {}
  try {
    const parsed: unknown = JSON.parse(value)
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function parseUsage(value: unknown): LlmUsage {
  if (typeof value !== "object" || value === null) {
    return { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
  }
  const usage = value as Record<string, unknown>
  const promptTokens = finiteNumber(usage.prompt_tokens)
  const completionTokens = finiteNumber(usage.completion_tokens)
  return {
    promptTokens,
    completionTokens,
    totalTokens: finiteNumber(usage.total_tokens, promptTokens + completionTokens),
  }
}

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600)
}

interface StreamState {
  text: string
  toolCalls: Map<number, { id: string; name: string; arguments: string }>
  usage: LlmUsage | undefined
  finishReason: string | undefined
  done: boolean
}

async function readStreamResponse(response: Response, onDelta: LlmDelta): Promise<LlmResponse> {
  const contentType = response.headers.get("content-type") ?? ""
  if (!contentType.includes("text/event-stream")) return await readWholeResponse(response, onDelta)
  const reader = response.body?.getReader()
  if (reader === undefined) throw new Error("Invalid LLM response: missing stream")
  const decoder = new TextDecoder()
  const state: StreamState = { text: "", toolCalls: new Map(), usage: undefined, finishReason: undefined, done: false }
  let buffer = ""
  while (!state.done) {
    const chunk = await reader.read()
    if (chunk.done) break
    buffer += decoder.decode(chunk.value, { stream: true })
    let cut = buffer.indexOf("\n")
    while (cut >= 0) {
      const line = buffer.slice(0, cut)
      buffer = buffer.slice(cut + 1)
      if (readStreamLine(line, state, onDelta)) break
      cut = buffer.indexOf("\n")
    }
  }
  if (!state.done && buffer !== "") readStreamLine(buffer, state, onDelta)
  if (state.done) {
    try {
      await reader.cancel()
    } catch {

    }
  }
  if (!state.done && state.finishReason === undefined) {
    throw new Error("LLM stream ended before the completion finished")
  }
  const toolCalls = [...state.toolCalls.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([, call]) => ({ callId: call.id, name: call.name, args: parseToolArguments(call.arguments) }))
  return {
    text: state.text,
    toolCalls,
    usage: state.usage ?? parseUsage(undefined),
    finishReason: state.finishReason ?? "unknown",
  }
}

async function readWholeResponse(response: Response, onDelta: LlmDelta): Promise<LlmResponse> {
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new Error("Invalid LLM response: malformed JSON")
  }
  const parsed = parseResponse(payload)
  if (parsed.text !== "") onDelta(parsed.text)
  return parsed
}

function readStreamLine(raw: string, state: StreamState, onDelta: LlmDelta): boolean {
  const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw
  if (line === "" || line.startsWith(":")) return false
  if (!line.startsWith("data:")) return false
  const data = line.slice(5).trim()
  if (data === "") return false
  if (data === STREAM_DONE) {
    state.done = true
    return true
  }
  let payload: unknown
  try {
    payload = JSON.parse(data)
  } catch {
    throw new Error("Invalid LLM response: malformed JSON")
  }
  applyStreamChunk(payload, state, onDelta)
  return false
}

function applyStreamChunk(payload: unknown, state: StreamState, onDelta: LlmDelta): void {
  if (!isRecord(payload)) throw new Error("Invalid LLM response: malformed chunk")
  if (isRecord(payload.usage)) state.usage = parseUsage(payload.usage)
  const choice = Array.isArray(payload.choices) ? payload.choices[0] : undefined
  if (!isRecord(choice)) return
  if (typeof choice.finish_reason === "string" && choice.finish_reason !== "") {
    state.finishReason = choice.finish_reason
  }
  if (!isRecord(choice.delta)) return
  const content = choice.delta.content
  if (typeof content === "string" && content !== "") {
    state.text += content
    onDelta(content)
  }
  if (!Array.isArray(choice.delta.tool_calls)) return
  for (const fragment of choice.delta.tool_calls) mergeToolCallFragment(fragment, state)
}

function mergeToolCallFragment(fragment: unknown, state: StreamState): void {
  if (!isRecord(fragment)) return
  const index = typeof fragment.index === "number" && Number.isFinite(fragment.index)
    ? Math.floor(fragment.index)
    : state.toolCalls.size
  const call = state.toolCalls.get(index) ?? { id: "", name: "", arguments: "" }
  const fn = isRecord(fragment.function) ? fragment.function : {}
  call.id = mergeFragment(call.id, typeof fragment.id === "string" ? fragment.id : "")
  call.name = mergeFragment(call.name, typeof fn.name === "string" ? fn.name : "")
  if (typeof fn.arguments === "string") call.arguments += fn.arguments
  state.toolCalls.set(index, call)
}

function mergeFragment(current: string, incoming: string): string {
  if (incoming === "") return current
  if (current === "") return incoming
  if (current === incoming || current.endsWith(incoming)) return current
  return current + incoming
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function waitBeforeRetry(
  attempt: number,
  baseDelayMs: number,
  random: () => number,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<void> {
  const randomValue = Math.min(1, Math.max(0, random()))
  const backoff = baseDelayMs * 2 ** (attempt - 1)
  await sleep(backoff * (0.5 + randomValue))
}

function normalizeAttempts(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 3
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
}
