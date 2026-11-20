// M3 — dreaming (MEMORY.md §7 §10.1).
//
// The model is scripted, so every test is about the *write path*: what a good
// answer becomes, what a duplicate becomes, what a bad answer must not become.
// The two rules the spec is emphatic about get their own tests: a memory that
// is replaced is superseded (never deleted), and a dream that fails changes
// nothing and does not move `last_dream_seq`.
//
// The database is a real SQLite file (`:memory:`), the profile is a real file,
// and the events are the shapes pi-durable writes — nothing here is stubbed
// below the model.

import assert from "node:assert/strict"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, test } from "node:test"
import type { DatabaseSync } from "node:sqlite"
import { openMemoryDb } from "../../src/memory/db.ts"
import {
  DREAM_MAX_CHARS,
  DREAM_MAX_EVENTS,
  DreamController,
  buildDreamPrompt,
  dreamBatch,
  extractJsonObject,
  lastDreamAt,
  lastDreamSeq,
  listDreamRuns,
  parseDreamPayload,
  readProfile,
  runDream,
  writeProfile,
  type DreamLlm,
  type DreamResult,
} from "../../src/memory/dream.ts"
import type { LogEvent } from "../../src/memory/events.ts"
import { getFocus, listFocus, upsertFocus } from "../../src/memory/focus.ts"
import { addMemory, getMemory, listMemories, liveMemoryCount } from "../../src/memory/memories.ts"
import { createFocusSetTool } from "../../src/memory/tools.ts"

const dirs: string[] = []

after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})

async function tempHome(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "ctrl-dream-"))
  dirs.push(home)
  return home
}

interface Draft {
  type: string
  data: Record<string, unknown>
}

function log(...drafts: Draft[]): LogEvent[] {
  return drafts.map((draft, seq) => ({
    seq,
    ts: `2026-11-20T07:5${seq % 10}:00.000Z`,
    type: draft.type,
    data: draft.data,
  }))
}

/** A deterministic clock: every read is one more second. */
function clock(): () => Date {
  let at = Date.parse("2026-11-20T08:00:00.000Z")
  return () => new Date((at += 1_000))
}

function scriptedDreamLlm(reply: string | string[]): { llm: DreamLlm; prompts: string[] } {
  const prompts: string[] = []
  const texts: string[] = typeof reply === "string" ? [reply] : [...reply]
  let index = 0
  return {
    prompts,
    llm: {
      async complete(request) {
        prompts.push(request.messages.map((message) => message.content).join("\n\n"))
        const text = texts[Math.min(index, texts.length - 1)] ?? ""
        index += 1
        return { text }
      },
    },
  }
}

function throwingDreamLlm(message: string): DreamLlm {
  return {
    async complete() {
      throw new Error(message)
    },
  }
}

const CONVERSATION = log(
  { type: "user_message", data: { text: "我们继续做记忆系统，先做窗口压缩" } },
  { type: "assistant_message", data: { text: "好，窗口压缩放在每轮开始前" } },
)

interface Bag {
  db: DatabaseSync
  agentHome: string
  now: () => Date
}

async function bag(): Promise<Bag> {
  const agentHome = await tempHome()
  return { db: openMemoryDb(":memory:"), agentHome, now: clock() }
}

// ---------------------------------------------------------------------------
// one good dream
// ---------------------------------------------------------------------------

