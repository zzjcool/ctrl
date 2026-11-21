import assert from "node:assert/strict"
import { test } from "node:test"
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai"
import type { AssistantMessageEvent } from "@earendil-works/pi-ai"
import {
  openStream,
  pushStreamText,
  pushStreamTextEnd,
  pushStreamThinking,
  resetStream,
} from "../../src/engine/sdk-agent.ts"

interface Live {
  stream: ReturnType<typeof createAssistantMessageEventStream>
  events: AssistantMessageEvent[]
  live: ReturnType<typeof openStream>
}

function liveHarness(): Live {
  const stream = createAssistantMessageEventStream()
  const events: AssistantMessageEvent[] = []
  const push = stream.push.bind(stream)
  stream.push = (event: AssistantMessageEvent): void => {
    events.push(event)
    push(event)
  }
  return { stream, events, live: openStream(stream) }
}

function types(events: AssistantMessageEvent[]): string[] {
  return events.map((event) => event.type)
}

test("a stream without thinking pushes zero thinking events and leaves no thinking block", () => {
  const { stream, events, live } = liveHarness()
  pushStreamText(stream, live, "答")
  pushStreamText(stream, live, "案")
  pushStreamTextEnd(stream, live)

  assert.deepEqual(types(events), ["start", "text_start", "text_delta", "text_delta", "text_end"])
  assert.equal(events.some((event) => event.type.startsWith("thinking")), false)
  assert.equal(live.partial.content.some((block) => block.type === "thinking"), false)
})

test("thinking arrives as thinking events and is closed before the text block starts", () => {
  const { stream, events, live } = liveHarness()
  pushStreamThinking(stream, live, "想一下")
  pushStreamThinking(stream, live, "，再想")
  pushStreamText(stream, live, "答案")
  pushStreamTextEnd(stream, live)

  assert.deepEqual(types(events), [
    "start",
    "thinking_start",
    "thinking_delta",
    "thinking_delta",
    "thinking_end",
    "text_start",
    "text_delta",
    "text_end",
  ])
  const end = events[4]
  assert.equal(end?.type, "thinking_end")
  if (end?.type === "thinking_end") assert.equal(end.content, "想一下，再想")
  assert.deepEqual(live.partial.content, [
    { type: "thinking", thinking: "想一下，再想" },
    { type: "text", text: "答案" },
  ])
})

test("thinking that resumes after text opens a new block instead of reopening the closed one", () => {
  const { stream, events, live } = liveHarness()
  pushStreamThinking(stream, live, "一")
  pushStreamText(stream, live, "二")
  pushStreamThinking(stream, live, "三")
  pushStreamText(stream, live, "四")
  pushStreamTextEnd(stream, live)

  assert.deepEqual(types(events), [
    "start",
    "thinking_start",
    "thinking_delta",
    "thinking_end",
    "text_start",
    "text_delta",
    "text_end",
    "thinking_start",
    "thinking_delta",
    "thinking_end",
    "text_start",
    "text_delta",
    "text_end",
  ])
  assert.deepEqual(live.partial.content, [
    { type: "thinking", thinking: "一" },
    { type: "text", text: "二" },
    { type: "thinking", thinking: "三" },
    { type: "text", text: "四" },
  ])
})

test("a reset drops the streamed thinking and leaves no blank block behind", () => {
  const { stream, events, live } = liveHarness()
  pushStreamThinking(stream, live, "作废的思考")
  resetStream(live)
  pushStreamText(stream, live, "重来的答案")
  pushStreamTextEnd(stream, live)

  assert.deepEqual(types(events), [
    "start",
    "thinking_start",
    "thinking_delta",
    "text_start",
    "text_delta",
    "text_end",
  ])
  assert.deepEqual(live.partial.content, [{ type: "text", text: "重来的答案" }])
})
