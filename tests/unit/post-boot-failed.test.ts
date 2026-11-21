import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { DatabaseSync } from "node:sqlite"
import { after, test } from "node:test"
import { memoryDbPath, openMemoryDb } from "../../src/memory/db.ts"
import { createProposal, getProposal, updateProposal } from "../../src/memory/proposals.ts"
import type { ProposalTests } from "../../src/memory/proposals.ts"
import {
  POST_BOOT_MARKER,
  consumePostBootFailure,
  parsePostBootMarker,
} from "../../src/selfedit/post-boot-failed.ts"
import type { PostBootFailure } from "../../src/selfedit/post-boot-failed.ts"

const SHA = "af44a938e7c3b6588687051f985d49852d550a65"

const OTHER_SHA = "0f1e2d3c4b5a69788796a5b4c3d2e1f001122334"

const NOW = "2026-11-21T15:58:59.000Z"

const GREEN: ProposalTests = {
  typecheck: { ok: true },
  unit: { ok: true },
  e2e: { ok: true },
  contract: { ok: true },
}

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

interface Rig {
  home: string
  db: DatabaseSync
  warns: string[]
}

async function rig(prefix = "ctrl-post-boot-"): Promise<Rig> {
  const home = await scratch(prefix)
  const db = openMemoryDb(memoryDbPath(home))
  dbs.push(db)
  return { home, db, warns: [] }
}

function consume(target: Rig, root?: string): PostBootFailure[] {
  return consumePostBootFailure({
    db: target.db,
    agentHome: target.home,
    ...(root !== undefined ? { root } : {}),
    warn: (message) => target.warns.push(message),
  })
}

async function writeMarker(home: string, text: string): Promise<string> {
  const file = path.join(home, POST_BOOT_MARKER)
  await writeFile(file, text, "utf8")
  return file
}

function appliedProposal(db: DatabaseSync, id = "20261121-155859", sha = SHA): string {
  createProposal(db, {
    id,
    branch: `self/${id}`,
    base: "main",
    task: "add the answer file",
    status: "applied",
    tests: GREEN,
    createdAt: NOW,
  })
  updateProposal(db, id, { status: "applied", mergedCommit: sha, appliedAt: NOW })
  return id
}

test("a missing marker does nothing and says nothing", async () => {
  const target = await rig()
  assert.deepEqual(consume(target), [])
  assert.deepEqual(target.warns, [])
})

test("a marker that names an applied proposal fails it and deletes the marker", async () => {
  const target = await rig()
  const id = appliedProposal(target.db)
  const file = await writeMarker(target.home, `${SHA} quickcheck: verify-boot FAIL at step 3 (memories.lesson)\n`)

  const consumed = consume(target)

  assert.equal(consumed.length, 1)
  assert.equal(consumed[0]?.proposalId, id)
  assert.equal(consumed[0]?.sha, SHA)
  assert.equal(consumed[0]?.reason, "post_boot_failed")
  assert.equal(consumed[0]?.note, "quickcheck: verify-boot FAIL at step 3 (memories.lesson)")
  const proposal = getProposal(target.db, id)
  assert.equal(proposal?.status, "failed")
  assert.equal(proposal?.reason, "post_boot_failed")
  assert.match(proposal?.error ?? "", /quickcheck: verify-boot FAIL at step 3 \(memories\.lesson\)/)
  assert.equal(existsSync(file), false)
})

test("a marker with no matching applied proposal keeps the proposal and still deletes the marker", async () => {
  const target = await rig()
  const id = appliedProposal(target.db)
  const file = await writeMarker(target.home, `${OTHER_SHA} quickcheck: verify-boot FAIL at step 2\n`)

  assert.equal(consume(target).length, 1)

  assert.equal(existsSync(file), false)
  assert.equal(target.warns.length, 1)
  assert.match(target.warns[0] ?? "", /no applied proposal has that merged commit/)
  const proposal = getProposal(target.db, id)
  assert.equal(proposal?.status, "applied")
  assert.equal(proposal?.reason, undefined)
})

test("a marker without a 40-hex commit is dropped with a warning", async () => {
  const target = await rig()
  const id = appliedProposal(target.db)
  const file = await writeMarker(target.home, "everything is on fire\n")

  assert.deepEqual(consume(target), [])

  assert.equal(existsSync(file), false)
  assert.equal(target.warns.length, 1)
  assert.match(target.warns[0] ?? "", /no 40-hex commit/)
  assert.equal(getProposal(target.db, id)?.status, "applied")
})

