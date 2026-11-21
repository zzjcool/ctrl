import assert from "node:assert/strict"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, test } from "node:test"
import type { SessionEvent, LlmCompleteRequest, LlmResponse, ToolSpec } from "../../src/engine/durable.ts"
import { createSession, executeTool, runAgent, type Session } from "../../src/engine/durable.ts"
import { openMemoryDb } from "../../src/memory/db.ts"
import { recordCompactionSummary } from "../../src/memory/window.ts"

const dirs: string[] = []

after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})

function zero() {
  return { promptTokens: 1, completionTokens: 1, totalTokens: 2 }
}

function reply(text: string, calls: Array<{ callId: string; name: string; args: Record<string, unknown> }> = []): LlmResponse {
  return { text, toolCalls: calls, usage: zero(), finishReason: calls.length > 0 ? "tool_calls" : "stop" }
}

interface Scripted {
  llm: { model: string; complete: (req: LlmCompleteRequest) => Promise<LlmResponse> }
  requests: LlmCompleteRequest[]
  steps: number
}

function scriptedLlm(responses: Array<LlmResponse | ((req: LlmCompleteRequest) => LlmResponse)>): Scripted {
  const requests: LlmCompleteRequest[] = []
  let index = 0
  return {
    requests,
    get steps() {
      return index
    },
    llm: {
      model: "fake-model",
      async complete(req) {
        requests.push(req)
        const next = responses[Math.min(index, responses.length - 1)] ?? reply("(no script)")
        index += 1
        return typeof next === "function" ? next(req) : next
      },
    },
  }
}

async function newAgentHome(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "ctrl-engine-"))
  dirs.push(home)
  return home
}

async function newSession(cwd = "/w"): Promise<{ home: string; session: Session }> {
  const home = await newAgentHome()
  const session = createSession({ sessionId: "main", home, cwd, model: "fake-model" })
  return { home, session }
}

function types(events: SessionEvent[]): string[] {
  return events.map((event) => event.type)
}

async function walk(dir: string): Promise<string[]> {
  const found: string[] = []
  const visit = async (current: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        await visit(full)
        continue
      }
      found.push(full)
    }
  }
  await visit(dir)
  return found.sort()
}

test("a turn mirrors the loop into the log: pending, message, tool call, tool result", async () => {
  const { session } = await newSession()
  const { llm } = scriptedLlm([
    reply("", [{ callId: "c1", name: "recall", args: { text: "hello" } }]),
    reply("the answer"),
  ])
  const seen: Array<{ timeoutMs: number; maxOutputChars: number; args: Record<string, unknown> }> = []
  const tools: ToolSpec[] = [
    {
      name: "recall",
      description: "search memory",
      parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      async execute(args, ctx) {
        seen.push({ timeoutMs: ctx.timeoutMs, maxOutputChars: ctx.maxOutputChars, args })
        return { ok: true, output: `hit ${String(args.text)}` }
      },
    },
  ]

  const result = await runAgent({
    sessionId: "main",
    input: "question",
    session,
    llm,
    tools,
    cwd: "/w",
    systemPrompt: "You are a tester.",
  })

  assert.equal(result.reply, "the answer")
  assert.equal(result.steps, 2)
  assert.equal(result.toolCalls, 1)
  assert.deepEqual(types(session.events()), [
    "session_created",
    "user_message",
    "assistant_pending",
    "assistant_message",
    "tool_call",
    "tool_result",
    "assistant_pending",
    "assistant_message",
  ])
  const call = session.events().find((event) => event.type === "tool_call")
  assert.deepEqual(call?.data, { callId: "c1", name: "recall", args: { text: "hello" } })
  const result_event = session.events().find((event) => event.type === "tool_result")
  assert.deepEqual(result_event?.data, { callId: "c1", name: "recall", ok: true, output: "hit hello" })

  assert.deepEqual(seen, [{ timeoutMs: 10_000, maxOutputChars: 8_000, args: { text: "hello" } }])
  const first = session.events()[3]
  assert.deepEqual(first?.type === "assistant_message" ? first.data.toolCalls : undefined, [
    { callId: "c1", name: "recall", args: { text: "hello" } },
  ])
})

