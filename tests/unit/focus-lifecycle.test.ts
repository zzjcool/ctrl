import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import { test } from "node:test"
import { SCHEMA_VERSION, migrate, openMemoryDb, schemaVersion } from "../../src/memory/db.ts"
import {
  FocusError,
  STALE_MS,
  formatFocusLine,
  getFocus,
  isStale,
  listFocusForPrompt,
  openFocusCount,
  upsertFocus,
  upsertFocusStrict,
  type FocusItem,
  type UpsertFocusInput,
} from "../../src/memory/focus.ts"
import { STALE_FOCUS_INSTRUCTION, heartbeatText } from "../../src/server/heartbeat.ts"

function fresh(): DatabaseSync {
  return openMemoryDb(":memory:")
}

function refusal(db: DatabaseSync, input: UpsertFocusInput): FocusError {
  try {
    upsertFocusStrict(db, input)
  } catch (error) {
    assert.ok(error instanceof FocusError, `expected FocusError, got ${String(error)}`)
    return error
  }
  assert.fail(`expected a FocusError for ${JSON.stringify(input)}`)
}

function create(db: DatabaseSync, input: UpsertFocusInput): FocusItem {
  const item = upsertFocusStrict(db, input)
  return getFocus(db, item.id) as FocusItem
}

function item(state: FocusItem["state"], updatedAt: string): FocusItem {
  return { id: `foc-${state}`, text: state, state, updatedAt, evidence: [] }
}

test("the requirement matrix refuses every guarded state without its field", () => {
  const db = fresh()
  try {
    const open = refusal(db, { text: "无验收" })
    assert.equal(open.code, "missing-field")
    assert.match(open.message, /accept/)

    const accepting = create(db, { text: "有验收", accept: "测试全绿" })
    const doing = refusal(db, { id: accepting.id, state: "doing" })
    assert.equal(doing.code, "missing-field")
    assert.match(doing.message, /evidence/)

    const blocked = refusal(db, { id: accepting.id, state: "blocked" })
    assert.equal(blocked.code, "missing-field")
    assert.match(blocked.message, /why/)

    const reviewing = create(db, { text: "等评审", state: "review" })
    const done = refusal(db, { id: reviewing.id, state: "done" })
    assert.equal(done.code, "missing-field")
    assert.match(done.message, /evidence/)

    const dropped = refusal(db, { id: accepting.id, state: "dropped" })
    assert.equal(dropped.code, "missing-field")
    assert.match(dropped.message, /reason/)
  } finally {
    db.close()
  }
})

test("every one of the six states can be written", () => {
  const db = fresh()
  try {
    const open = create(db, { text: "开放项", accept: "跑通" })
    assert.equal(open.state, "open")
    assert.equal(open.accept, "跑通")

    const doing = create(db, { text: "进行项", state: "doing", evidence: ["npm test"] })
    assert.equal(doing.state, "doing")
    assert.deepEqual(doing.evidence, ["npm test"])

    const blocked = create(db, { text: "阻塞项", state: "blocked", why: "等上游" })
    assert.equal(blocked.state, "blocked")
    assert.equal(blocked.why, "等上游")

    const review = create(db, { text: "评审项", state: "review" })
    assert.equal(review.state, "review")

    const done = create(db, { text: "完成项", state: "done", evidence: ["tsc 0"] })
    assert.equal(done.state, "done")
    assert.deepEqual(done.evidence, ["tsc 0"])

    const dropped = create(db, { text: "放弃项", state: "dropped", reason: "方向变了" })
    assert.equal(dropped.state, "dropped")
    assert.equal(dropped.reason, "方向变了")

    assert.equal(openFocusCount(db), 4)
  } finally {
    db.close()
  }
})

test("illegal transitions are refused with the allowed moves in the message", () => {
  const db = fresh()
  try {
    const done = create(db, { text: "已完成", state: "done", evidence: ["green"] })
    const fromDone = refusal(db, { id: done.id, state: "doing", evidence: ["again"] })
    assert.equal(fromDone.code, "illegal-transition")
    assert.match(fromDone.message, /allowed:/)
    assert.match(fromDone.message, /from done to doing/)

    const dropped = create(db, { text: "已放弃", state: "dropped", reason: "算了" })
    const fromDropped = refusal(db, { id: dropped.id, state: "doing", evidence: ["again"] })
    assert.equal(fromDropped.code, "illegal-transition")
    assert.match(fromDropped.message, /allowed:/)

    const open = create(db, { text: "开放", accept: "够" })
    const fromOpen = refusal(db, { id: open.id, state: "review" })
    assert.equal(fromOpen.code, "illegal-transition")
    assert.match(fromOpen.message, /allowed:/)

    const review = create(db, { text: "评审中", state: "review" })
    const fromReview = refusal(db, { id: review.id, state: "blocked", why: "卡住" })
    assert.equal(fromReview.code, "illegal-transition")
    assert.match(fromReview.message, /allowed:/)
  } finally {
    db.close()
  }
})

