import assert from "node:assert/strict"
import { appendFile, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, test } from "node:test"
import { SCHEMA_VERSION, lastIndexedSeq, memoryDbPath, openMemoryDb, schemaVersion } from "../../src/memory/db.ts"
import {
  DEFAULT_SEARCH_LIMIT,
  INDEX_BODY_LIMIT,
  MAX_SEARCH_LIMIT,
  SNIPPET_LEAD,
  SNIPPET_LIMIT,
  createMemoryIndex,
  eventBody,
  snippet,
  type MemoryIndex,
} from "../../src/memory/index.ts"
import { createSearchContextTool, eventKind, formatEventTime } from "../../src/memory/tools.ts"
import { JobRunner } from "../../src/jobs/runner.ts"
import { createTools } from "../../src/tools/index.ts"

const dirs: string[] = []

async function tempAgent(): Promise<{ home: string; eventsFile: string }> {
  const home = await mkdtemp(path.join(tmpdir(), "ctrl-memory-"))
  dirs.push(home)
  return { home, eventsFile: path.join(home, "sessions", "main", "events.jsonl") }
}

after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})

interface Draft {
  type: string
  data: Record<string, unknown>
  ts?: string
  seq?: number
}

function line(event: Draft, index: number): string {
  const seq = event.seq ?? index
  return JSON.stringify({
    id: `evt-${seq}`,
    seq,
    ts: event.ts ?? `2026-11-20T07:5${seq % 10}:00.000Z`,
    type: event.type,
    data: event.data,
  })
}

async function writeLog(file: string, events: Draft[]): Promise<void> {
  const body = events.map((event, index) => `${line(event, index)}\n`).join("")
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, body, "utf8")
}

async function appendLog(file: string, events: Draft[], offset: number): Promise<void> {
  const body = events.map((event, index) => `${line(event, offset + index)}\n`).join("")
  await appendFile(file, body, "utf8")
}

const MIXED: Draft[] = [
  { type: "session_created", data: { cwd: "/w", model: "fake-model" } },
  { type: "user_message", data: { text: "帮我统计 .ts 文件的数量" } },
  { type: "tool_call", data: { callId: "c1", name: "bash", args: { command: 'find . -name "*.ts" | wc -l' } } },
  { type: "tool_result", data: { callId: "c1", name: "bash", ok: true, output: 'find . -name "*.ts" | wc -l → 12' } },
  { type: "assistant_message", data: { text: "there are 12 ts files, and the hw-foo build is slow" } },
  { type: "error", data: { message: "provider said hw- is not a thing", fatal: false } },
  { type: "memory_write", data: { memoryId: "mem-1", kind: "fact", text: "the workspace is /w" } },
  { type: "compaction", data: { summary: "we counted ts files and talked about the hw- build", firstKeptSeq: 0 } },
  { type: "assistant_pending", data: { model: "fake-model", step: 1 } },
  { type: "memory_recall", data: { memoryIds: ["mem-1"], query: "ts files" } },
]

interface Bag {
  home: string
  eventsFile: string
  index: MemoryIndex
  warnings: string[]
}

async function open(events: Draft[] = MIXED, opts: { dbPath?: string } = {}): Promise<Bag> {
  const { home, eventsFile } = await tempAgent()
  await writeLog(eventsFile, events)
  const warnings: string[] = []
  const index = createMemoryIndex({
    agentHome: home,
    eventsFile,
    ...(opts.dbPath !== undefined ? { dbPath: opts.dbPath } : {}),
    warn: (message) => warnings.push(message),
  })
  index.importEvents()
  return { home, eventsFile, index, warnings }
}

test("memory.db is created next to the agent, with WAL, foreign keys and the whole §4 schema", async () => {
  const { home } = await tempAgent()
  const file = memoryDbPath(home)
  assert.equal(file, path.join(home, "memory.db"))

  const db = openMemoryDb(file)
  try {
    assert.equal(String(db.prepare("PRAGMA journal_mode").get()?.journal_mode), "wal")
    assert.equal(Number(db.prepare("PRAGMA foreign_keys").get()?.foreign_keys), 1)

    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all() as Array<{
      name: string
    }>).map((row) => row.name)
    for (const table of [
      "events",
      "turns",
      "memories",
      "memory_edges",
      "summaries",
      "focus",
      "events_fts",
      "memories_fts",
      "meta",
      "dream_runs",
    ]) {
      assert.ok(names.includes(table), `missing table ${table} (got ${names.join(", ")})`)
    }

    const ftsSql = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'events_fts'").get() as { sql: string }).sql
    assert.match(ftsSql, /tokenize='trigram'/)
    assert.match(ftsSql, /content=''/)

    assert.equal(schemaVersion(db), SCHEMA_VERSION)
    assert.equal(String(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value), String(SCHEMA_VERSION))
    assert.equal(lastIndexedSeq(db), -1, "an empty mirror has indexed nothing")

    for (const table of ["turns", "memories", "summaries", "focus", "dream_runs"]) {
      assert.equal(Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n), 0, `${table} is empty in M1`)
    }
  } finally {
    db.close()
  }
  assert.ok(existsSync(file))
})