test("a dream writes memories, focus and the profile, and moves the watermark", async () => {
  const opened = await bag()
  const reply = JSON.stringify({
    memories: [
      {
        kind: "decision",
        text: "窗口压缩在每轮开始前做",
        tags: ["memory", "m2"],
        importance: 0.8,
        sourceSeqs: [0, 1],
        supersedes: [],
      },
    ],
    focus: [{ text: "实现 M2 窗口", state: "doing" }],
    profileRewrite: "# Profile\n\n- 喜欢简洁的回答",
  })
  const { llm, prompts } = scriptedDreamLlm(reply)

  const result = await runDream({ db: opened.db, agentHome: opened.agentHome, events: CONVERSATION, llm, now: opened.now })
  try {
    assert.equal(result.error, undefined, `unexpected error: ${result.error}`)
    assert.equal(result.added, 1)
    assert.equal(result.merged, 0)
    assert.equal(result.superseded, 0)
    assert.equal(result.focus, 1)
    assert.equal(result.profileRewritten, true)
    assert.equal(result.batchEvents, 2)
    assert.equal(result.fromSeq, 0)
    assert.equal(result.toSeq, 1)

    // The memory, with what the model declared: kind, tags, importance, source.
    const rows = listMemories(opened.db)
    assert.equal(rows.length, 1)
    const memory = rows[0]
    assert.equal(memory?.kind, "decision")
    assert.equal(memory?.text, "窗口压缩在每轮开始前做")
    assert.deepEqual(memory?.tags, ["memory", "m2"])
    assert.equal(memory?.importance, 0.8)
    assert.equal(memory?.sourceFrom, 0)
    assert.equal(memory?.sourceTo, 1)

    // focus: created by the dream, in the state the model asked for.
    const focus = listFocus(opened.db)
    assert.equal(focus.length, 1)
    assert.equal(focus[0]?.text, "实现 M2 窗口")
    assert.equal(focus[0]?.state, "doing")
    assert.equal(getFocus(opened.db, focus[0]?.id ?? "")?.source, "dream")

    // profile.md, and the prompt carried the events.
    assert.match(readProfile(opened.agentHome) ?? "", /喜欢简洁的回答/)
    assert.match(prompts[0] ?? "", /窗口压缩放在每轮开始前/)
    assert.match(prompts[0] ?? "", /Reply with ONE JSON object/)

    // meta + dream_runs (MEMORY.md §4 §10.1).
    assert.equal(lastDreamSeq(opened.db), 1, "the watermark moved to the last dreamt seq")
    assert.equal(typeof lastDreamAt(opened.db), "string")
    const runs = listDreamRuns(opened.db)
    assert.equal(runs.length, 1)
    assert.equal(runs[0]?.id, result.id)
    assert.equal(runs[0]?.added, 1)
    assert.equal(runs[0]?.fromSeq, 0)
    assert.equal(runs[0]?.toSeq, 1)
    assert.equal(runs[0]?.error, undefined)
    assert.equal(runs[0]?.endedAt !== undefined, true)
  } finally {
    opened.db.close()
  }
})

// ---------------------------------------------------------------------------
// dedupe and supersede
// ---------------------------------------------------------------------------

test("the same fact said twice becomes one memory (normalised)", async () => {
  const opened = await bag()
  const first = addMemory(opened.db, { text: "The workspace is /w", kind: "fact" })
  const { llm } = scriptedDreamLlm(
    JSON.stringify({ memories: [{ text: "the  WORKSPACE is /w.", tags: ["w"], importance: 0.9 }] }),
  )
  const result = await runDream({ db: opened.db, agentHome: opened.agentHome, events: CONVERSATION, llm, now: opened.now })
  try {
    assert.equal(result.added, 0, "a duplicate is not added")
    assert.equal(result.merged, 1, "it is merged into the row that exists")
    assert.equal(liveMemoryCount(opened.db), 1)
    const row = getMemory(opened.db, first.memory.id)
    assert.deepEqual(row?.tags, ["w"], "the new tags survive the merge")
    assert.equal(row?.importance, 0.9, "importance takes the higher of the two")
  } finally {
    opened.db.close()
  }
})

test("a replaced fact is superseded, never deleted", async () => {
  const opened = await bag()
  const old = addMemory(opened.db, { text: "Go lives on the build box", kind: "fact" })
  const { llm } = scriptedDreamLlm(
    JSON.stringify({ memories: [{ text: "Go moved to the laptop", supersedes: [old.memory.id] }] }),
  )
  const result = await runDream({ db: opened.db, agentHome: opened.agentHome, events: CONVERSATION, llm, now: opened.now })
  try {
    assert.equal(result.added, 1)
    assert.equal(result.superseded, 1)
    const superseded = getMemory(opened.db, old.memory.id)
    assert.ok(superseded, "the old row is still there")
    assert.ok((superseded?.supersededBy ?? "").startsWith("mem-"), "it points at the row that replaced it")
    assert.notEqual(superseded?.supersededBy, old.memory.id)
    assert.equal(getMemory(opened.db, superseded?.supersededBy ?? "")?.text, "Go moved to the laptop")
    // The default listing hides it; `all` still shows the chain.
    assert.deepEqual(listMemories(opened.db).map((row) => row.text), ["Go moved to the laptop"])
    assert.equal(listMemories(opened.db, { includeSuperseded: true }).length, 2)
    assert.equal(liveMemoryCount(opened.db), 1)
  } finally {
    opened.db.close()
  }
})