test("the deltas a turn streams add up to the text it logs", async () => {
  const { session } = await newSession()
  const { llm } = scriptedLlm([
    reply("first part ", [{ callId: "c1", name: "noop", args: {} }]),
    reply("second part"),
  ])
  const tools: ToolSpec[] = [
    {
      name: "noop",
      description: "does nothing",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { ok: true, output: "ok" }
      },
    },
  ]
  const deltas: string[] = []
  const result = await runAgent({
    sessionId: "main",
    input: "go",
    session,
    llm,
    tools,
    cwd: "/w",
    onDelta: (text) => deltas.push(text),
  })

  assert.equal(result.reply, "second part")
  assert.equal(deltas.join(""), "first part second part")
  assert.equal(deltas[0], "first part ")
  const replies = session
    .events()
    .filter((event): event is Extract<SessionEvent, { type: "assistant_message" }> => event.type === "assistant_message")
    .map((event) => event.data.text)
  assert.deepEqual(replies, ["first part ", "second part"])
})

test("the SDK session stays in memory: no session, settings or model file is written", async () => {
  const { home, session } = await newSession("/w")
  const agentDir = await newAgentHome()
  const { llm } = scriptedLlm([reply("in memory")])

  await runAgent({
    sessionId: "main",
    input: "hello",
    session,
    llm,
    tools: [],
    cwd: "/w",
    agentDir,
    systemPrompt: "You are a tester.",
  })

  assert.deepEqual(await walk(agentDir), [], "the SDK wrote nothing next to the agent")
  const written = (await walk(home)).filter((file) => !file.includes("store.sqlite"))
  assert.deepEqual(written, [`${home}/sessions/main/events.jsonl`, `${home}/sessions/main/meta.json`])
})

test("the official compaction lands in the log and in the summaries table", async () => {
  const { session } = await newSession("/w")
  const fill = (tag: string) => `${tag} ${"x".repeat(30_000)}`
  for (let index = 0; index < 4; index += 1) {
    session.appendUserMessage(fill(`question ${index}`))
    session.appendAssistantMessage({ text: fill(`answer ${index}`) })
  }
  const heavy = { promptTokens: 120_000, completionTokens: 10, totalTokens: 120_010 }
  let turns = 0
  const { llm, requests } = scriptedLlm([
    (req) => {
      const system = req.messages.find((message) => message.role === "system")
      const text = typeof system?.content === "string" ? system.content : ""
      if (text.startsWith("You are a context summarization assistant")) {
        return { text: "THE SUMMARY", toolCalls: [], usage: zero(), finishReason: "stop" }
      }
      turns += 1
      if (turns === 1) {
        return { text: "", toolCalls: [{ callId: "c1", name: "noop", args: {} }], usage: heavy, finishReason: "tool_calls" }
      }
      return reply("after compaction")
    },
  ])
  const records: Array<{ summary: string; firstKeptSeq: number; fromSeq: number; toSeq: number }> = []
  const db = openMemoryDb(":memory:")
  try {
    const tools: ToolSpec[] = [
      {
        name: "noop",
        description: "does nothing",
        parameters: { type: "object", properties: {} },
        async execute() {
          return { ok: true, output: "ok" }
        },
      },
    ]
    const result = await runAgent({
      sessionId: "main",
      input: "one more question",
      session,
      llm,
      tools,
      cwd: "/w",
      onCompaction: (record) => {
        records.push(record)
        recordCompactionSummary(db, record)
      },
    })

    assert.equal(result.compacted, true)
    const summarised = requests.filter((request) => {
      const system = request.messages.find((message) => message.role === "system")
      const text = typeof system?.content === "string" ? system.content : ""
      return text.startsWith("You are a context summarization assistant")
    })
    assert.ok(summarised.length >= 1, `expected a summarization request, got ${requests.length}`)
    assert.equal(records.length, 1, "one compaction record")
    const record = records[0]
    assert.ok(record !== undefined)
    assert.match(record.summary, /THE SUMMARY/)
    assert.ok(record.firstKeptSeq > 0, `the window moved forward (got ${record.firstKeptSeq})`)
    assert.equal(record.fromSeq, 0)
    assert.equal(record.toSeq, record.firstKeptSeq - 1)

    const compaction = session.events().find((event) => event.type === "compaction")
    assert.deepEqual(compaction?.data, { summary: record.summary, firstKeptSeq: record.firstKeptSeq })

    const row = db.prepare("SELECT * FROM summaries").get() as Record<string, unknown> | undefined
    assert.equal(row?.level, "window")
    assert.equal(row?.text, record.summary)
    assert.equal(row?.from_seq, 0)
    assert.equal(row?.to_seq, record.firstKeptSeq - 1)
  } finally {
    db.close()
  }
})