test("opening an existing database twice keeps the schema and the mirrored rows", async () => {
  const bag = await open()
  const stats = bag.index.stats()
  bag.index.close()

  const again = createMemoryIndex({ agentHome: bag.home, eventsFile: bag.eventsFile, warn: () => {} })
  try {
    assert.equal(again.stats().events, stats.events, "a re-open does not lose the mirror")
    assert.equal(again.stats().lastSeq, stats.lastSeq)
  } finally {
    again.close()
  }
})

test("every event is mirrored; only the ones with text are indexed", async () => {
  const bag = await open()
  try {
    const stats = bag.index.stats()
    assert.equal(stats.events, MIXED.length, "the mirror holds every event, indexable or not")
    assert.equal(
      stats.indexed,
      7,
      "session_created, assistant_pending and memory_recall have no body to index",
    )
    assert.equal(stats.lastSeq, MIXED.length - 1)
    assert.deepEqual(bag.warnings, [], "a healthy import says nothing")
  } finally {
    bag.index.close()
  }
})

test("import is idempotent: a second pass writes nothing and does not double the index", async () => {
  const bag = await open()
  try {
    const first = bag.index.stats()
    const again = bag.index.importEvents()
    assert.ok(again)
    assert.equal(again.added, 0)
    assert.equal(again.updated, 0)
    assert.equal(again.unchanged, MIXED.length)
    assert.equal(bag.index.stats().events, first.events)

    const hits = bag.index.search("文件", { limit: MAX_SEARCH_LIMIT })
    assert.deepEqual(hits.map((hit) => hit.seq), [1])
  } finally {
    bag.index.close()
  }
})

test("import is incremental, and a gap in the log advances to the highest seq seen", async () => {
  const bag = await open()
  try {
    await appendLog(bag.eventsFile, [{ type: "user_message", data: { text: "第二轮：又数了一遍 12 个文件" } }], MIXED.length)
    let result = bag.index.importEvents()
    assert.ok(result)
    assert.equal(result.added, 1)
    assert.equal(result.unchanged, MIXED.length)
    assert.equal(result.lastSeq, MIXED.length)

    await appendLog(bag.eventsFile, [{ type: "user_message", data: { text: "跳号之后的一条" }, seq: 40 }], 40)
    result = bag.index.importEvents()
    assert.ok(result)
    assert.equal(result.added, 1)
    assert.equal(result.lastSeq, 40)
    assert.equal(bag.index.stats().lastSeq, 40)

    const db = openMemoryDb(memoryDbPath(bag.home))
    try {
      assert.equal(lastIndexedSeq(db), 40)
    } finally {
      db.close()
    }
  } finally {
    bag.index.close()
  }
})

test("a torn tail is skipped, not fatal, and is picked up once it is whole", async () => {
  const bag = await open()
  try {
    await appendFile(bag.eventsFile, '{"id":"broken","seq":10,"type":"user_mes', "utf8")
    const torn = bag.index.importEvents()
    assert.ok(torn)
    assert.equal(torn.skipped, 1)
    assert.equal(torn.added, 0)
    assert.equal(torn.lastSeq, MIXED.length - 1)

    await appendFile(bag.eventsFile, 'sage","ts":"2026-11-20T08:00:00.000Z","data":{"text":"补完的一行"}}\n', "utf8")
    const healed = bag.index.importEvents()
    assert.ok(healed)
    assert.equal(healed.added, 1)
    assert.equal(healed.lastSeq, 10)
    assert.deepEqual(bag.index.search("补完").map((hit) => hit.seq), [10])
  } finally {
    bag.index.close()
  }
})

test("the mirror is derived: deleting memory.db and importing again rebuilds it", async () => {
  const bag = await open()
  bag.index.close()
  const before = (await readFile(bag.eventsFile, "utf8")).split("\n").filter((l) => l.trim() !== "").length
  await unlink(memoryDbPath(bag.home))

  const rebuilt = createMemoryIndex({ agentHome: bag.home, eventsFile: bag.eventsFile, warn: () => {} })
  try {
    rebuilt.importEvents()
    assert.equal(rebuilt.stats().events, before)
    assert.deepEqual(
      rebuilt.search("hw-").map((hit) => hit.seq).sort((a, b) => a - b),
      [4, 5, 7],
      "the rebuilt index finds the same events",
    )
  } finally {
    rebuilt.close()
  }
})

