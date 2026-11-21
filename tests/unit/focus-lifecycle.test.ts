import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import { test } from "node:test"
import { SCHEMA_VERSION, migrate, openMemoryDb, schemaVersion } from "../../src/memory/db.ts"
import {
  FocusError,
  STALE_MS,
  getFocus,
  isStale,
  openFocusCount,
  upsertFocus,
  upsertFocusStrict,
  type FocusItem,
  type UpsertFocusInput,
} from "../../src/memory/focus.ts"

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
