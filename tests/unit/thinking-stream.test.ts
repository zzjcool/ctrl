import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import type { LlmClient, LlmDelta } from "../../src/engine/durable.ts"
import { createChatCompletionsClient } from "../../src/engine/llm.ts"

interface Harness {
  client: LlmClient
  calls: number
}

function harness(responses: Array<Response | (() => Response)>): Harness {
  const queue = [...responses]
  const state = { calls: 0 }
  const fetchImpl = async (_input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    state.calls += 1
    if (init?.body === undefined) throw new Error("the fake gateway expects a request body")
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

function sseFixture(name: string): Response {
  const text = readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")
  return sse(text.split("\n").map((line) => `${line}\n`))
}

const REQUEST = { messages: [{ role: "user" as const, content: "hi" }] }

interface Sink {
  events: Array<{ text: string; kind: "text" | "thinking" }>
  resets: number
  onDelta: LlmDelta
  text: () => string
  thinking: () => string
  kinds: () => string[]
}

function collector(): Sink {
  const events: Array<{ text: string; kind: "text" | "thinking" }> = []
  const state = { resets: 0 }
  const onDelta: LlmDelta = (text, info) => {
    if (info?.reset === true) {
      state.resets += 1
      events.length = 0
      return
    }
    events.push({ text, kind: info?.kind === "thinking" ? "thinking" : "text" })
  }
  return {
    events,
    get resets() {
      return state.resets
    },
    onDelta,
    text: () => events.filter((event) => event.kind === "text").map((event) => event.text).join(""),
    thinking: () => events.filter((event) => event.kind === "thinking").map((event) => event.text).join(""),
    kinds: () => events.map((event) => event.kind),
  }
}

test("reasoning_content streams out as thinking deltas and never leaks into the answer", async () => {
  const fake = harness([sseFixture("thinking-stream.sse")])
  const sink = collector()
  const response = await fake.client.completeStream!(REQUEST, sink.onDelta)

  assert.equal(sink.thinking(), "先算一下： 2 + 3 = 5。")
  assert.equal(sink.text(), "答案是 5。")
  assert.deepEqual(sink.kinds(), ["thinking", "thinking", "text", "text"])
  assert.equal(response.text, "答案是 5。")
  assert.equal(response.thinking, "先算一下： 2 + 3 = 5。")
  assert.equal(response.finishReason, "stop")
})

test("a stream without reasoning_content emits zero thinking deltas", async () => {
  const fake = harness([sseFixture("no-thinking-stream.sse")])
  const sink = collector()
  const response = await fake.client.completeStream!(REQUEST, sink.onDelta)

  assert.deepEqual(sink.kinds(), ["text", "text"])
  assert.equal(sink.thinking(), "")
  assert.equal(sink.events.some((event) => event.kind === "thinking"), false)
  assert.equal(sink.text(), "纯正文，没有思考。")
  assert.equal(response.text, "纯正文，没有思考。")
  assert.equal(response.thinking, undefined)
})

test("thinking and text interleave without crossing over or losing text", async () => {
  const fake = harness([sseFixture("interleaved-thinking-stream.sse")])
  const sink = collector()
  const response = await fake.client.completeStream!(REQUEST, sink.onDelta)

  assert.equal(sink.thinking(), "第一步：读题。第二步：作答。")
  assert.equal(sink.text(), "先读题，同时补充。再作答。")
  assert.deepEqual(sink.kinds(), ["thinking", "thinking", "text", "thinking", "text", "thinking", "text"])
  assert.equal(
    sink.thinking().includes("先读题") || sink.thinking().includes("再作答"),
    false,
    "answer text must not leak into thinking",
  )
  assert.equal(
    sink.text().includes("第一步") || sink.text().includes("第二步"),
    false,
    "thinking must not leak into the answer",
  )
  assert.equal(response.text, "先读题，同时补充。再作答。")
})

test("a retry drops the half streamed thinking before replaying the new attempt", async () => {
  const first = sse([
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: "第一版的思考" } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "半" } }] })}\n\n`,
  ])
  const fake = harness([first, sseFixture("thinking-stream.sse")])
  const sink = collector()
  const response = await fake.client.completeStream!(REQUEST, sink.onDelta)

  assert.equal(fake.calls, 2)
  assert.equal(sink.resets, 1)
  assert.equal(sink.thinking(), "先算一下： 2 + 3 = 5。")
  assert.equal(sink.text(), "答案是 5。")
  assert.equal(response.text, "答案是 5。")
})

test("a plain JSON answer replays reasoning before text on both paths", async () => {
  const payload = {
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "整体答案", reasoning_content: "整体思考" },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
  }
  const streamed = harness([
    new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } }),
  ])
  const sink = collector()
  const streamedResponse = await streamed.client.completeStream!(REQUEST, sink.onDelta)

  assert.deepEqual(sink.events, [
    { text: "整体思考", kind: "thinking" },
    { text: "整体答案", kind: "text" },
  ])
  assert.equal(streamedResponse.thinking, "整体思考")

  const whole = harness([
    new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } }),
  ])
  const response = await whole.client.complete(REQUEST)
  assert.equal(response.text, "整体答案")
  assert.equal(response.thinking, "整体思考")
})