test("a two-character Chinese query falls back to a substring scan", async () => {
  const bag = await open()
  try {
    const hits = bag.index.search("统计")
    assert.deepEqual(hits.map((hit) => hit.seq), [1])
    assert.equal(hits[0]?.type, "user_message")
    assert.match(hits[0]?.body ?? "", /统计/)

    assert.equal(hits[0]?.score, 0, "the fallback has no bm25 score")
  } finally {
    bag.index.close()
  }
})

test("three or more Chinese characters go through the trigram index", async () => {
  const bag = await open()
  try {
    for (const query of ["文件的数量", "帮我统"]) {
      const hits = bag.index.search(query)
      assert.deepEqual(hits.map((hit) => hit.seq), [1], query)

      assert.ok((hits[0]?.score ?? 0) < 0, `bm25 score for ${query} was ${hits[0]?.score}`)
    }

    const db = openMemoryDb(memoryDbPath(bag.home))
    try {
      const raw = db
        .prepare("SELECT bm25(events_fts) AS score FROM events_fts WHERE events_fts MATCH ? ORDER BY score ASC LIMIT 1")
        .get('"帮我统"')
      const expected = Number(raw?.score)
      assert.ok(expected < 0, `the database itself reports ${expected}`)
      assert.equal(bag.index.search("帮我统")[0]?.score, expected)
    } finally {
      db.close()
    }
  } finally {
    bag.index.close()
  }
})

test("English words search the index the same way", async () => {
  const bag = await open()
  try {
    const hits = bag.index.search("provider")
    assert.deepEqual(hits.map((hit) => hit.seq), [5])
    assert.equal(hits[0]?.type, "error")
    assert.match(hits[0]?.body ?? "", /provider said hw- is not a thing/)
  } finally {
    bag.index.close()
  }
})

test("punctuation is content, not FTS5 syntax: `hw-` must not throw", async () => {
  const bag = await open()
  try {
    const hits = bag.index.search("hw-")

    assert.deepEqual(hits.map((hit) => hit.seq).sort((a, b) => a - b), [4, 5, 7])
    assert.deepEqual(bag.index.search("==="), [], "a query with no match is empty, not an error")
    assert.deepEqual(bag.index.search('"""'), [], "quotes are escaped, not passed through")
  } finally {
    bag.index.close()
  }
})

test("before pages backwards through a substring scan", async () => {
  const bag = await open([
    { type: "user_message", data: { text: "第一页 分页 测试" } },
    { type: "user_message", data: { text: "第二页 分页 测试" } },
    { type: "user_message", data: { text: "第三页 分页 测试" } },
  ])
  try {
    const first = bag.index.search("分页", { limit: 2 })
    assert.deepEqual(first.map((hit) => hit.seq), [2, 1], "substring hits are newest first")

    const oldest = Math.min(...first.map((hit) => hit.seq))
    const second = bag.index.search("分页", { limit: 2, beforeSeq: oldest })
    assert.deepEqual(second.map((hit) => hit.seq), [0])

    const beyond = bag.index.search("分页", { limit: 2, beforeSeq: 0 })
    assert.deepEqual(beyond, [], "there is nothing older than seq 0")
  } finally {
    bag.index.close()
  }
})

test("before also pages the trigram index", async () => {
  const bag = await open()
  try {
    const all = bag.index.search("hw-")
    assert.equal(all.length, 3)
    const newest = Math.max(...all.map((hit) => hit.seq))
    const older = bag.index.search("hw-", { beforeSeq: newest })
    assert.deepEqual(older.map((hit) => hit.seq).sort((a, b) => a - b), [4, 5], `seq ${newest} is excluded by the paging bound`)
  } finally {
    bag.index.close()
  }
})

test("an empty query is nothing, not everything", async () => {
  const bag = await open()
  try {
    assert.deepEqual(bag.index.search(""), [])
    assert.deepEqual(bag.index.search("   "), [])
    assert.deepEqual(bag.index.search("\n\t"), [])
  } finally {
    bag.index.close()
  }
})

