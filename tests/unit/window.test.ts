import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, test } from "node:test"
import { createSession, type Session } from "../../src/engine/durable.ts"
import { openMemoryDb } from "../../src/memory/db.ts"
import type { LogEvent } from "../../src/memory/events.ts"
import {
  DEFAULT_CONTEXT_BUDGET,
  MIN_KEPT_EVENTS,
  SUMMARY_MAX_CHARS,
  SUMMARY_MAX_TOKENS,
  compressWindow,
  planCompaction,
  windowInfo,
  windowStart,
  type SummaryClient,
  type WindowSink,
} from "../../src/memory/window.ts"

const dirs: string[] = []

after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})

interface Call {
  messages: Array<{ role: string; content: string }>
  maxTokens?: number
}

function scriptedLlm(reply: string | string[]): { llm: SummaryClient; calls: Call[] } {
  const calls: Call[] = []
  const texts: string[] = typeof reply === "string" ? [reply] : [...reply]
  let index = 0
  return {
    calls,
    llm: {
      async complete(request) {
        calls.push({ messages: request.messages, maxTokens: request.maxTokens })
        const text = texts[Math.min(index, texts.length - 1)] ?? ""
        index += 1
        return { text }
      },
    },
  }
}

function throwingLlm(message: string): { llm: SummaryClient; calls: Call[] } {
  const calls: Call[] = []
  return {
    calls,
    llm: {
      async complete(request) {
        calls.push({ messages: request.messages, maxTokens: request.maxTokens })
        throw new Error(message)
      },
    },
  }
}

async function newSession(): Promise<Session> {
  const home = await mkdtemp(path.join(tmpdir(), "ctrl-window-"))
  dirs.push(home)
  return createSession({ sessionId: "main", home, cwd: "/w", model: "fake-model" })
}

function fill(text: string, chars: number): string {
  return text.length >= chars ? text.slice(0, chars) : text + "x".repeat(chars - text.length)
}

function turn(session: Session, chars: number, tag = "t"): void {
  session.appendUserMessage(fill(`${tag}u`, chars))
  session.appendAssistantMessage({ text: fill(`${tag}a`, chars) })
}

function fakeSink(events: LogEvent[], opts: { throwOnAppend?: boolean } = {}): WindowSink & {
  compactions: Array<{ summary: string; firstKeptSeq: number }>
} {
  const compactions: Array<{ summary: string; firstKeptSeq: number }> = []
  const state = [...events]
  return {
    sessionId: "fake",
    compactions,
    events: () => state,
    appendCompaction(input) {
      if (opts.throwOnAppend === true) throw new Error("append refused")
      compactions.push(input)
      state.push({
        seq: state.length,
        ts: "2026-11-20T07:52:00.000Z",
        type: "compaction",
        data: { summary: input.summary, firstKeptSeq: input.firstKeptSeq },
      })
      return state[state.length - 1]
    },
  }
}

test("the window starts at the newest compaction and costs what it costs", async () => {
  const session = await newSession()
  assert.deepEqual(windowInfo(session.events()), { windowStart: 0, chars: 0, events: 1 })
  turn(session, 100)
  assert.equal(windowInfo(session.events()).chars, 200, "a 100-char message and a 100-char reply")
  assert.equal(windowInfo(session.events()).events, 3)

  session.appendCompaction({ summary: "so far", firstKeptSeq: 2 })
  const events = session.events()
  assert.equal(windowStart(events), 2)
  const info = windowInfo(events)
  assert.equal(info.windowStart, 2)

  assert.equal(info.events, 2)
  assert.equal(info.chars, 100 + "so far".length)
  assert.equal(DEFAULT_CONTEXT_BUDGET, 40_000, "the default budget is the frozen 40 000")
})

test("under the budget nothing is planned", () => {

  const events: LogEvent[] = Array.from({ length: 8 }, (_, index) => ({
    seq: index,
    type: index % 2 === 0 ? "user_message" : "assistant_message",
    data: { text: "x".repeat(100) },
  }))
  assert.equal(planCompaction(events, { budget: 1_000 }), undefined)

  assert.equal(planCompaction(events, { budget: 800 }), undefined)
  const over = planCompaction(events, { budget: 799 })
  assert.ok(over, "one character over the budget is over the budget")
  assert.ok(over.dropped > 0)
})