test("legal transitions all go through", () => {
  const db = fresh()
  try {
    const first = create(db, { text: "主路径", accept: "收尾" })
    assert.equal(upsertFocusStrict(db, { id: first.id, state: "doing", evidence: ["tsc"] }).state, "doing")
    assert.equal(upsertFocusStrict(db, { id: first.id, state: "review" }).state, "review")
    assert.equal(upsertFocusStrict(db, { id: first.id, state: "done", evidence: ["green"] }).state, "done")

    const second = create(db, { text: "阻塞路径", accept: "收尾" })
    upsertFocusStrict(db, { id: second.id, state: "doing", evidence: ["tsc"] })
    assert.equal(upsertFocusStrict(db, { id: second.id, state: "blocked", why: "等上游" }).state, "blocked")
    assert.equal(upsertFocusStrict(db, { id: second.id, state: "doing" }).state, "doing")

    const third = create(db, { text: "回评审", state: "review" })
    assert.equal(upsertFocusStrict(db, { id: third.id, state: "open", accept: "再确认" }).state, "open")

    const fourth = create(db, { text: "已完成再开", state: "done", evidence: ["green"] })
    assert.equal(upsertFocusStrict(db, { id: fourth.id, state: "open", accept: "重开" }).state, "open")

    const fifth = create(db, { text: "已放弃再开", state: "dropped", reason: "算了" })
    assert.equal(upsertFocusStrict(db, { id: fifth.id, state: "open", accept: "重开" }).state, "open")
  } finally {
    db.close()
  }
})

test("fields already stored are backfilled instead of demanded again", () => {
  const db = fresh()
  try {
    const seeded = create(db, { text: "带回填", state: "doing", evidence: ["npm test"] })
    upsertFocusStrict(db, { id: seeded.id, state: "review" })
    const reopened = upsertFocusStrict(db, { id: seeded.id, state: "open", accept: "再看一次" })
    assert.equal(reopened.state, "open")
    assert.deepEqual(reopened.evidence, ["npm test"])

    const again = upsertFocusStrict(db, { id: seeded.id, state: "doing" })
    assert.equal(again.state, "doing")
    assert.deepEqual(again.evidence, ["npm test"])

    const renamed = upsertFocusStrict(db, { id: seeded.id, text: "改名也要过" })
    assert.equal(renamed.text, "改名也要过")
    assert.equal(renamed.state, "doing")
  } finally {
    db.close()
  }
})

test("the plain upsert stays unguarded for the dreamer", () => {
  const db = fresh()
  try {
    const bare = upsertFocus(db, { text: "没有验收" })
    assert.equal(bare.state, "open")
    assert.equal(bare.accept, undefined)
    assert.deepEqual(bare.evidence, [])

    const forced = upsertFocus(db, { text: "直接完成", state: "done" })
    assert.equal(forced.state, "done")
    assert.deepEqual(forced.evidence, [])
  } finally {
    db.close()
  }
})

test("staleness is computed from updatedAt and never persisted", () => {
  const now = new Date("2026-05-10T00:00:00.000Z")
  assert.equal(STALE_MS, 3 * 24 * 60 * 60 * 1000)
  assert.equal(isStale(item("open", "2026-05-08T00:00:00.000Z"), now), false)
  assert.equal(isStale(item("open", "2026-05-05T00:00:00.000Z"), now), true)
  assert.equal(isStale(item("doing", "2026-05-09T00:00:00.000Z"), now), false)
  assert.equal(isStale(item("doing", "2026-05-01T00:00:00.000Z"), now), true)
  assert.equal(isStale(item("blocked", "2026-05-01T00:00:00.000Z"), now), true)
  assert.equal(isStale(item("review", "2026-01-01T00:00:00.000Z"), now), false)
  assert.equal(isStale(item("done", "2026-01-01T00:00:00.000Z"), now), false)
  assert.equal(isStale(item("dropped", "2026-01-01T00:00:00.000Z"), now), false)
})