test("the limit is clamped to 1..MAX_SEARCH_LIMIT", async () => {
  const events: Draft[] = []
  for (let index = 0; index < 30; index += 1) {
    events.push({ type: "user_message", data: { text: `重复的 命中 ${index}` } })
  }
  const bag = await open(events)
  try {
    assert.equal(bag.index.search("命中").length, DEFAULT_SEARCH_LIMIT)
    assert.equal(bag.index.search("命中", { limit: 3 }).length, 3)
    assert.equal(bag.index.search("命中", { limit: 500 }).length, MAX_SEARCH_LIMIT)
    assert.equal(bag.index.search("命中", { limit: 0 }).length, 1, "0 clamps up to one, never to none")
  } finally {
    bag.index.close()
  }
})

test("a hit body is a 400-character window around the match", async () => {
  const filler = "abcdefghij".repeat(80)
  const body = `${filler}NEEDLE${filler}`
  const bag = await open([{ type: "user_message", data: { text: body } }])
  try {
    const hits = bag.index.search("NEEDLE")
    assert.equal(hits.length, 1)
    const text = hits[0]?.body ?? ""
    assert.ok(Array.from(text).length <= SNIPPET_LIMIT, `snippet is ${Array.from(text).length} chars`)
    assert.ok(text.includes("NEEDLE"), "the match itself is always inside the window")
    assert.ok(text.startsWith("…"), "a window cut from the middle says so")
  } finally {
    bag.index.close()
  }
})

test("snippet keeps 120 characters before the match and never exceeds the budget", () => {
  const body = `${"a".repeat(500)}TARGET${"b".repeat(500)}`
  const cut = snippet(body, "TARGET")
  assert.ok(Array.from(cut).length <= SNIPPET_LIMIT, `snippet is ${Array.from(cut).length} chars`)
  assert.match(cut, /TARGET/)

  const withoutHead = cut.startsWith("…") ? cut.slice(1) : cut
  assert.equal(withoutHead.indexOf("TARGET"), SNIPPET_LEAD, "120 characters of context before the hit")
  assert.ok(cut.endsWith("…"), "the window is cut on both sides")

  assert.equal(snippet("short body", "body"), "short body", "a body under the budget is not touched")
  assert.ok(snippet(body, "NOPE").startsWith("aaa"), "no match means the head of the body")
  assert.equal(snippet(body, ""), snippet(body, "NOPE"), "an empty query is not a match")
})

test("eventBody: one body per event type, and none for lifecycle noise", () => {
  assert.equal(eventBody("user_message", { text: "hello" }), "hello")
  assert.equal(eventBody("assistant_message", { text: "hi there" }), "hi there")
  assert.equal(eventBody("tool_call", { name: "bash", args: { command: "ls" } }), 'bash {"command":"ls"}')
  assert.equal(eventBody("tool_result", { output: "12" }), "12")
  assert.equal(eventBody("error", { message: "boom" }), "boom")
  assert.equal(eventBody("memory_write", { memoryId: "m", kind: "fact", text: "a fact" }), "a fact")
  assert.equal(eventBody("compaction", { summary: "we did things", firstKeptSeq: 3 }), "we did things")
  assert.equal(eventBody("session_created", { cwd: "/w", model: "m" }), undefined)
  assert.equal(eventBody("assistant_pending", { model: "m", step: 1 }), undefined)
  assert.equal(eventBody("memory_recall", { memoryIds: [], query: "q" }), undefined)
  assert.equal(eventBody("user_message", { text: "   " }), undefined, "blank text is not indexed")
  assert.equal(eventBody("user_message", {}), undefined)

  const long = eventBody("tool_result", { output: "x".repeat(5_000) }) ?? ""
  assert.equal(Array.from(long).length, INDEX_BODY_LIMIT)
})

test("search_context renders one line per hit with time, seq and kind", async () => {
  const bag = await open()
  const tool = createSearchContextTool({ index: bag.index })
  try {
    assert.equal(tool.name, "search_context")
    assert.deepEqual(tool.parameters.required, ["query"])

    const result = await tool.execute({ query: "文件" }, fakeContext())
    assert.equal(result.ok, true)
    const lines = result.output.split("\n")
    assert.equal(lines.length, 1, "one hit, no paging hint")
    assert.equal(lines[0], "[2026-11-20 07:51:00 seq 1 user] 帮我统计 .ts 文件的数量")

    const many = await tool.execute({ query: "hw-", limit: 2 }, fakeContext())
    assert.equal(many.ok, true)
    const rows = many.output.split("\n")
    assert.equal(rows.length, 3, "two hits plus the hint")
    assert.match(rows[0] ?? "", /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} seq \d+ (assistant|error|compaction)\] /)
    const seqs = rows.slice(0, 2).map((row) => Number(/seq (\d+)/.exec(row)?.[1]))
    assert.equal(rows.at(-1), `(older: search_context with before=${Math.min(...seqs)})`, "the hint carries the smallest seq")
  } finally {
    bag.index.close()
  }
})