test("consuming the same marker twice leaves no second effect", async () => {
  const target = await rig()
  const id = appliedProposal(target.db)
  await writeMarker(target.home, `${SHA} quickcheck: verify-boot FAIL at step 3\n`)

  assert.equal(consume(target).length, 1)
  const warns = target.warns.length
  assert.deepEqual(consume(target), [])

  assert.equal(target.warns.length, warns)
  const proposal = getProposal(target.db, id)
  assert.equal(proposal?.status, "failed")
  assert.equal(proposal?.reason, "post_boot_failed")
})

test("an experience_failed marker marks the proposal with that reason", async () => {
  const target = await rig()
  const id = appliedProposal(target.db)
  const file = await writeMarker(target.home, `experience_failed ${SHA} experience: composer overlaps the timeline at 390px\n`)

  const consumed = consume(target)

  assert.equal(consumed[0]?.reason, "experience_failed")
  const proposal = getProposal(target.db, id)
  assert.equal(proposal?.status, "failed")
  assert.equal(proposal?.reason, "experience_failed")
  assert.match(proposal?.error ?? "", /composer overlaps the timeline at 390px/)
  assert.equal(existsSync(file), false)
})

test("a proposal that is not applied keeps its own state even when the commit matches", async () => {
  const target = await rig()
  createProposal(target.db, {
    id: "20261121-160000",
    branch: "self/20261121-160000",
    base: "main",
    task: "add the answer file",
    status: "failed",
    tests: GREEN,
    createdAt: NOW,
    reason: "worker_failed",
  })
  updateProposal(target.db, "20261121-160000", { mergedCommit: SHA })
  const file = await writeMarker(target.home, `${SHA} quickcheck: verify-boot FAIL at step 3\n`)

  const consumed = consume(target)
  assert.equal(consumed.length, 1)
  assert.equal(consumed[0]?.proposalId, undefined)

  assert.equal(existsSync(file), false)
  assert.match(target.warns[0] ?? "", /no applied proposal has that merged commit/)
  const proposal = getProposal(target.db, "20261121-160000")
  assert.equal(proposal?.status, "failed")
  assert.equal(proposal?.reason, "worker_failed")
})

test("the marker is also read from the ctrl root when the agent home has none", async () => {
  const root = await scratch("ctrl-post-boot-root-")
  const home = path.join(root, "agents", "main")
  const db = openMemoryDb(path.join(home, "memory.db"))
  dbs.push(db)
  const id = appliedProposal(db)
  const file = await writeMarker(root, `${SHA} quickcheck: verify-boot FAIL at step 1\n`)
  const warns: string[] = []

  const consumed = consumePostBootFailure({ db, agentHome: home, root, warn: (message) => warns.push(message) })

  assert.equal(consumed[0]?.proposalId, id)
  assert.equal(getProposal(db, id)?.reason, "post_boot_failed")
  assert.equal(existsSync(file), false)
})

test("the markers parser takes a bare sha and an optional reason prefix", () => {
  assert.deepEqual(parsePostBootMarker(`${SHA} quickcheck: verify-boot FAIL at step 3`), {
    sha: SHA,
    reason: "post_boot_failed",
    note: "quickcheck: verify-boot FAIL at step 3",
  })
  assert.deepEqual(parsePostBootMarker(`experience_failed ${SHA.toUpperCase()} experience: composer overlaps`), {
    sha: SHA,
    reason: "experience_failed",
    note: "experience: composer overlaps",
  })
  assert.deepEqual(parsePostBootMarker(`  ${SHA}  \n`), { sha: SHA, reason: "post_boot_failed", note: "" })
  assert.deepEqual(parsePostBootMarker(`post_boot_failed ${SHA} quickcheck\n`), {
    sha: SHA,
    reason: "post_boot_failed",
    note: "quickcheck",
  })
  for (const bad of [
    "",
    "   ",
    "af44a93 quickcheck",
    "experience_failed",
    "experience_failed not-a-sha",
    "zz44a938e7c3b6588687051f985d49852d550a65 quickcheck",
    "af44a938e7c3b6588687051f985d49852d550a6 quickcheck",
  ]) {
    assert.equal(parsePostBootMarker(bad), undefined, `expected no marker for ${JSON.stringify(bad)}`)
  }
})
