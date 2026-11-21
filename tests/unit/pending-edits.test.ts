import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { after, test } from "node:test"
import { memoryDbPath, openMemoryDb } from "../../src/memory/db.ts"
import {
  claimPendingEdit,
  getPendingEdit,
  listPendingEdits,
  releasePendingEdit,
} from "../../src/memory/pending-edits.ts"
import type { PendingEditRow } from "../../src/memory/pending-edits.ts"

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

async function scratch(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function open(file: string): DatabaseSync {
  const db = openMemoryDb(file)
  dbs.push(db)
  return db
}

function forget(db: DatabaseSync): void {
  db.close()
  const index = dbs.indexOf(db)
  if (index >= 0) dbs.splice(index, 1)
}

function row(patch: Partial<PendingEditRow> = {}): PendingEditRow {
  return {
    proposalId: "20261122-012128",
    jobId: "20261122T012128Z-abc123",
    branch: "self/20261122-012128",
    base: "main",
    task: "add the answer file",
    createdAt: "2026-11-22T01:21:28.000Z",
    ...patch,
  }
}

test("claim, read and release a pending self-edit", () => {
  const db = open(":memory:")
  const claimed = row()
  claimPendingEdit(db, claimed)

  assert.deepEqual(getPendingEdit(db, claimed.jobId), claimed)
  assert.deepEqual(listPendingEdits(db), [claimed])

  releasePendingEdit(db, claimed.jobId)
  assert.equal(getPendingEdit(db, claimed.jobId), undefined)
  assert.deepEqual(listPendingEdits(db), [])
})

test("claiming the same job twice replaces its row instead of adding one", () => {
  const db = open(":memory:")
  const first = row()
  claimPendingEdit(db, first)
  claimPendingEdit(db, first)
  assert.equal(listPendingEdits(db).length, 1)
  assert.deepEqual(getPendingEdit(db, first.jobId), first)

  const second = row({ proposalId: "20261122-013000", branch: "self/20261122-013000", task: "another task" })
  claimPendingEdit(db, second)
  assert.equal(listPendingEdits(db).length, 1)
  assert.deepEqual(getPendingEdit(db, first.jobId), second)
})

test("release clears a row that is still claimed and tolerates an unknown id", () => {
  const db = open(":memory:")
  claimPendingEdit(db, row())
  claimPendingEdit(db, row({ jobId: "20261122T013000Z-def456", proposalId: "20261122-013000" }))
  assert.equal(listPendingEdits(db).length, 2)

  releasePendingEdit(db, "20261122T012128Z-abc123")
  assert.deepEqual(
    listPendingEdits(db).map((entry) => entry.jobId),
    ["20261122T013000Z-def456"],
  )
  releasePendingEdit(db, "never-seen")
  releasePendingEdit(db, "  ")
  assert.equal(listPendingEdits(db).length, 1)
  assert.equal(getPendingEdit(db, ""), undefined)
})

test("a claimed job survives closing and reopening the database file", async () => {
  const home = await scratch("ctrl-pending-home-")
  const file = memoryDbPath(home)
  const first = open(file)
  const claimed = row({ jobId: "20261122T012128Z-abc123" })
  claimPendingEdit(first, claimed)
  assert.deepEqual(listPendingEdits(first), [claimed])

  forget(first)

  const reopened = open(file)
  assert.deepEqual(getPendingEdit(reopened, claimed.jobId), claimed)
  assert.deepEqual(listPendingEdits(reopened), [claimed])

  releasePendingEdit(reopened, claimed.jobId)
  assert.equal(getPendingEdit(reopened, claimed.jobId), undefined)

  forget(reopened)
  const third = open(file)
  assert.deepEqual(listPendingEdits(third), [])
})