test("search_context answers no-matches instead of failing", async () => {
  const bag = await open()
  const tool = createSearchContextTool({ index: bag.index })
  try {
    const result = await tool.execute({ query: "不存在的东西" }, fakeContext())
    assert.deepEqual(result, { ok: true, output: 'no matches for "不存在的东西"' })

    const empty = await tool.execute({ query: "   " }, fakeContext())
    assert.equal(empty.ok, true)
    assert.match(empty.output, /non-empty query/)
  } finally {
    bag.index.close()
  }
})

test("search_context renders paging hints only when the page is full", async () => {
  const bag = await open(
    [1, 2, 3].map((n) => ({ type: "user_message", data: { text: `第 ${n} 条 分页 命中` } })),
  )
  const tool = createSearchContextTool({ index: bag.index })
  try {
    const full = await tool.execute({ query: "分页", limit: 2 }, fakeContext())
    const rows = full.output.split("\n")
    assert.equal(rows.length, 3)
    assert.equal(rows.at(-1), "(older: search_context with before=1)")

    const partial = await tool.execute({ query: "分页", limit: 10 }, fakeContext())
    assert.equal(partial.output.split("\n").length, 3, "three hits, no hint")
    assert.doesNotMatch(partial.output, /older: search_context/)
  } finally {
    bag.index.close()
  }
})

test("a long tool result is flattened to one line in the transcript", async () => {
  const bag = await open([{ type: "tool_result", data: { output: "line one\nline two\n\nline three 命中" } }])
  const tool = createSearchContextTool({ index: bag.index })
  try {
    const result = await tool.execute({ query: "命中" }, fakeContext())
    assert.equal(result.ok, true)
    assert.match(result.output, /line one line two line three 命中/)
  } finally {
    bag.index.close()
  }
})

test("the tool set is seven: the three job tools, search_context, focus_set, remember and recall", async () => {
  const bag = await open()
  try {
    const runner = new JobRunner({ agentHome: bag.home, model: "fake-model", thinking: "max" })
    const tools = createTools({ agentHome: bag.home, runner, memory: bag.index })
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ["delegate", "job_status", "job_stop", "search_context", "focus_set", "remember", "recall"],
    )

    const search = tools.find((tool) => tool.name === "search_context")
    assert.ok(search, "search_context must be advertised to the model")
    assert.deepEqual(search.parameters.required, ["query"])
    const properties = search.parameters.properties as Record<string, { type: string; minimum?: number; maximum?: number }>
    assert.equal(properties.query?.type, "string")
    assert.equal(properties.limit?.type, "integer")
    assert.equal(properties.limit?.maximum, MAX_SEARCH_LIMIT)
    assert.equal(properties.before?.type, "integer")
  } finally {
    bag.index.close()
  }
})

test("a database that will not open degrades to empty results instead of throwing", async () => {
  const { home, eventsFile } = await tempAgent()
  await writeLog(eventsFile, MIXED)

  const blocker = path.join(home, "not-a-dir")
  await writeFile(blocker, "x", "utf8")

  const warnings: string[] = []
  const index = createMemoryIndex({
    agentHome: home,
    eventsFile,
    dbPath: path.join(blocker, "memory.db"),
    warn: (message) => warnings.push(message),
  })
  try {
    assert.equal(index.available, false)
    assert.ok(index.error)
    assert.equal(warnings.length, 1, "one warning, not one per call")
    assert.match(warnings[0] ?? "", /memory index disabled/)
    assert.match(index.error ?? "", /memory index disabled/)

    assert.deepEqual(index.search("hw-"), [])
    assert.equal(index.importEvents(), undefined, "a degraded index has nothing to report")

    const tool = createSearchContextTool({ index })
    const result = await tool.execute({ query: "hw-" }, fakeContext())
    assert.equal(result.ok, true, "a broken index must not break the turn")
    assert.match(result.output, /search_context is unavailable/)

    assert.equal(warnings.length, 1)
  } finally {
    index.close()
  }
})

test("time and kind helpers match the line the model reads", () => {
  assert.equal(formatEventTime("2026-11-20T07:52:56.123Z"), "2026-11-20 07:52:56")
  assert.equal(formatEventTime("not a timestamp"), "not a timestamp")
  assert.equal(eventKind("user_message"), "user")
  assert.equal(eventKind("assistant_message"), "assistant")
  assert.equal(eventKind("tool_result"), "tool_result")
  assert.equal(eventKind("compaction"), "compaction")
})

function fakeContext() {
  return { cwd: "/w", allowBash: false, timeoutMs: 10_000, maxOutputChars: 8_000 }
}
