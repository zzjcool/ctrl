import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, test } from "node:test"
import type { DatabaseSync } from "node:sqlite"
import { createSqliteAgentMemory, LESSON_RECALL_BOOST } from "../../src/memory/agent-memory.ts"
import { openMemoryDb } from "../../src/memory/db.ts"
import { runDream, type DreamLlm } from "../../src/memory/dream.ts"
import type { LogEvent } from "../../src/memory/events.ts"
import { addMemory, listMemories } from "../../src/memory/memories.ts"
import {
  RETRO_MAX_LESSONS,
  RETRO_MAX_LESSON_CHARS,
  RETRO_MAX_TOKENS,
  buildRetroPrompt,
  parseRetroPayload,
} from "../../src/memory/retro.ts"

const dirs: string[] = []

after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})

async function tempHome(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "ctrl-retro-"))
  dirs.push(home)
  return home
}

function clock(): () => Date {
  let at = Date.parse("2026-11-20T08:00:00.000Z")
  return () => new Date((at += 1_000_000))
}

const EVENTS: LogEvent[] = [
  { seq: 0, ts: "2026-11-20T07:50:00.000Z", type: "user_message", data: { text: "先补 typecheck 再改代码" } },
  { seq: 1, ts: "2026-11-20T07:51:00.000Z", type: "tool_result", data: { output: "tsc: error TS2322" } },
]

function scriptedLlm(replies: string[]): { llm: DreamLlm; prompts: string[]; maxTokens: number[] } {
  const prompts: string[] = []
  const maxTokens: number[] = []
  const texts = [...replies]
  let index = 0
  return {
    prompts,
    maxTokens,
    llm: {
      async complete(request) {
        prompts.push(request.messages.map((message) => message.content).join("\n\n"))
        maxTokens.push(request.maxTokens ?? 0)
        const text = texts[Math.min(index, texts.length - 1)] ?? ""
        index += 1
        return { text }
      },
    },
  }
}

interface Bag {
  db: DatabaseSync
  agentHome: string
  now: () => Date
}

async function bag(): Promise<Bag> {
  const agentHome = await tempHome()
  return { db: openMemoryDb(":memory:"), agentHome, now: clock() }
}

const LESSONS = JSON.stringify({
  lessons: [
    { text: "先跑 npm run typecheck 再改代码", scope: "code", confidence: 0.9 },
    { text: "派活时把验收命令写进任务卡", scope: "delegate", confidence: 0.4 },
  ],
})

test("the retro pass stores lessons with kind, tags, importance and the batch range", async () => {
  const opened = await bag()
  const { llm, prompts, maxTokens } = scriptedLlm([JSON.stringify({ memories: [{ text: "窗口压缩在每轮开始前做" }] }), LESSONS])
  const result = await runDream({ db: opened.db, agentHome: opened.agentHome, events: EVENTS, llm, now: opened.now })
  try {
    assert.equal(result.error, undefined, `unexpected error: ${result.error}`)
    assert.equal(result.added, 1, "the main payload is unaffected")
    assert.equal(result.lessons, 2)

    assert.equal(prompts.length, 2, "one call for the batch, one for the retro")
    assert.match(prompts[1] ?? "", /durable lessons/)
    assert.match(prompts[1] ?? "", /先补 typecheck 再改代码/)
    assert.equal(maxTokens[1], RETRO_MAX_TOKENS)

    const lessons = listMemories(opened.db, { kind: "lesson" })
    assert.equal(lessons.length, 2)
    const code = lessons.find((row) => row.text === "先跑 npm run typecheck 再改代码")
    assert.ok(code, `missing the code lesson: ${JSON.stringify(lessons)}`)
    assert.equal(code?.kind, "lesson")
    assert.deepEqual(code?.tags, ["lesson", "code"])
    assert.equal(code?.importance, 0.9)
    assert.equal(code?.sourceFrom, 0)
    assert.equal(code?.sourceTo, 1)
    assert.deepEqual(
      lessons.map((row) => row.importance).sort(),
      [0.4, 0.9],
      "importance is the confidence the model reported",
    )
  } finally {
    opened.db.close()
  }
})

test("a reply that is not JSON is a silent no-op, not a broken dream", async () => {
  const opened = await bag()
  const warned: string[] = []
  const { llm } = scriptedLlm([JSON.stringify({ memories: [{ text: "主流程照旧入库" }] }), 'Sure! Here you go:\n```json\n{"lessons":[{"text":"half'])
  const result = await runDream({
    db: opened.db,
    agentHome: opened.agentHome,
    events: EVENTS,
    llm,
    now: opened.now,
    warn: (message) => warned.push(message),
  })
  try {
    assert.equal(result.error, undefined, "the dream itself succeeded")
    assert.equal(result.lessons, 0)
    assert.equal(listMemories(opened.db, { kind: "lesson" }).length, 0)
    assert.equal(result.added, 1, "the main payload still landed")
    assert.deepEqual(warned, [], "bad JSON is not an error either")
  } finally {
    opened.db.close()
  }
})

test("an empty lesson list writes nothing", async () => {
  const opened = await bag()
  const { llm, prompts } = scriptedLlm(["{}", '{"lessons":[]}'])
  const result = await runDream({ db: opened.db, agentHome: opened.agentHome, events: EVENTS, llm, now: opened.now })
  try {
    assert.equal(prompts.length, 2, "the retro was still asked")
    assert.equal(result.lessons, 0)
    assert.equal(listMemories(opened.db, { includeSuperseded: true }).length, 0)
  } finally {
    opened.db.close()
  }
})

