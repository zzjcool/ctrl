import assert from "node:assert/strict"
import { test } from "node:test"
import type { LlmClient, LlmDelta } from "../../src/engine/durable.ts"
import { createChatCompletionsClient } from "../../src/engine/llm.ts"

interface Harness {
  client: LlmClient
  bodies: Record<string, unknown>[]
  calls: number
}

function harness(responses: Array<Response | (() => Response)>): Harness {
  const bodies: Record<string, unknown>[] = []
  const queue = [...responses]
  const state = { calls: 0 }
  const fetchImpl = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    void input
    state.calls += 1
    if (init?.body !== undefined) bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>)
    const next = queue.shift()
    if (next === undefined) throw new Error("fake fetch ran out of responses")
    return typeof next === "function" ? next() : next
  }
  const client = createChatCompletionsClient({
    baseUrl: "http://fake.local/v1",
    model: "fake-model",
    apiKey: "test-key",
    fetch: fetchImpl,
    sleep: async () => {},
    random: () => 0.5,
    attempts: 3,
    baseDelayMs: 1,
  })
  return {
    client,
    bodies,
    get calls() {
      return state.calls
    },
  }
}

function sse(chunks: string[]): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
}

function dropped(chunks: string[]): Response {
  return sse(chunks)
}

function dataLine(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

function textChunk(content: string, finishReason?: string): string {
  return dataLine({
    choices: [
      { index: 0, delta: { content }, ...(finishReason === undefined ? {} : { finish_reason: finishReason }) },
    ],
  })
}

function toolChunk(toolCalls: unknown[], finishReason?: string): string {
  return dataLine({
    choices: [
      { index: 0, delta: { tool_calls: toolCalls }, ...(finishReason === undefined ? {} : { finish_reason: finishReason }) },
    ],
  })
}

function usageChunk(usage: Record<string, number>): string {
  return dataLine({ choices: [], usage })
}

const DONE = "data: [DONE]\n\n"

const REQUEST = { messages: [{ role: "user" as const, content: "hi" }] }

function collector(): { deltas: string[]; resets: number; onDelta: LlmDelta; text: () => string } {
  const deltas: string[] = []
  const state = { resets: 0, buffer: "" }
  const onDelta: LlmDelta = (text, info) => {
    if (info?.reset === true) {
      state.resets += 1
      state.buffer = ""
      deltas.push("")
      return
    }
    state.buffer += text
    deltas.push(text)
  }
  return {
    deltas,
    get resets() {
      return state.resets
    },
    onDelta,
    text: () => state.buffer,
  }
}

test("text deltas stream out in order and the final response matches the accumulated text", async () => {
  const fake = harness([
    sse([
      textChunk("Hello"),
      textChunk(", "),
      textChunk("streamed world"),
      textChunk("", "stop"),
      DONE,
    ]),
  ])
  const sink = collector()
  const response = await fake.client.completeStream!(REQUEST, sink.onDelta)

  assert.deepEqual(sink.deltas, ["Hello", ", ", "streamed world"])
  assert.equal(sink.text(), "Hello, streamed world")
  assert.equal(response.text, "Hello, streamed world")
  assert.equal(response.finishReason, "stop")
  assert.deepEqual(response.toolCalls, [])
  assert.deepEqual(fake.bodies[0]?.stream, true, "the request asks the gateway to stream")
})

test("a data line split across network chunks is buffered until it is complete", async () => {
  const payload = textChunk("split over chunks")
  const first = payload.slice(0, 18)
  const second = payload.slice(18)
  const fake = harness([sse([first, second, textChunk("", "stop"), DONE])])
  const sink = collector()
  const response = await fake.client.completeStream!(REQUEST, sink.onDelta)

  assert.equal(response.text, "split over chunks")
  assert.deepEqual(sink.deltas, ["split over chunks"])
})

test("tool call fragments are stitched per index into the non-streaming response shape", async () => {
  const fake = harness([
    sse([
      toolChunk([
        { index: 0, id: "call_a", type: "function", function: { name: "recall", arguments: "" } },
        { index: 1, id: "call_b", type: "function", function: { name: "focus_set", arguments: "" } },
      ]),
      toolChunk([{ index: 0, function: { arguments: '{"text"' } }]),
      toolChunk([{ index: 1, function: { arguments: '{"text":"plan"' } }]),
      toolChunk([{ index: 0, function: { arguments: ':"hi"}' } }]),
      toolChunk([{ index: 1, function: { arguments: "}" } }], "tool_calls"),
      DONE,
    ]),
  ])
  const sink = collector()
  const response = await fake.client.completeStream!(REQUEST, sink.onDelta)

  assert.equal(response.text, "")
  assert.deepEqual(response.toolCalls, [
    { callId: "call_a", name: "recall", args: { text: "hi" } },
    { callId: "call_b", name: "focus_set", args: { text: "plan" } },
  ])
  assert.equal(response.finishReason, "tool_calls")
})

test("heartbeat comments are ignored and usage is read from the last chunk", async () => {
  const fake = harness([
    sse([
      ": heartbeat\n\n",
      textChunk("part one "),
      ": heartbeat\n\n",
      textChunk("part two", "stop"),
      usageChunk({ prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }),
      DONE,
    ]),
  ])
  const sink = collector()
  const response = await fake.client.completeStream!(REQUEST, sink.onDelta)

  assert.equal(response.text, "part one part two")
  assert.deepEqual(response.usage, { promptTokens: 11, completionTokens: 7, totalTokens: 18 })
  assert.deepEqual(sink.deltas, ["part one ", "part two"])
})

test("[DONE] ends the stream and nothing after it is parsed", async () => {
  const fake = harness([sse([textChunk("kept", "stop"), DONE, textChunk("ignored"), ": heartbeat\n\n"])])
  const sink = collector()
  const response = await fake.client.completeStream!(REQUEST, sink.onDelta)

  assert.equal(response.text, "kept")
  assert.deepEqual(sink.deltas, ["kept"])
})

test("a stream that dies mid answer is retried once and never repeats the text it dropped", async () => {
  const fake = harness([
    dropped([textChunk("half an ans"), textChunk("wer")]),
    sse([textChunk("complete answer"), textChunk("", "stop"), DONE]),
  ])
  const sink = collector()
  const response = await fake.client.completeStream!(REQUEST, sink.onDelta)

  assert.equal(fake.calls, 2, "a truncated stream is retried")
  assert.equal(response.text, "complete answer")
  assert.equal(sink.text(), "complete answer", "the half answer must not be appended again")
  assert.equal(sink.deltas[0], "half an ans")
  assert.equal(sink.resets, 1, "the consumer is told to drop what it already showed")
  assert.deepEqual(sink.deltas.slice(-1), ["complete answer"])
})

test("a retryable HTTP failure is retried and a permanent one is not", async () => {
  const retried = harness([
    new Response("nope", { status: 503 }),
    sse([textChunk("after retry", "stop"), DONE]),
  ])
  const sink = collector()
  const response = await retried.client.completeStream!(REQUEST, sink.onDelta)
  assert.equal(retried.calls, 2)
  assert.equal(response.text, "after retry")

  const permanent = harness([new Response("bad", { status: 400 })])
  await assert.rejects(
    () => permanent.client.completeStream!(REQUEST, collector().onDelta),
    /HTTP 400/,
  )
  assert.equal(permanent.calls, 1)
})

test("a gateway that answers with plain JSON is folded into one delta", async () => {
  const payload = {
    choices: [{ index: 0, message: { role: "assistant", content: "whole answer" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
  }
  const fake = harness([new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } })])
  const sink = collector()
  const response = await fake.client.completeStream!(REQUEST, sink.onDelta)

  assert.equal(response.text, "whole answer")
  assert.deepEqual(response.usage, { promptTokens: 3, completionTokens: 4, totalTokens: 7 })
  assert.deepEqual(sink.deltas, ["whole answer"])
})

test("the non streaming path is untouched and still returns one whole response", async () => {
  const payload = {
    choices: [{ index: 0, message: { role: "assistant", content: "one shot" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
  }
  const fake = harness([new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } })])
  const response = await fake.client.complete(REQUEST)

  assert.equal(response.text, "one shot")
  assert.equal(fake.bodies[0]?.stream, undefined, "the non streaming request does not ask for a stream")
})
