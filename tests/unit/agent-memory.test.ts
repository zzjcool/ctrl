import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, test } from "node:test"
import { openMemoryDb } from "../../src/memory/db.ts"
import { buildTools, type MemoryEntry } from "../../src/engine/durable.ts"
import { createSqliteAgentMemory, engineKind, toEntry } from "../../src/memory/agent-memory.ts"
import { runDream, type DreamLlm } from "../../src/memory/dream.ts"
import type { LogEvent } from "../../src/memory/events.ts"
import { addMemory, searchTerms, supersedeMemory, updateMemory } from "../../src/memory/memories.ts"
import { createSearchContextTool } from "../../src/memory/tools.ts"
import { createMemoryIndex } from "../../src/memory/index.ts"
import type { DatabaseSync } from "node:sqlite"

const dirs: string[] = []

after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})

async function home(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "ctrl-agent-memory-"))
  dirs.push(dir)
  return dir
}

function dreamLlm(reply: string): DreamLlm {
  return { async complete() { return { text: reply } } }
}

const EVENTS: LogEvent[] = [
  { seq: 0, ts: "2026-11-20T07:50:00.000Z", type: "user_message", data: { text: "以后中文回答就行" } },
  { seq: 1, ts: "2026-11-20T07:51:00.000Z", type: "assistant_message", data: { text: "好，记住了" } },
]

const context = { cwd: "/w", allowBash: false, timeoutMs: 10_000, maxOutputChars: 8_000 }

test("a memory written by a dream is recalled by the agent loop", async () => {
  const dir = await home()
  const db = openMemoryDb(":memory:")
  try {
    const dreamed = await runDream({
      db,
      agentHome: dir,
      events: EVENTS,
      llm: dreamLlm(
        JSON.stringify({
          memories: [{ kind: "preference", text: "用户喜欢用中文交流", tags: ["style"], importance: 0.9 }],
        }),
      ),
    })
    assert.equal(dreamed.error, undefined, `dream failed: ${dreamed.error}`)

    const memory = createSqliteAgentMemory({ db })

    const hits = memory.recall({ text: "我们之前说了语言的事，中文还是英文？", limit: 8 })
    assert.equal(hits.length, 1, "the dream-written memory must come back")
    assert.equal(hits[0]?.entry.text, "用户喜欢用中文交流")
    assert.equal(hits[0]?.entry.kind, "preference")
    assert.deepEqual(hits[0]?.entry.tags, ["style"])
    assert.equal(hits[0]?.entry.salience, 0.9, "importance and salience are the same knob")
    assert.equal(hits[0]?.entry.seq, 1, "the entry points back at the log it came from")
    assert.ok((hits[0]?.score ?? 0) > 0, "a hit carries a positive score")

    assert.deepEqual(Object.keys(hits[0]?.entry ?? {}).sort(), ["id", "kind", "salience", "seq", "tags", "text", "ts"])
  } finally {
    db.close()
  }
})

test("remember writes the table and recall reads it back", async () => {
  const db = openMemoryDb(":memory:")
  try {
    const memory = createSqliteAgentMemory({ db })

    const remember = buildTools().find((tool) => tool.name === "remember")
    assert.ok(remember, "the engine ships a remember tool")
    const written = await remember.execute(
      { kind: "fact", text: "the build box runs Go 1.23", tags: ["build"], salience: 0.4 },
      { ...context, remember: (input) => memory.remember(input) },
    )
    assert.equal(written.ok, true, written.output)
    const entry = JSON.parse(written.output) as MemoryEntry
    assert.equal(entry.kind, "fact")
    assert.equal(entry.salience, 0.4, "salience is importance")
    assert.ok(entry.id.startsWith("mem-"))

    const hits = memory.recall({ text: "which Go version is on the build box?", limit: 5 })
    assert.equal(hits.length, 1)
    assert.equal(hits[0]?.entry.id, entry.id)
    assert.equal(hits[0]?.entry.text, "the build box runs Go 1.23")

    const again = memory.remember({ kind: "fact", text: "the  build box runs Go 1.23." })
    assert.equal(again.id, entry.id)
    assert.equal(memory.recall({ text: "build box", limit: 5 }).length, 1)
  } finally {
    db.close()
  }
})

test("the kinds the engine does not know are reported as fact, not dropped", async () => {
  const db = openMemoryDb(":memory:")
  try {
    addMemory(db, { text: "窗口压缩在每轮开始前做", kind: "decision", importance: 0.9 })
    const memory = createSqliteAgentMemory({ db })
    assert.equal(engineKind("decision"), "fact")
    const hits = memory.recall({ text: "窗口压缩", limit: 5 })
    assert.equal(hits.length, 1, "a decision is still recallable")
    assert.equal(hits[0]?.entry.kind, "fact", "the wire type has no `decision`")
    assert.equal(memory.recall({ text: "窗口压缩", kinds: ["fact"], limit: 5 }).length, 1)
    assert.equal(memory.recall({ text: "窗口压缩", kinds: ["skill"], limit: 5 }).length, 0)
  } finally {
    db.close()
  }
})