test("an old focus table gains the four columns without touching the rows", () => {
  const db = new DatabaseSync(":memory:")
  try {
    db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE dream_runs (id TEXT PRIMARY KEY, started_at TEXT, ended_at TEXT, from_seq INTEGER, to_seq INTEGER);
CREATE TABLE focus (id TEXT PRIMARY KEY, text TEXT, state TEXT, updated_at TEXT, source TEXT, seq INTEGER);
INSERT INTO focus(id, text, state, updated_at, source, seq) VALUES ('foc-old', '老焦点', 'doing', '2026-01-01T00:00:00.000Z', 'agent', 7);`)
    migrate(db)

    const columns = (db.prepare("PRAGMA table_info(focus)").all() as Array<Record<string, unknown>>).map((row) =>
      String(row.name ?? ""),
    )
    for (const column of ["evidence", "accept", "why", "reason"]) assert.ok(columns.includes(column), column)

    const row = db
      .prepare("SELECT id, text, state, evidence, accept, why, reason FROM focus WHERE id = 'foc-old'")
      .get() as Record<string, unknown>
    assert.equal(row.state, "doing")
    assert.equal(row.text, "老焦点")
    for (const column of ["evidence", "accept", "why", "reason"]) assert.equal(row[column], null, column)

    assert.equal(schemaVersion(db), SCHEMA_VERSION)

    const legacy = getFocus(db, "foc-old") as FocusItem
    assert.equal(legacy.state, "doing")
    assert.deepEqual(legacy.evidence, [])
  } finally {
    db.close()
  }
})

test("evidence parsing survives garbage, non-strings and duplicates", () => {
  const db = fresh()
  try {
    const insert = db.prepare("INSERT INTO focus(id, text, state, updated_at, evidence) VALUES (?, ?, 'doing', ?, ?)")
    insert.run("foc-null", "空", "2026-01-01T00:00:00.000Z", null)
    insert.run("foc-empty", "空串", "2026-01-01T00:00:00.000Z", "")
    insert.run("foc-bad", "坏 JSON", "2026-01-01T00:00:00.000Z", "[not json")
    insert.run("foc-object", "不是数组", "2026-01-01T00:00:00.000Z", '{"a":1}')
    insert.run("foc-mixed", "混合", "2026-01-01T00:00:00.000Z", '["x", 1, "x", " y ", null]')
    insert.run("foc-dupes", "重复", "2026-01-01T00:00:00.000Z", '["a","a","a"]')

    assert.deepEqual((getFocus(db, "foc-null") as FocusItem).evidence, [])
    assert.deepEqual((getFocus(db, "foc-empty") as FocusItem).evidence, [])
    assert.deepEqual((getFocus(db, "foc-bad") as FocusItem).evidence, [])
    assert.deepEqual((getFocus(db, "foc-object") as FocusItem).evidence, [])
    assert.deepEqual((getFocus(db, "foc-mixed") as FocusItem).evidence, ["x", "y"])
    assert.deepEqual((getFocus(db, "foc-dupes") as FocusItem).evidence, ["a"])
  } finally {
    db.close()
  }
})

function focusRowCount(db: DatabaseSync): number {
  const row = db.prepare("SELECT count(*) AS n FROM focus").get() as { n: number | bigint }
  return typeof row.n === "bigint" ? Number(row.n) : row.n
}

test("the same text in another shape reuses the row instead of adding one", () => {
  const db = fresh()
  try {
    const first = upsertFocus(db, { text: "Ship the Focus panel.", state: "doing", evidence: ["tsc"] })
    const second = upsertFocus(db, {
      text: "  ship   THE focus panel",
      state: "blocked",
      evidence: ["tsc", "npm test"],
      why: "等评审",
    })
    assert.equal(second.id, first.id)
    assert.equal(second.text, "ship   THE focus panel")
    assert.deepEqual(second.evidence, ["tsc", "npm test"])
    assert.equal(second.why, "等评审")

    const third = upsertFocus(db, { text: "ＳＨＩＰ　ＴＨＥ　ＦＯＣＵＳ　ＰＡＮＥＬ。", state: "open", accept: "面板可见" })
    assert.equal(third.id, first.id)
    assert.equal(third.state, "open")
    assert.equal(third.accept, "面板可见")
    assert.equal(third.why, "等评审")
    assert.deepEqual(third.evidence, ["tsc", "npm test"])
    assert.equal(focusRowCount(db), 1)
  } finally {
    db.close()
  }
})

test("a finished item is not reused when the same task is mentioned again", () => {
  const db = fresh()
  try {
    const done = upsertFocus(db, { text: "发布 0.1", state: "done", evidence: ["tag"] })
    const again = upsertFocus(db, { text: "发布 0.1", state: "open", accept: "上线" })
    assert.notEqual(again.id, done.id)
    assert.equal((getFocus(db, done.id) as FocusItem).state, "done")
    assert.equal(focusRowCount(db), 2)
  } finally {
    db.close()
  }
})

test("the prompt list leads with stale rows, oldest first, and never with finished ones", () => {
  const db = fresh()
  try {
    const now = new Date("2026-03-01T00:00:00.000Z")
    const insert = db.prepare(
      "INSERT INTO focus(id, text, state, updated_at, source) VALUES (?, ?, ?, ?, 'agent')",
    )
    insert.run("foc-finished", "已完成", "done", "2026-01-01T00:00:00.000Z")
    insert.run("foc-dropped", "已丢弃", "dropped", "2026-01-01T00:00:00.000Z")
    insert.run("foc-fresh-doing", "新 doing", "doing", "2026-02-28T00:00:00.000Z")
    insert.run("foc-fresh-open", "新 open", "open", "2026-02-27T00:00:00.000Z")
    insert.run("foc-stale-blocked", "陈旧 blocked", "blocked", "2026-02-20T00:00:00.000Z")
    insert.run("foc-stale-open-a", "陈旧 open a", "open", "2026-02-10T00:00:00.000Z")
    insert.run("foc-stale-open-b", "陈旧 open b", "open", "2026-02-15T00:00:00.000Z")

    const ids = listFocusForPrompt(db, { now }).map((item) => item.id)
    assert.deepEqual(ids, [
      "foc-stale-open-a",
      "foc-stale-open-b",
      "foc-stale-blocked",
      "foc-fresh-doing",
      "foc-fresh-open",
    ])
  } finally {
    db.close()
  }
})

test("the prompt list stops at twenty rows and keeps the oldest", () => {
  const db = fresh()
  try {
    for (let index = 0; index < 25; index += 1) {
      upsertFocus(db, {
        text: `任务 ${String(index).padStart(2, "0")}`,
        state: "doing",
        evidence: ["x"],
        now: new Date(Date.UTC(2026, 0, 1, 0, index)),
      })
    }
    const items = listFocusForPrompt(db)
    assert.equal(items.length, 20)
    assert.equal(items[0]?.text, "任务 00")
    assert.equal(items[19]?.text, "任务 19")
  } finally {
    db.close()
  }
})

test("formatFocusLine spells a row out for the prompt", () => {
  const now = new Date("2026-03-10T00:00:00.000Z")
  const plain: FocusItem = {
    id: "foc-abc",
    text: "写  README",
    state: "doing",
    updatedAt: "2026-03-07T00:00:00.000Z",
    evidence: ["a", "b"],
  }
  assert.equal(formatFocusLine(plain, now), "- [doing] foc-abc 写 README（3d, evidence: a, b）")

  const stale: FocusItem = {
    id: "foc-abc",
    text: "收尾",
    state: "open",
    updatedAt: "2026-03-05T00:00:00.000Z",
    evidence: [],
  }
  assert.equal(formatFocusLine(stale, now), "- [stale 5d] open foc-abc 收尾（5d, no evidence）")

  const clipped: FocusItem = {
    id: "foc-long",
    text: "长证据",
    state: "blocked",
    updatedAt: "2026-03-10T00:00:00.000Z",
    evidence: ["z".repeat(41)],
  }
  assert.equal(formatFocusLine(clipped, now), `- [blocked] foc-long 长证据（0d, evidence: ${"z".repeat(40)}…）`)
})

test("the heartbeat names every stale focus row and drops the section when nothing is stale", () => {
  const now = new Date("2026-03-10T00:00:00.000Z")
  const stale: FocusItem = {
    id: "foc-abc",
    text: "陈旧任务",
    state: "open",
    updatedAt: "2026-03-05T00:00:00.000Z",
    evidence: [],
  }
  const focus = ["- [open] foc-new 新任务（0d, no evidence）"]
  const quiet = heartbeatText({ idleMs: 90 * 60_000, openFocus: 1, focus, openProposals: [] })
  assert.equal(quiet.includes(STALE_FOCUS_INSTRUCTION), false, quiet)
  assert.equal(quiet.includes("stale"), false, quiet)

  const loud = heartbeatText({
    idleMs: 90 * 60_000,
    openFocus: 1,
    focus,
    staleFocus: [formatFocusLine(stale, now)],
    openProposals: [],
  })
  const lines = loud.split("\n")
  assert.ok(lines.includes(STALE_FOCUS_INSTRUCTION), loud)
  const at = lines.findIndex((line) => line.startsWith("- [stale 5d] open foc-abc"))
  assert.ok(at > 0, loud)
  assert.equal(lines[at], "- [stale 5d] open foc-abc 陈旧任务（5d, no evidence）")
  assert.equal(lines[at + 1], "  继续（说明下一步）/ 合并到哪一条 / dropped（必须给 reason）")
})
