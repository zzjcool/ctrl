import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, test } from "node:test"
import { DatabaseSync } from "node:sqlite"
import type { LlmClient, LlmCompleteRequest, LlmResponse } from "../../src/engine/durable.ts"
import { memoryDbPath, openMemoryDb, schemaVersion, SCHEMA_VERSION } from "../../src/memory/db.ts"
import { createAbortableLlm } from "../../src/server/turns.ts"
import {
  USAGE_DEFAULT_DAYS,
  USAGE_MAX_DAYS,
  clampUsageDays,
  createRecordingLlm,
  recordUsage,
  todayTokensByKind,
  usageSummary,
} from "../../src/memory/usage.ts"

const dirs: string[] = []
const dbs: DatabaseSync[] = []

after(async () => {
  for (const db of dbs) {
    try {
      db.close()
    } catch {

    }
  }
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})

async function makeDb(): Promise<DatabaseSync> {
  const home = await mkdtemp(path.join(tmpdir(), "ctrl-usage-"))
  dirs.push(home)
  const db = openMemoryDb(memoryDbPath(home))
  dbs.push(db)
  return db
}

interface UsageRow {
  id: string
  ts: string
  kind: string
  model: string | null
  prompt_tokens: number
  completion_tokens: number
  ms: number
  ok: number
}

interface UsageSeed {
  at: Date
  promptTokens?: number
  completionTokens?: number
  ms?: number
  kind?: string
}

let seeded = 0

function insert(db: DatabaseSync, seed: UsageSeed): void {
  seeded += 1
  db.prepare(
    "INSERT INTO usage(id, ts, kind, model, prompt_tokens, completion_tokens, ms, ok) VALUES (?, ?, ?, ?, ?, ?, ?, 1)",
  ).run(
    `seed-${seeded}`,
    seed.at.toISOString(),
    seed.kind ?? "turn",
    "test-model",
    seed.promptTokens ?? 0,
    seed.completionTokens ?? 0,
    seed.ms ?? 0,
  )
}

function stored(db: DatabaseSync): UsageRow[] {
  return db.prepare("SELECT * FROM usage ORDER BY ts ASC, id ASC").all() as unknown as UsageRow[]
}

function answer(usage: unknown, text = "done"): LlmResponse {
  return { text, toolCalls: [], usage, finishReason: "stop" } as unknown as LlmResponse
}

function fakeClient(reply: (req: LlmCompleteRequest) => Promise<LlmResponse>): LlmClient {
  return { model: "test-model", complete: reply }
}

test("an old memory database gains the usage table on open", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "ctrl-usage-legacy-"))
  dirs.push(home)
  const file = memoryDbPath(home)
  const legacy = new DatabaseSync(file)
  legacy.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)")
  legacy.prepare("INSERT INTO meta(key, value) VALUES ('schema_version', '3')").run()
  legacy.close()

  const db = openMemoryDb(file)
  dbs.push(db)
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'usage'").all()
  assert.equal(tables.length, 1)
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'usage_ts'").all()
  assert.equal(indexes.length, 1)
  assert.equal(schemaVersion(db), SCHEMA_VERSION)
  recordUsage(db, { kind: "turn", promptTokens: 3 })
  assert.equal(stored(db).length, 1)
})

test("the wrapper records a successful call and hands the response back untouched", async () => {
  const db = await makeDb()
  const response = answer({ promptTokens: 7, completionTokens: 3, totalTokens: 10 })
  const wrapped = createRecordingLlm(
    fakeClient(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      return response
    }),
    { db, kind: "turn" },
  )
  assert.equal(wrapped.model, "test-model")
  const seen: LlmCompleteRequest = { messages: [{ role: "user", content: "hi" }] }
  const out = await wrapped.complete(seen)
  assert.equal(out, response)

  const rows = stored(db)
  assert.equal(rows.length, 1)
  const row = rows[0] as UsageRow
  assert.equal(row.kind, "turn")
  assert.equal(row.model, "test-model")
  assert.equal(row.prompt_tokens, 7)
  assert.equal(row.completion_tokens, 3)
  assert.equal(row.ok, 1)
  assert.ok(row.ms >= 10, `expected a measured duration, got ${row.ms}`)
  assert.ok(Number.isFinite(Date.parse(row.ts)))
})

