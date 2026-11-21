import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, test } from "node:test"
import { createSession, type Session } from "../../src/engine/durable.ts"
import { openMemoryDb } from "../../src/memory/db.ts"
import { recordCompactionSummary, windowInfo, windowStart } from "../../src/memory/window.ts"

const dirs: string[] = []

after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})

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
})

test("a compaction record names the window the model no longer sees", async () => {
  const session = await newSession()
  for (let index = 0; index < 4; index += 1) turn(session, 100, `p${index}`)
  const events = session.events()
  assert.equal(windowStart(events), 0)

  const firstKeptSeq = 5
  session.appendCompaction({ summary: "the old half", firstKeptSeq })
  assert.equal(windowStart(session.events()), firstKeptSeq)
  assert.ok(windowInfo(session.events()).chars < windowInfo(events).chars + 100)
})

test("the summaries row is the dream's input, and a missing database is not an error", async () => {
  recordCompactionSummary(undefined, { summary: "no db", firstKeptSeq: 3, fromSeq: 0, toSeq: 2 })

  const db = openMemoryDb(":memory:")
  try {
    recordCompactionSummary(db, {
      summary: "the plan so far",
      firstKeptSeq: 7,
      fromSeq: 0,
      toSeq: 6,
      at: new Date("2026-11-20T07:52:00.000Z"),
    })
    const rows = db.prepare("SELECT * FROM summaries ORDER BY from_seq").all() as Array<Record<string, unknown>>
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.level, "window")
    assert.equal(rows[0]?.from_seq, 0)
    assert.equal(rows[0]?.to_seq, 6)
    assert.equal(rows[0]?.text, "the plan so far")
    assert.equal(rows[0]?.created_at, "2026-11-20T07:52:00.000Z")
  } finally {
    db.close()
  }
})