test("a supersede of an unknown id is ignored, not an error", async () => {
  const opened = await bag()
  const { llm } = scriptedDreamLlm(JSON.stringify({ memories: [{ text: "a new fact", supersedes: ["mem-gone"] }] }))
  const result = await runDream({ db: opened.db, agentHome: opened.agentHome, events: CONVERSATION, llm, now: opened.now })
  try {
    assert.equal(result.error, undefined)
    assert.equal(result.added, 1)
    assert.equal(result.superseded, 0)
  } finally {
    opened.db.close()
  }
})

// ---------------------------------------------------------------------------
// focus
// ---------------------------------------------------------------------------

test("focus is upserted: by id when one is given, by text otherwise", async () => {
  const opened = await bag()
  const existing = upsertFocus(opened.db, { text: "旧任务", state: "open", source: "agent" })
  const { llm } = scriptedDreamLlm(
    JSON.stringify({
      focus: [{ id: existing.id, state: "done" }, { text: "新任务", state: "doing" }],
    }),
  )
  const result = await runDream({ db: opened.db, agentHome: opened.agentHome, events: CONVERSATION, llm, now: opened.now })
  try {
    assert.equal(result.focus, 2)
    assert.equal(getFocus(opened.db, existing.id)?.state, "done", "the id addressed the existing item")
    const items = listFocus(opened.db)
    assert.equal(items.length, 1, "the finished one is not in the panel")
    assert.equal(items[0]?.text, "新任务")
    assert.equal(items[0]?.state, "doing")
    assert.equal(listFocus(opened.db, { includeDone: true }).length, 2)
  } finally {
    opened.db.close()
  }
})

// ---------------------------------------------------------------------------
// profile
// ---------------------------------------------------------------------------