test("a response without a usage block still records a row with zero tokens", async () => {
  const db = await makeDb()
  const wrapped = createRecordingLlm(fakeClient(async () => ({ text: "ok" }) as unknown as LlmResponse), {
    db,
    kind: "dream",
  })
  const out = await wrapped.complete({ messages: [{ role: "user", content: "hi" }] })
  assert.equal(out.text, "ok")

  const row = stored(db)[0] as UsageRow
  assert.equal(row.kind, "dream")
  assert.equal(row.prompt_tokens, 0)
  assert.equal(row.completion_tokens, 0)
  assert.equal(row.ok, 1)
})

test("a call that throws records ok=0 and rethrows the very same error", async () => {
  const db = await makeDb()
  const boom = new Error("provider said no")
  const wrapped = createRecordingLlm(
    fakeClient(async () => {
      throw boom
    }),
    { db, kind: "dream" },
  )
  await assert.rejects(
    wrapped.complete({ messages: [{ role: "user", content: "hi" }] }),
    (error: unknown) => error === boom,
  )

  const rows = stored(db)
  assert.equal(rows.length, 1)
  const row = rows[0] as UsageRow
  assert.equal(row.ok, 0)
  assert.equal(row.kind, "dream")
  assert.equal(row.model, "test-model")
  assert.equal(row.prompt_tokens, 0)
  assert.equal(row.completion_tokens, 0)
})

test("recording around the abortable client keeps the abort signal intact", async () => {
  const db = await makeDb()
  const controller = new AbortController()
  const seen: LlmCompleteRequest[] = []
  const wrapped = createRecordingLlm(
    fakeClient(async (req) => {
      seen.push(req)
      return answer({ promptTokens: 2, completionTokens: 1 })
    }),
    { db, kind: "turn" },
  )
  const abortable = createAbortableLlm(wrapped, controller.signal)
  assert.equal(abortable.model, "test-model")
  await abortable.complete({ messages: [{ role: "user", content: "hi" }] })
  assert.equal(seen.length, 1)
  assert.equal(seen[0]?.signal, controller.signal)
  assert.equal(stored(db).length, 1)
})

test("a wrapper without a ledger still passes the call through", async () => {
  const wrapped = createRecordingLlm(fakeClient(async () => answer({ promptTokens: 1, completionTokens: 1 })), {
    db: undefined,
    kind: "turn",
  })
  const out = await wrapped.complete({ messages: [{ role: "user", content: "hi" }] })
  assert.equal(out.text, "done")
})

test("a write against a closed ledger is swallowed and only reaches stderr", () => {
  const db = openMemoryDb(":memory:")
  db.close()
  const captured: string[] = []
  const stream = process.stderr as unknown as { write: (chunk: string) => boolean }
  const original = stream.write
  stream.write = (chunk: string) => {
    captured.push(String(chunk))
    return true
  }
  try {
    assert.doesNotThrow(() => recordUsage(db, { kind: "turn", model: "m", promptTokens: 1, completionTokens: 2 }))
  } finally {
    stream.write = original
  }
  assert.match(captured.join(""), /usage record failed/)
})

test("a recorded call shows up in today's bucket and in the total", async () => {
  const db = await makeDb()
  recordUsage(db, { kind: "turn", model: "m", promptTokens: 5, completionTokens: 6, ms: 7, ok: true })
  recordUsage(db, { kind: "dream", promptTokens: 1, completionTokens: 2, ms: 3, ok: false })
  insert(db, { at: new Date(Date.now() - 3 * 86_400_000), promptTokens: 2, completionTokens: 2, ms: 5 })

  const rows = stored(db)
  assert.equal(rows.length, 3)
  assert.deepEqual(
    rows.map((row) => row.ok).sort(),
    [0, 1, 1],
  )

  const summary = usageSummary(db)
  assert.equal(summary.today.calls, 2)
  assert.equal(summary.today.promptTokens, 6)
  assert.equal(summary.today.completionTokens, 8)
  assert.equal(summary.today.ms, 10)
  assert.equal(summary.days.length, USAGE_DEFAULT_DAYS)
  assert.equal(summary.days.at(-1)?.calls, 2)
  assert.equal(summary.total.calls, 3)
  assert.equal(summary.total.promptTokens, 8)
  assert.equal(summary.total.completionTokens, 10)
  assert.equal(summary.total.ms, 15)
})