test("over the budget the oldest half goes and the newest >= budget/2 stays", () => {

  const events: LogEvent[] = Array.from({ length: 12 }, (_, index) => ({
    seq: index,
    type: index % 2 === 0 ? "user_message" : "assistant_message",
    data: { text: "z".repeat(100) },
  }))
  const plan = planCompaction(events, { budget: 1_000 })
  assert.ok(plan, "over budget must plan a cut")
  assert.equal(plan.chars, 1_200)
  assert.ok(plan.keepChars >= 500, `kept ${plan.keepChars} chars, wanted >= budget/2`)
  assert.ok(plan.kept >= MIN_KEPT_EVENTS, `kept ${plan.kept} events, wanted >= ${MIN_KEPT_EVENTS}`)
  assert.equal(plan.kept + plan.dropped, 12, "nothing is silently lost")
  assert.equal(plan.firstKeptSeq, events[plan.cut]?.seq)
  assert.equal(plan.fromSeq, 0)
  assert.equal(plan.toSeq, plan.firstKeptSeq - 1, "the dropped range ends right before the kept one")
})

test("at least six events are kept even when one huge event would satisfy the budget", () => {
  const events: LogEvent[] = Array.from({ length: 7 }, (_, index) => ({
    seq: index,
    type: index % 2 === 0 ? "user_message" : "assistant_message",
    data: { text: index === 6 ? "h".repeat(5_000) : "s".repeat(10) },
  }))
  const plan = planCompaction(events, { budget: 500 })
  assert.ok(plan)
  assert.equal(plan.kept, MIN_KEPT_EVENTS, "the floor wins over the character target")
  assert.equal(plan.firstKeptSeq, 1)
})

test("a single user message is never compressed", () => {
  const events: LogEvent[] = [
    { seq: 0, type: "session_created", data: { cwd: "/w", model: "m" } },
    { seq: 1, type: "user_message", data: { text: "q".repeat(5_000) } },
  ]
  assert.equal(planCompaction(events, { budget: 100 }), undefined)

  const marker: LogEvent[] = [
    { seq: 0, type: "user_message", data: { text: "q".repeat(5_000) } },
    { seq: 1, type: "assistant_pending", data: { model: "m", step: 1 } },
  ]
  assert.equal(planCompaction(marker, { budget: 100 }), undefined)
})

test("the cut never leaves a tool_result without the assistant message that called it", () => {

  const events: LogEvent[] = [
    { seq: 0, type: "user_message", data: { text: "aaa" } },
    { seq: 1, type: "assistant_message", data: { text: "bbb" } },
    { seq: 2, type: "assistant_message", data: { text: "ccc" } },
    { seq: 3, type: "tool_result", data: { callId: "c1", name: "bash", ok: true, output: "ddd" } },
    { seq: 4, type: "assistant_message", data: { text: "eee" } },
    { seq: 5, type: "user_message", data: { text: "fff" } },
  ]
  const plan = planCompaction(events, { budget: 15, minKeep: 2 })
  assert.ok(plan, "budget 15 < 18 chars must plan a cut")
  assert.equal(plan.firstKeptSeq, 4, "the tool_result is dropped with its call, not orphaned")
  assert.notEqual(events[plan.cut]?.type, "tool_result")
})

test("the window is what the next plan measures, not the whole log", () => {
  const events: LogEvent[] = [
    { seq: 0, type: "user_message", data: { text: "old ".repeat(500) } },
    { seq: 1, type: "compaction", data: { summary: "the old part", firstKeptSeq: 2 } },
    { seq: 2, type: "user_message", data: { text: "new" } },
    { seq: 3, type: "assistant_message", data: { text: "reply" } },
  ]
  assert.equal(planCompaction(events, { budget: 1_000 }), undefined, "2 004 chars in the log, 8 in the window")
})

test("over budget: a summary is appended, the summaries row written, the window shrinks", async () => {
  const session = await newSession()
  for (let index = 0; index < 6; index += 1) turn(session, 100, `p${index}`)
  assert.equal(windowInfo(session.events()).chars, 1_200)

  const db = openMemoryDb(":memory:")
  try {
    const { llm, calls } = scriptedLlm("we discussed the plan and agreed on six steps")
    const outcome = await compressWindow(session, { llm, budget: 1_000, db })

    assert.equal(outcome.compressed, true)
    assert.equal(outcome.summary, "we discussed the plan and agreed on six steps")
    assert.equal(outcome.fromSeq, 0)
    assert.equal(outcome.toSeq, 6)
    assert.equal(outcome.firstKeptSeq, 7)
    assert.equal(outcome.kept, 6)
    assert.equal(calls.length, 1, "one summary call per compression")
    assert.equal(calls[0]?.maxTokens, SUMMARY_MAX_TOKENS, "the call is capped at 800 tokens")
    assert.match(calls[0]?.messages[0]?.content ?? "", /compress/i)

    const events = session.events()
    const compaction = events.at(-1)
    assert.equal(compaction?.type, "compaction")
    assert.equal(
      (compaction?.data as { firstKeptSeq: number }).firstKeptSeq,
      7,
      "the model's transcript now starts at seq 7",
    )
    const info = windowInfo(events)
    assert.equal(info.windowStart, 7)
    assert.ok(info.chars < 1_000, `window is ${info.chars} chars after compression`)

    const row = db.prepare("SELECT * FROM summaries").get() as Record<string, unknown> | undefined
    assert.equal(row?.level, "window")
    assert.equal(row?.from_seq, 0)
    assert.equal(row?.to_seq, 6)
    assert.equal(row?.text, "we discussed the plan and agreed on six steps")
  } finally {
    db.close()
  }
})