test("each profile rewrite keeps the previous version in profile.history/", async () => {
  const opened = await bag()
  await runDream({
    db: opened.db,
    agentHome: opened.agentHome,
    events: CONVERSATION,
    llm: scriptedDreamLlm(JSON.stringify({ profileRewrite: "# v1" })).llm,
    now: opened.now,
  })
  await runDream({
    db: opened.db,
    agentHome: opened.agentHome,
    // A second batch: a dream with nothing new does not even call the model.
    events: [...CONVERSATION, { seq: 2, ts: "2026-11-20T07:59:00.000Z", type: "user_message", data: { text: "再做一版画像" } }],
    llm: scriptedDreamLlm(JSON.stringify({ profileRewrite: "# v2" })).llm,
    now: opened.now,
  })
  try {
    assert.match(readProfile(opened.agentHome) ?? "", /# v2/)
    const history = await readdir(path.join(opened.agentHome, "profile.history"))
    assert.equal(history.length, 1, "one backup: the version that was replaced")
    assert.match(history[0] ?? "", /^\d{4}-\d{2}-\d{2}T.*\.md$/)
  } finally {
    opened.db.close()
  }
})

test("writeProfile refuses an empty rewrite instead of erasing the profile", async () => {
  const agentHome = await tempHome()
  writeProfile(agentHome, "# keep me")
  assert.throws(() => writeProfile(agentHome, "   "), /non-empty/)
  assert.match(readProfile(agentHome) ?? "", /keep me/)
})

// ---------------------------------------------------------------------------
// failure: nothing changes
// ---------------------------------------------------------------------------

test("a reply that is not JSON is recorded as an error and moves nothing", async () => {
  const opened = await bag()
  const { llm } = scriptedDreamLlm('Sure! Here you go:\n```json\n{"memories":[{"text":"half')
  const result = await runDream({ db: opened.db, agentHome: opened.agentHome, events: CONVERSATION, llm, now: opened.now })
  try {
    assert.match(String(result.error), /usable JSON/)
    assert.equal(lastDreamSeq(opened.db), -1, "the watermark did not move")
    assert.equal(liveMemoryCount(opened.db), 0)
    const runs = listDreamRuns(opened.db)
    assert.equal(runs.length, 1, "the failure is still a run")
    assert.match(String(runs[0]?.error), /usable JSON/)
  } finally {
    opened.db.close()
  }
})

test("a model that throws is an error row, not an exception", async () => {
  const opened = await bag()
  const result = await runDream({
    db: opened.db,
    agentHome: opened.agentHome,
    events: CONVERSATION,
    llm: throwingDreamLlm("gateway 500"),
    now: opened.now,
  })
  try {
    assert.match(String(result.error), /model call failed: gateway 500/)
    assert.equal(lastDreamSeq(opened.db), -1)
    assert.equal(listDreamRuns(opened.db).length, 1)
    assert.equal(readProfile(opened.agentHome), undefined, "no profile was written")
  } finally {
    opened.db.close()
  }
})

test("a write that fails rolls the whole dream back", async () => {
  const opened = await bag()
  const reply = JSON.stringify({
    memories: [{ text: "first memory" }],
    focus: [{ text: "x", state: "doing" }],
    profileRewrite: "# profile",
  })
  // A read-only database: BEGIN works, every write throws.
  opened.db.exec("PRAGMA query_only = ON")
  const result = await runDream({
    db: opened.db,
    agentHome: opened.agentHome,
    events: CONVERSATION,
    llm: scriptedDreamLlm(reply).llm,
    now: opened.now,
  })
  opened.db.exec("PRAGMA query_only = OFF")
  try {
    assert.match(String(result.error), /dream write failed/)
    assert.equal(liveMemoryCount(opened.db), 0, "nothing was added")
    assert.equal(listFocus(opened.db).length, 0)
    assert.equal(readProfile(opened.agentHome), undefined, "the profile was not written")
    assert.equal(lastDreamSeq(opened.db), -1, "and the watermark did not move")
  } finally {
    opened.db.close()
  }
})

test("an empty payload is a successful dream with nothing to keep", async () => {
  const opened = await bag()
  const { llm } = scriptedDreamLlm("{}")
  const result = await runDream({ db: opened.db, agentHome: opened.agentHome, events: CONVERSATION, llm, now: opened.now })
  try {
    assert.equal(result.error, undefined)
    assert.equal(result.added, 0)
    assert.equal(lastDreamSeq(opened.db), 1, "the batch was read, so it is done")
  } finally {
    opened.db.close()
  }
})

// ---------------------------------------------------------------------------
// the batch
// ---------------------------------------------------------------------------

test("the batch is at most 40 events or 12 000 characters", () => {
  const many = log(...Array.from({ length: 60 }, () => ({ type: "user_message", data: { text: "hello" } })))
  const capped = dreamBatch(many, -1)
  assert.equal(capped.events.length, DREAM_MAX_EVENTS)
  assert.equal(capped.toSeq, DREAM_MAX_EVENTS - 1)

  // One event is clipped to 2 000 chars before it enters a prompt, so ten
  // 5 000-char events fit six times, not twice.
  const fat = log(...Array.from({ length: 10 }, () => ({ type: "user_message", data: { text: "x".repeat(5_000) } })))
  const byChars = dreamBatch(fat, -1)
  assert.equal(byChars.events.length, 6, "6 × 2 000 chars fits in 12 000; the seventh would not")
  assert.equal(byChars.chars, DREAM_MAX_CHARS)

  // A single event bigger than the cap is still taken: otherwise the dream
  // could never move past it.
  const single = dreamBatch(log({ type: "tool_result", data: { output: "y".repeat(20_000) } }), -1)
  assert.equal(single.events.length, 1)
})

test("a dream only reads what came after the last one", async () => {
  const opened = await bag()
  const first = scriptedDreamLlm(JSON.stringify({ memories: [{ text: "from the first dream" }] }))
  await runDream({ db: opened.db, agentHome: opened.agentHome, events: CONVERSATION, llm: first.llm, now: opened.now })
  const before = first.prompts.length

  // Same events, nothing new: no model call, no writes, but a run is recorded.
  const idle = scriptedDreamLlm("{}")
  const second = await runDream({
    db: opened.db,
    agentHome: opened.agentHome,
    events: CONVERSATION,
    llm: idle.llm,
    now: opened.now,
  })
  assert.equal(second.skipped, true)
  assert.equal(second.batchEvents, 0)
  assert.equal(idle.prompts.length, 0, "no model call for an empty batch")
  assert.equal(first.prompts.length, before)
  assert.equal(listDreamRuns(opened.db).length, 2, "the manual run is still visible")

  // A new event brings the batch back, starting after seq 1.
  const grown = [...CONVERSATION, ...log({ type: "user_message", data: { text: "下一步做做梦" } }).map((event) => ({ ...event, seq: 2 }))]
  const third = scriptedDreamLlm("{}")
  const result = await runDream({ db: opened.db, agentHome: opened.agentHome, events: grown, llm: third.llm, now: opened.now })
  assert.equal(result.batchEvents, 1)
  assert.equal(result.fromSeq, 2)
  assert.match(third.prompts[0] ?? "", /下一步做做梦/)
})

test("the dream prompt carries the existing memories with their ids", async () => {
  const opened = await bag()
  const existing = addMemory(opened.db, { text: "the build box runs Go", kind: "fact" })
  const { llm, prompts } = scriptedDreamLlm("{}")
  const events = log({ type: "user_message", data: { text: "the Go build is slow on the laptop" } })
  await runDream({ db: opened.db, agentHome: opened.agentHome, events, llm, now: opened.now })
  try {
    const prompt = prompts[0] ?? ""
    assert.match(prompt, new RegExp(`\\[${existing.memory.id}\\]`), "the id is there to supersede against")
    assert.match(prompt, /the build box runs Go/)
    assert.match(prompt, /Existing memories:/)
  } finally {
    opened.db.close()
  }
})

test("buildDreamPrompt says so when there are no existing memories", () => {
  const batch = dreamBatch(CONVERSATION, -1)
  const prompt = buildDreamPrompt(batch, [])
  assert.match(prompt, /\(none yet\)/)
  assert.match(prompt, /\[seq 0\] user:/)
  assert.match(prompt, /\[seq 1\] assistant:/)
})

// ---------------------------------------------------------------------------
// defensive parsing
// ---------------------------------------------------------------------------

test("extractJsonObject survives fences, prose and braces inside strings", () => {
  assert.equal(extractJsonObject('```json\n{"a":1}\n```'), '{"a":1}')
  assert.equal(extractJsonObject('Sure thing:\n```\n{"a":{"b":2}}\n```\nbye'), '{"a":{"b":2}}')
  assert.equal(extractJsonObject('prose first {"a":1} then more'), '{"a":1}')
  assert.equal(extractJsonObject('{"text":"a } inside { a string"}'), '{"text":"a } inside { a string"}')
  assert.equal(extractJsonObject('{"a":1'), undefined, "a truncated object is not an object")
  assert.equal(extractJsonObject("no json here"), undefined)
  assert.equal(extractJsonObject(""), undefined)
  assert.equal(extractJsonObject("{}"), "{}")
})

test("parseDreamPayload drops what it cannot use and keeps what it can", () => {
  const payload = parseDreamPayload(
    JSON.stringify({
      memories: [
        { text: "  keep me  ", kind: "nonsense", tags: ["a", 1], importance: "high", sourceSeqs: [3, 9] },
        { text: "" },
        {},
        "not an object",
      ],
      focus: [{ text: "  do it  ", state: "doing" }, { id: "foc-1" }, { state: "open" }],
      profileRewrite: "   ",
    }),
  )
  assert.ok(payload)
  assert.equal(payload.memories.length, 1)
  assert.equal(payload.memories[0]?.text, "keep me")
  assert.equal(payload.memories[0]?.kind, undefined, "an unknown kind is dropped, not guessed")
  assert.deepEqual(payload.memories[0]?.tags, ["a"])
  assert.equal(payload.memories[0]?.importance, undefined)
  assert.deepEqual(payload.memories[0]?.sourceSeqs, [3, 9])
  assert.deepEqual(payload.focus.map((item) => item.id ?? item.text), ["do it", "foc-1"])
  assert.equal(payload.profileRewrite, undefined, "a blank rewrite is not a rewrite")
  assert.equal(parseDreamPayload("not json"), undefined)
})

test("supersedes may be a string, an id object, or a list", () => {
  const one = parseDreamPayload('{"memories":[{"text":"x","supersedes":"mem-1"}]}')
  assert.deepEqual(one?.memories[0]?.supersedes, ["mem-1"])
  const objects = parseDreamPayload('{"memories":[{"text":"x","supersedes":[{"id":"mem-2"},"mem-3"]}]}')
  assert.deepEqual(objects?.memories[0]?.supersedes, ["mem-2", "mem-3"])
})

// ---------------------------------------------------------------------------
// the idle trigger (MEMORY.md §10.1 M3)
// ---------------------------------------------------------------------------

test("the controller runs one dream at a time and only when the agent is idle", async () => {
  let started = 0
  let now = 1_000 + 599_999
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const controller = new DreamController({
    run: async () => {
      started += 1
      await gate
      return emptyDream()
    },
    hasWork: () => true,
    busy: () => false,
    lastActivity: () => 1_000,
    idleMs: 600_000,
    now: () => now,
  })

  // Not idle yet.
  assert.equal(controller.tick(), false)
  assert.equal(controller.running, false)

  // Idle: the tick starts a dream, and a second start joins the one in flight.
  now = 1_000 + 600_000
  assert.equal(controller.tick(), true)
  assert.equal(controller.running, true)
  assert.equal(controller.tick(), false, "never two dreams at once")
  const joined = controller.start()
  assert.equal(started, 1, "the second start did not begin a second run")
  release()
  await joined
  await controller.settle()
  assert.equal(controller.running, false)
  assert.equal(started, 1)
  assert.equal(controller.tick(), true, "the slot is free again")
  release()
  await controller.settle()
})

test("the controller stays quiet while a turn is running or there is nothing new", () => {
  const options = {
    run: async () => emptyDream(),
    hasWork: () => false,
    busy: () => false,
    lastActivity: () => 0,
    idleMs: 1,
    now: () => 10_000,
  }
  assert.equal(new DreamController(options).tick(), false, "no new material → no dream")
  assert.equal(new DreamController({ ...options, hasWork: () => true, busy: () => true }).tick(), false)
  assert.equal(new DreamController({ ...options, hasWork: () => true, lastActivity: () => undefined }).tick(), false)
  assert.equal(new DreamController({ ...options, hasWork: () => true }).tick(), true)
})

function emptyDream(): DreamResult {
  return {
    id: "dream-test",
    startedAt: "2026-11-20T08:00:00.000Z",
    endedAt: "2026-11-20T08:00:01.000Z",
    fromSeq: -1,
    toSeq: -1,
    added: 0,
    merged: 0,
    superseded: 0,
    focus: 0,
    profileRewritten: false,
    batchEvents: 0,
  }
}

// ---------------------------------------------------------------------------
// focus_set — the one tool M4 adds
// ---------------------------------------------------------------------------

test("focus_set creates, edits and never throws", async () => {
  const opened = await bag()
  const tool = createFocusSetTool({ db: opened.db })
  const context = { cwd: "/w", allowBash: false, timeoutMs: 10_000, maxOutputChars: 8_000 }
  try {
    assert.equal(tool.name, "focus_set")
    assert.deepEqual(tool.parameters.required, [], "text or id — the model may send either")

    const created = await tool.execute({ text: "修窗口" }, context)
    assert.equal(created.ok, true)
    const id = /\[open\] (\S+)/.exec(created.output)?.[1]
    assert.ok(id, `unexpected output: ${created.output}`)
    assert.match(created.output, /修窗口$/)

    const moved = await tool.execute({ id, state: "doing" }, context)
    assert.match(moved.output, /^\[doing\] /)
    assert.equal(getFocus(opened.db, id ?? "")?.state, "doing")

    const bad = await tool.execute({ text: "x", state: "nonsense" }, context)
    assert.equal(bad.ok, true)
    assert.match(bad.output, /unknown state/)

    const empty = await tool.execute({}, context)
    assert.equal(empty.ok, true)
    assert.match(empty.output, /needs text/)

    const degraded = createFocusSetTool({ db: undefined })
    const unreachable = await degraded.execute({ text: "x" }, context)
    assert.equal(unreachable.ok, true, "a broken database must not break the turn")
    assert.match(unreachable.output, /unavailable/)
  } finally {
    opened.db.close()
  }
})