test("a tool that never returns is cut off by the shared tool cap", async () => {
  const result = await executeTool(
    {
      name: "hang",
      description: "never returns",
      parameters: { type: "object", properties: {} },
      execute: () => new Promise(() => {}),
    },
    {},
    { cwd: "/w", allowBash: false, timeoutMs: 60, maxOutputChars: 8_000 },
  )
  assert.equal(result.ok, false)
  assert.match(result.output, /timed out after 60ms/)
})

test("a tool declaring its own timeout outlives the shared cap", async () => {
  const started = Date.now()
  const result = await executeTool(
    {
      name: "slow",
      description: "finishes after the shared cap",
      parameters: { type: "object", properties: {} },
      timeoutMs: 400,
      execute: () => new Promise((resolve) => setTimeout(() => resolve({ ok: true, output: "done" }), 150)),
    },
    {},
    { cwd: "/w", allowBash: false, timeoutMs: 60, maxOutputChars: 8_000 },
  )
  assert.equal(result.ok, true)
  assert.equal(result.output, "done")
  assert.ok(Date.now() - started >= 140)
})

test("a tool still honours the shared cap when it declares none", async () => {
  const result = await executeTool(
    {
      name: "slow",
      description: "finishes after the shared cap",
      parameters: { type: "object", properties: {} },
      execute: () => new Promise((resolve) => setTimeout(() => resolve({ ok: true, output: "done" }), 200)),
    },
    {},
    { cwd: "/w", allowBash: false, timeoutMs: 60, maxOutputChars: 8_000 },
  )
  assert.equal(result.ok, false)
  assert.match(result.output, /timed out after 60ms/)
})

test("a tool call a crashed turn left open is repaired before the model sees it", async () => {
  const { session } = await newSession()
  session.appendUserMessage("run something")
  session.appendAssistantMessage({ text: "", toolCalls: [{ callId: "gone", name: "delegate", args: { task: "x" } }] })
  const { llm, requests } = scriptedLlm([reply("picked it up")])
  const tools: ToolSpec[] = [
    {
      name: "delegate",
      description: "delegate",
      parameters: { type: "object", properties: { task: { type: "string" } } },
      async execute() {
        return { ok: true, output: "should not run" }
      },
    },
  ]

  await runAgent({ sessionId: "main", input: "continue", session, llm, tools, cwd: "/w" })

  const repaired = session.events().find((event) => event.type === "tool_result")
  assert.equal(repaired?.data.callId, "gone")
  assert.equal(repaired?.data.ok, false)
  assert.match(String(repaired?.data.output), /not re-executed/)

  const wire = requests[0]?.messages ?? []
  const assistant = wire.findIndex((message) => message.role === "assistant")
  assert.ok(assistant >= 0)
  assert.deepEqual(wire[assistant]?.toolCalls, [{ callId: "gone", name: "delegate", args: { task: "x" } }])
  assert.equal(wire[assistant + 1]?.role, "tool")
  assert.equal(wire[assistant + 1]?.toolCallId, "gone")
  assert.equal(session.events().filter((event) => event.type === "tool_call").length, 0, "the dead call is not re-executed")
})

test("an assistant message that carries tool calls keeps them in the log", async () => {
  const { session } = await newSession()
  const { llm } = scriptedLlm([
    reply("", [{ callId: "c9", name: "unknown_tool", args: { a: 1 } }]),
    reply("done"),
  ])
  await runAgent({ sessionId: "main", input: "q", session, llm, tools: [], cwd: "/w" })

  const calls = session
    .events()
    .flatMap((event) => (event.type === "assistant_message" && event.data.toolCalls ? event.data.toolCalls : []))
  assert.deepEqual(calls, [{ callId: "c9", name: "unknown_tool", args: { a: 1 } }])
  assert.equal(session.events().filter((event) => event.type === "tool_result").length, 0)
})