test("the summary is clipped to 2 000 characters", async () => {
  const session = await newSession()
  for (let index = 0; index < 6; index += 1) turn(session, 100)
  const { llm } = scriptedLlm("s".repeat(5_000))
  const outcome = await compressWindow(session, { llm, budget: 1_000 })
  assert.equal(outcome.compressed, true)
  assert.equal(Array.from(outcome.summary ?? "").length, SUMMARY_MAX_CHARS)
})

test("a model that throws does not stop the turn and does not compact", async () => {
  const session = await newSession()
  for (let index = 0; index < 6; index += 1) turn(session, 100)
  const before = session.events()

  const { llm } = throwingLlm("gateway down")
  const outcome = await compressWindow(session, { llm, budget: 1_000 })
  assert.equal(outcome.compressed, false, "a failed summary must not compress")
  assert.match(String(outcome.reason), /^summary-failed: gateway down/)
  assert.equal(outcome.chars, 1_200, "the outcome still reports the window it saw")
  assert.equal(session.events().length, before.length, "no event was appended")
})

test("an empty answer is a failed summary, not an empty compaction", async () => {
  const session = await newSession()
  for (let index = 0; index < 6; index += 1) turn(session, 100)
  const before = session.events().length
  const { llm } = scriptedLlm("   ")
  const outcome = await compressWindow(session, { llm, budget: 1_000 })
  assert.equal(outcome.compressed, false)
  assert.match(String(outcome.reason), /^summary-failed/)
  assert.equal(session.events().length, before)
})

test("a session that refuses the append is reported, not thrown", async () => {
  const events: LogEvent[] = Array.from({ length: 12 }, (_, index) => ({
    seq: index,
    type: index % 2 === 0 ? "user_message" : "assistant_message",
    data: { text: "z".repeat(100) },
  }))
  const sink = fakeSink(events, { throwOnAppend: true })
  const { llm } = scriptedLlm("a summary")
  const outcome = await compressWindow(sink, { llm, budget: 1_000 })
  assert.equal(outcome.compressed, false)
  assert.match(String(outcome.reason), /^summary-failed: append refused/)
})

test("an aborted turn does not spend a model call on a summary", async () => {
  const session = await newSession()
  for (let index = 0; index < 6; index += 1) turn(session, 100)
  const { llm, calls } = scriptedLlm("never used")
  const controller = new AbortController()
  controller.abort()
  const outcome = await compressWindow(session, { llm, budget: 1_000, signal: controller.signal })
  assert.equal(outcome.compressed, false)
  assert.equal(outcome.reason, "aborted")
  assert.equal(calls.length, 0)
})

test("a degraded database still compacts: the summary row is only bookkeeping", async () => {
  const session = await newSession()
  for (let index = 0; index < 6; index += 1) turn(session, 100)
  const { llm } = scriptedLlm("kept going without a database")
  const outcome = await compressWindow(session, { llm, budget: 1_000 })
  assert.equal(outcome.compressed, true, "no db, no problem")
  assert.equal(outcome.firstKeptSeq, 7)
})

test("a second compression rolls the first summary into the new prompt", async () => {
  const session = await newSession()
  for (let index = 0; index < 6; index += 1) turn(session, 100, `a${index}`)
  const first = scriptedLlm("FIRST SUMMARY")
  assert.equal((await compressWindow(session, { llm: first.llm, budget: 1_000 })).compressed, true)

  for (let index = 0; index < 4; index += 1) turn(session, 100, `b${index}`)
  const second = scriptedLlm("SECOND SUMMARY")
  const outcome = await compressWindow(session, { llm: second.llm, budget: 1_000 })
  assert.equal(outcome.compressed, true)
  assert.ok(
    (outcome.fromSeq ?? -1) >= 7,
    `the second compression must start inside the first window (got from=${outcome.fromSeq})`,
  )
  const prompt = second.calls[0]?.messages[1]?.content ?? ""
  assert.match(prompt, /FIRST SUMMARY/, "the previous summary is part of the new prompt")
  assert.equal(session.events().filter((event) => event.type === "compaction").length, 2)
})