test("a two-character Chinese query finds the memory through the LIKE fallback", async () => {
  const db = openMemoryDb(":memory:")
  try {
    addMemory(db, { text: "编译很慢，要加缓存", kind: "fact" })
    addMemory(db, { text: "部署走 herdr", kind: "fact" })
    const memory = createSqliteAgentMemory({ db })

    const hits = memory.recall({ text: "编译", limit: 5 })
    assert.equal(hits.length, 1, "「编译」 is two characters: trigram cannot answer, LIKE must")
    assert.match(hits[0]?.entry.text ?? "", /编译很慢/)

    assert.equal(memory.recall({ text: "缓", limit: 5 }).length, 1)
    assert.equal(memory.recall({ text: "缓存", limit: 5 }).length, 1)
    assert.equal(memory.recall({ text: "机器人", limit: 5 }).length, 0)
  } finally {
    db.close()
  }
})

test("a long Chinese message is fanned out into terms that find something", () => {
  const terms = searchTerms("我们上次说的那个编译很慢的问题，你还记得吗")
  assert.ok(terms.length > 3, `expected several terms, got ${JSON.stringify(terms)}`)
  assert.ok(terms.includes("编译很"), "three-character CJK n-grams feed the trigram index")
  assert.ok(terms.includes("编译"), "two-character CJK n-grams feed the LIKE fallback")

  const db = openMemoryDb(":memory:")
  try {
    addMemory(db, { text: "编译很慢，要加缓存", kind: "fact" })
    addMemory(db, { text: "部署走 herdr", kind: "fact" })
    const memory = createSqliteAgentMemory({ db })
    const hits = memory.recall({ text: "我们上次说的那个编译很慢的问题，你还记得吗", limit: 5 })
    assert.equal(hits.length, 1, "a sentence, not a keyword, must still recall")
    assert.match(hits[0]?.entry.text ?? "", /编译很慢/)
  } finally {
    db.close()
  }
})

test("a superseded memory is not recalled, and its replacement is", async () => {
  const db = openMemoryDb(":memory:")
  try {
    const old = addMemory(db, { text: "Go 活在构建机上", kind: "fact" })
    const replacement = addMemory(db, { text: "Go 换到笔记本上了", kind: "fact" })
    assert.equal(supersedeMemory(db, old.memory.id, replacement.memory.id), true)

    const memory = createSqliteAgentMemory({ db })
    const hits = memory.recall({ text: "Go 在哪台机器", limit: 5 })
    assert.equal(hits.length, 1)
    assert.equal(hits[0]?.entry.id, replacement.memory.id)
    assert.equal(hits[0]?.entry.supersededBy, undefined)

    const gone = addMemory(db, { text: "部署走 herdr", kind: "fact" })
    db.prepare("UPDATE memories SET superseded_by = ? WHERE id = ?").run(`deleted:${gone.memory.id}`, gone.memory.id)
    assert.ok(!memory.recall({ text: "部署走 herdr", limit: 5 }).some((hit) => hit.entry.id === gone.memory.id))

    const all = memory.recall({ text: "Go", includeSuperseded: true, limit: 5 })
    assert.ok(all.length >= 2, "includeSuperseded shows the chain")
  } finally {
    db.close()
  }
})

test("editing a memory re-indexes it: the old text stops matching", async () => {
  const db = openMemoryDb(":memory:")
  try {
    const row = addMemory(db, { text: "the build box runs Go", kind: "fact" })
    updateMemory(db, row.memory.id, { text: "the laptop runs Go" })
    const memory = createSqliteAgentMemory({ db })
    assert.equal(memory.recall({ text: "build box", limit: 5 }).length, 0, "the old text is gone from the index")
    assert.equal(memory.recall({ text: "laptop runs", limit: 5 }).length, 1)
  } finally {
    db.close()
  }
})

test("a broken database answers recall with nothing and refuses to pretend to remember", () => {
  const memory = createSqliteAgentMemory({ db: undefined, warn: () => undefined })
  assert.deepEqual(memory.recall({ text: "anything" }), [], "a degraded database must not break a turn")
  assert.throws(() => memory.remember({ kind: "fact", text: "x" }), /unavailable/)
})

test("toEntry carries the log position a memory came from", () => {
  const db = openMemoryDb(":memory:")
  try {
    const row = addMemory(db, { text: "a fact", sourceSeqs: [3, 7], now: new Date("2026-11-20T08:00:00.000Z") })
    const entry = toEntry(row.memory)
    assert.equal(entry.seq, 7)
    assert.equal(entry.ts, "2026-11-20T08:00:00.000Z")
    assert.equal(entry.kind, "fact")
  } finally {
    db.close()
  }
})

test("search_context lists memories as memories, ahead of the event hits", async () => {
  const dir = await home()
  const eventsFile = path.join(dir, "sessions", "main", "events.jsonl")
  const db = openMemoryDb(":memory:")
  try {
    addMemory(db, { text: "编译很慢，要加缓存", kind: "decision", importance: 0.9 })

    const index = createMemoryIndex({ agentHome: dir, eventsFile })
    try {
      const tool = createSearchContextTool({ index, db })
      const result = await tool.execute({ query: "编译" }, context)
      assert.equal(result.ok, true)
      assert.match(result.output, /\[[\d-]+ [\d:]+ memory mem-[\w-]+\] 编译很慢，要加缓存/)
      assert.doesNotMatch(result.output, /no matches/)

      const nothing = await tool.execute({ query: "量子纠缠" }, context)
      assert.match(nothing.output, /no matches/)

      const paged = await tool.execute({ query: "编译", before: 5 }, context)
      assert.match(paged.output, /no matches/)
    } finally {
      index.close()
    }
  } finally {
    db.close()
  }
})