test("more than three lessons keeps the first three", async () => {
  const opened = await bag()
  const payload = JSON.stringify({
    lessons: [
      { text: "lesson one", scope: "code", confidence: 0.5 },
      { text: "lesson two", scope: "search", confidence: 0.5 },
      { text: "lesson three", scope: "memory", confidence: 0.5 },
      { text: "lesson four", scope: "code", confidence: 0.5 },
    ],
  })
  assert.equal(parseRetroPayload(payload).length, RETRO_MAX_LESSONS)

  const { llm } = scriptedLlm(["{}", payload])
  const result = await runDream({ db: opened.db, agentHome: opened.agentHome, events: EVENTS, llm, now: opened.now })
  try {
    assert.equal(result.lessons, RETRO_MAX_LESSONS)
    assert.deepEqual(
      listMemories(opened.db, { kind: "lesson" })
        .map((row) => row.text)
        .sort(),
      ["lesson one", "lesson three", "lesson two"],
    )
  } finally {
    opened.db.close()
  }
})

test("the same lesson dreamt twice is merged into one row", async () => {
  const opened = await bag()
  const first = scriptedLlm([
    "{}",
    JSON.stringify({ lessons: [{ text: "先跑  typecheck 再改代码。", scope: "code", confidence: 0.4 }] }),
  ])
  const one = await runDream({ db: opened.db, agentHome: opened.agentHome, events: EVENTS, llm: first.llm, now: opened.now })
  assert.equal(one.lessons, 1)

  const second = scriptedLlm([
    JSON.stringify({ memories: [{ text: "第二轮的事实" }] }),
    JSON.stringify({ lessons: [{ text: "先跑 typecheck 再改代码", scope: "code", confidence: 0.8 }] }),
  ])
  const later: LogEvent[] = [
    ...EVENTS,
    { seq: 2, ts: "2026-11-20T07:59:00.000Z", type: "user_message", data: { text: "再复盘一次" } },
  ]
  const two = await runDream({
    db: opened.db,
    agentHome: opened.agentHome,
    events: later,
    llm: second.llm,
    now: opened.now,
  })
  try {
    assert.equal(two.lessons, 1)
    assert.equal(two.added, 1, "only the plain memory was new")
    const lessons = listMemories(opened.db, { kind: "lesson" })
    assert.equal(lessons.length, 1, "the normalised duplicate did not add a row")
    assert.equal(lessons[0]?.importance, 0.8, "the higher confidence wins the merge")
    assert.deepEqual(lessons[0]?.tags, ["lesson", "code"])
  } finally {
    opened.db.close()
  }
})

test("a failing retro does not take the dream down with it", async () => {
  const opened = await bag()
  const warned: string[] = []
  let calls = 0
  const llm: DreamLlm = {
    async complete() {
      calls += 1
      if (calls === 1) return { text: JSON.stringify({ memories: [{ text: "主流程写的记忆" }] }) }
      throw new Error("gateway 500")
    },
  }
  const result = await runDream({
    db: opened.db,
    agentHome: opened.agentHome,
    events: EVENTS,
    llm,
    now: opened.now,
    warn: (message) => warned.push(message),
  })
  try {
    assert.equal(result.error, undefined, "the main dream is still a success")
    assert.equal(result.added, 1)
    assert.equal(result.lessons, 0)
    assert.equal(warned.length, 1)
    assert.match(warned[0] ?? "", /retro failed: gateway 500/)
    assert.equal(listMemories(opened.db).length, 1)
  } finally {
    opened.db.close()
  }
})

test("recall lifts a lesson above a plain fact of the same weight", async () => {
  const db = openMemoryDb(":memory:")
  const at = new Date("2026-11-20T08:00:00.000Z")
  try {
    addMemory(db, {
      text: "部署前先跑 typecheck",
      kind: "lesson",
      tags: ["lesson", "code"],
      importance: 0.5,
      now: new Date(at.getTime() - 2_000),
    })
    addMemory(db, { text: "部署走 typecheck 脚本", kind: "fact", importance: 0.5, now: at })

    const memory = createSqliteAgentMemory({ db, now: () => at })
    const hits = memory.recall({ text: "typecheck", limit: 2 })
    assert.deepEqual(
      hits.map((hit) => hit.entry.text),
      ["部署前先跑 typecheck", "部署走 typecheck 脚本"],
      "the newer fact loses to the lesson multiplier",
    )
    assert.ok((hits[0]?.score ?? 0) > (hits[1]?.score ?? 0))
    assert.equal(LESSON_RECALL_BOOST, 1.2)
  } finally {
    db.close()
  }
})

test("the retro prompt shows the batch and caps lesson text", () => {
  const prompt = buildRetroPrompt({ events: [{ seq: 4, type: "tool_call", role: "assistant", text: "npm test" }], fromSeq: 4, toSeq: 4, chars: 8 })
  assert.match(prompt, /"lessons"/)
  assert.match(prompt, /At most 3 lessons/)
  assert.match(prompt, /\[seq 4\] assistant: npm test/)

  const parsed = parseRetroPayload(
    JSON.stringify({ lessons: [{ text: "x".repeat(500), scope: "NONSENSE", confidence: 7 }] }),
  )
  assert.equal(Array.from(parsed[0]?.text ?? "").length, RETRO_MAX_LESSON_CHARS)
  assert.equal(parsed[0]?.scope, "other")
  assert.equal(parsed[0]?.confidence, 1)
})