test("the summary buckets rows by local date over the requested window", async () => {
  const db = await makeDb()
  const now = new Date(2026, 0, 20, 12, 0, 0)
  insert(db, { at: new Date(2026, 0, 20, 9, 0, 0), promptTokens: 10, completionTokens: 5, ms: 40 })
  insert(db, { at: new Date(2026, 0, 20, 10, 0, 0), promptTokens: 1, completionTokens: 2, ms: 60 })
  insert(db, { at: new Date(2026, 0, 19, 23, 30, 0), promptTokens: 4, completionTokens: 6, ms: 100, kind: "dream" })
  insert(db, { at: new Date(2026, 0, 10, 8, 0, 0), promptTokens: 99, completionTokens: 99, ms: 999 })

  const summary = usageSummary(db, { days: 3, now })
  assert.deepEqual(
    summary.days.map((day) => day.date),
    ["2026-01-18", "2026-01-19", "2026-01-20"],
  )
  assert.deepEqual(
    summary.days.map((day) => day.calls),
    [0, 1, 2],
  )
  assert.deepEqual(summary.days.at(-1), { date: "2026-01-20", calls: 2, promptTokens: 11, completionTokens: 7 })
  assert.deepEqual(summary.today, { calls: 2, promptTokens: 11, completionTokens: 7, ms: 100 })
  assert.deepEqual(summary.total, { calls: 3, promptTokens: 15, completionTokens: 13, ms: 200 })

  const wide = usageSummary(db, { days: 30, now })
  assert.equal(wide.total.calls, 4)
  assert.equal(wide.days.find((day) => day.date === "2026-01-10")?.calls, 1)
})

test("days is clamped to one through ninety buckets", async () => {
  const db = await makeDb()
  const now = new Date(2026, 0, 20, 12, 0, 0)
  assert.equal(clampUsageDays(undefined), USAGE_DEFAULT_DAYS)
  assert.equal(clampUsageDays(0), 1)
  assert.equal(clampUsageDays(-5), 1)
  assert.equal(clampUsageDays(3.9), 3)
  assert.equal(clampUsageDays(500), USAGE_MAX_DAYS)
  assert.equal(clampUsageDays("7"), USAGE_DEFAULT_DAYS)

  assert.equal(usageSummary(db, { days: 0, now }).days.length, 1)
  assert.equal(usageSummary(db, { now }).days.length, USAGE_DEFAULT_DAYS)
  const capped = usageSummary(db, { days: 365, now })
  assert.equal(capped.days.length, USAGE_MAX_DAYS)
  assert.equal(capped.days.at(-1)?.date, "2026-01-20")
})

test("the heartbeat budget counts only what heartbeats spent, not the user's own turns", async () => {
  const db = openMemoryDb(":memory:")
  try {
    recordUsage(db, { kind: "turn", model: "m", promptTokens: 10_000, completionTokens: 1_000, ms: 5 })
    recordUsage(db, { kind: "wake", model: "m", promptTokens: 5_000, completionTokens: 500, ms: 5 })
    recordUsage(db, { kind: "heartbeat", model: "m", promptTokens: 2_000, completionTokens: 200, ms: 5 })
    assert.equal(todayTokensByKind(db, ["heartbeat"]), 2_200)
    assert.equal(todayTokensByKind(db, ["heartbeat", "wake"]), 7_700)
    assert.equal(todayTokensByKind(db, []), 0)
  } finally {
    db.close()
  }
})
