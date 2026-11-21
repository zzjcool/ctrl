import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { after, test } from "node:test"
import type { JobView } from "../../src/jobs/store.ts"
import {
  META_PENDING_WAKE,
  SCHEMA_VERSION,
  memoryDbPath,
  openMemoryDb,
  readMeta,
  schemaVersion,
  writeMeta,
} from "../../src/memory/db.ts"
import {
  NO_CHANGES_ERROR,
  VERIFICATION_FAILED_ERROR,
  createProposal,
  getProposal,
  getProposalByJob,
  listProposals,
  updateProposal,
} from "../../src/memory/proposals.ts"
import type { ProposalTests } from "../../src/memory/proposals.ts"
import { flushPendingWake } from "../../src/server/pending-wake.ts"
import { wakeTextFor } from "../../src/server/wake.ts"
import { GateError, SelfEditGate, type SelfEditRunner } from "../../src/selfedit/gate.ts"
import { git } from "../../src/selfedit/git.ts"

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

async function mustGit(repo: string, args: string[]): Promise<string> {
  const result = await git(repo, args)
  assert.equal(result.ok, true, `git ${args.join(" ")} failed: ${result.stderr}`)
  return result.stdout
}

async function makeRepo(): Promise<string> {
  const repo = await scratch("ctrl-lifecycle-repo-")
  await mustGit(repo, ["init", "-q", "-b", "main"])
  await mustGit(repo, ["config", "user.email", "lifecycle@example.com"])
  await mustGit(repo, ["config", "user.name", "lifecycle"])
  await mustGit(repo, ["config", "commit.gpgsign", "false"])
  await writeFile(path.join(repo, "README.md"), "# lifecycle\n", "utf8")
  await mustGit(repo, ["add", "-A"])
  await mustGit(repo, ["commit", "-q", "-m", "init"])
  return repo
}

async function makeDb(): Promise<DatabaseSync> {
  const home = await scratch("ctrl-lifecycle-home-")
  const db = openMemoryDb(memoryDbPath(home))
  dbs.push(db)
  return db
}

const GREEN: ProposalTests = {
  typecheck: { ok: true },
  unit: { ok: true },
  e2e: { ok: true },
  contract: { ok: true },
}

const RED: ProposalTests = {
  typecheck: { ok: true },
  unit: { ok: true },
  e2e: { ok: false, output: "boom" },
  contract: { ok: true },
}

const NOW = new Date(2026, 10, 21, 15, 58, 59)

function fakeRunner(): SelfEditRunner {
  let counter = 0
  return {
    delegate() {
      counter += 1
      return { ok: true, output: "started", id: `job-${counter}` }
    },
  }
}

function makeGate(opts: { repo: string; db: DatabaseSync; verifyCommands?: string[] }): SelfEditGate {
  return new SelfEditGate({
    repoRoot: opts.repo,
    runner: fakeRunner(),
    db: opts.db,
    verifyCommands: opts.verifyCommands ?? ["true"],
    now: () => NOW,
    restart: () => {},
    warn: () => {},
  })
}

function jobView(id: string): JobView {
  return {
    id,
    task: `task ${id}`,
    cwd: "/tmp",
    model: "fake-model",
    thinking: "max",
    startedAt: NOW.toISOString(),
    pid: 1,
    state: "exited",
    elapsedMs: 1_500,
    code: 0,
  }
}

test("a worker that changes nothing records a failed proposal instead of an open one", async () => {
  const repo = await makeRepo()
  const db = await makeDb()
  const gate = makeGate({ repo, db })

  const started = await gate.start("pretend to work")
  assert.equal(started.ok, true, started.output)
  const proposal = await gate.handleExit({ id: started.jobId ?? "", code: 0 })
  assert.ok(proposal)
  assert.equal(proposal.status, "failed")
  assert.equal(proposal.error, NO_CHANGES_ERROR)
  assert.equal(proposal.diffstat, undefined)
  assert.deepEqual(proposal.tests, { typecheck: { ok: true } })
  assert.equal(getProposal(db, proposal.id)?.status, "failed")
  assert.deepEqual(listProposals(db, { status: "open" }), [])

  await assert.rejects(
    () => gate.apply(proposal.id),
    (error: unknown) => {
      assert.ok(error instanceof GateError)
      assert.equal(error.status, 409)
      assert.match(error.message, /failed verification — it cannot be applied/)
      return true
    },
  )
})

test("a red proposal is failed at birth and apply refuses it with the verification message", async () => {
  const repo = await makeRepo()
  const db = await makeDb()
  const gate = makeGate({ repo, db, verifyCommands: ["false"] })

  const started = await gate.start("break the build")
  assert.equal(started.ok, true, started.output)
  await writeFile(path.join(repo, "broken.txt"), "oops\n", "utf8")
  const proposal = await gate.handleExit({ id: started.jobId ?? "", code: 0 })
  assert.ok(proposal)
  assert.equal(proposal.status, "failed")
  assert.equal(proposal.tests?.typecheck?.ok, false)
  assert.match(String(proposal.diffstat), /broken\.txt/)

  await assert.rejects(
    () => gate.apply(proposal.id),
    (error: unknown) => {
      assert.ok(error instanceof GateError)
      assert.equal(error.status, 409)
      assert.equal(error.message, `proposal ${proposal.id} failed verification — it cannot be applied`)
      return true
    },
  )
})

test("a green proposal stays open, keeps its job id and records the branch diffstat", async () => {
  const repo = await makeRepo()
  const db = await makeDb()
  const gate = makeGate({ repo, db })

  const started = await gate.start("add the answer file")
  await writeFile(path.join(repo, "answer.txt"), "42\n", "utf8")
  const proposal = await gate.handleExit({ id: started.jobId ?? "", code: 0 })
  assert.ok(proposal)
  assert.equal(proposal.status, "open")
  assert.equal(proposal.jobId, started.jobId)
  assert.match(String(proposal.diffstat), /answer\.txt/)
  assert.equal(getProposal(db, proposal.id)?.jobId, started.jobId)
  assert.equal(getProposalByJob(db, started.jobId ?? "")?.id, proposal.id)
})

test("apply writes the post-apply wake into meta so the restart picks it up", async () => {
  const repo = await makeRepo()
  const db = await makeDb()
  const gate = makeGate({ repo, db })

  const started = await gate.start("add the answer file")
  await writeFile(path.join(repo, "answer.txt"), "42\n", "utf8")
  const proposal = await gate.handleExit({ id: started.jobId ?? "", code: 0 })
  assert.ok(proposal)
  assert.equal(readMeta(db, META_PENDING_WAKE), undefined)

  const applied = await gate.apply(proposal.id)
  assert.equal(applied.status, "applied")
  assert.equal(
    readMeta(db, META_PENDING_WAKE),
    `[ctrl] you applied ${proposal.id}. Run the experience script and a live smoke, then report — if it regressed, fix or revert.`,
  )
})

test("the pending wake is injected once, cleared, and kept when the injection throws", async () => {
  const db = openMemoryDb(":memory:")
  dbs.push(db)
  const text = "[ctrl] you applied 20261121-155859. Run the experience script and a live smoke, then report — if it regressed, fix or revert."

  writeMeta(db, META_PENDING_WAKE, text)
  const injected: string[] = []
  const warnings: string[] = []
  const warn = (message: string) => {
    warnings.push(message)
  }
  assert.equal(flushPendingWake({ db: () => db, inject: (body) => injected.push(body), warn }), true)
  assert.deepEqual(injected, [text])
  assert.equal(readMeta(db, META_PENDING_WAKE), undefined)
  assert.deepEqual(warnings, [])
  assert.equal(flushPendingWake({ db: () => db, inject: (body) => injected.push(body), warn }), false)
  assert.deepEqual(injected, [text])

  writeMeta(db, META_PENDING_WAKE, text)
  assert.equal(
    flushPendingWake({
      db: () => db,
      inject: () => {
        throw new Error("turn refused")
      },
      warn,
    }),
    false,
  )
  assert.equal(readMeta(db, META_PENDING_WAKE), text, "a failed injection keeps the message for the next boot")
  assert.match(warnings.join("\n"), /turn refused/)

  assert.equal(flushPendingWake({ db: () => undefined, inject: (body) => injected.push(body), warn }), false)
})

test("the wake text names the job and splits green, red and empty proposals", async () => {
  const db = openMemoryDb(":memory:")
  dbs.push(db)
  const created = (id: string, status: "open" | "failed", tests: ProposalTests | undefined, error?: string) => {
    createProposal(db, {
      id,
      branch: `self/${id}`,
      base: "main",
      task: `task ${id}`,
      status,
      jobId: `job-${id}`,
      createdAt: NOW.toISOString(),
      ...(tests !== undefined ? { tests } : {}),
      ...(error !== undefined ? { error } : {}),
    })
  }
  created("green", "open", GREEN)
  created("red", "failed", RED)
  created("empty", "failed", GREEN, NO_CHANGES_ERROR)

  assert.equal(
    wakeTextFor(jobView("job-green"), getProposalByJob(db, "job-green")),
    "[ctrl] job-green finished → proposal green is green. Apply it now with apply_proposal, then verify.",
  )
  assert.equal(
    wakeTextFor(jobView("job-red"), getProposalByJob(db, "job-red")),
    "[ctrl] job-red finished → proposal red failed verification. Fix it (self_edit again) or discard it with a one-line reason — decide now.",
  )
  assert.equal(
    wakeTextFor(jobView("job-empty"), getProposalByJob(db, "job-empty")),
    "[ctrl] job-empty finished → proposal empty produced no changes; nothing to apply.",
  )
  assert.equal(
    wakeTextFor(jobView("job-unknown"), getProposalByJob(db, "job-unknown")),
    "[ctrl] worker job-unknown finished (exited, 1.5s) — report the result to the user.",
  )
})

test("a job id survives the round trip through the proposals table", async () => {
  const db = await makeDb()
  createProposal(db, {
    id: "with-job",
    branch: "self/with-job",
    base: "main",
    task: "find the job",
    jobId: "20261121T155859Z-abcdef",
    createdAt: NOW.toISOString(),
    tests: GREEN,
  })
  createProposal(db, {
    id: "without-job",
    branch: "self/without-job",
    base: "main",
    task: "no job",
    createdAt: NOW.toISOString(),
  })

  assert.equal(getProposal(db, "with-job")?.jobId, "20261121T155859Z-abcdef")
  assert.equal(getProposal(db, "without-job")?.jobId, undefined)
  assert.equal(getProposalByJob(db, "20261121T155859Z-abcdef")?.id, "with-job")
  assert.equal(getProposalByJob(db, ""), undefined)
  assert.equal(getProposalByJob(db, "never-seen"), undefined)
  assert.equal(updateProposal(db, "without-job", { jobId: "late-job" })?.jobId, "late-job")
  assert.equal(getProposalByJob(db, "late-job")?.id, "without-job")
})

test("a five-era proposals table is migrated to v6 with honest statuses", async () => {
  const home = await scratch("ctrl-lifecycle-legacy-")
  const file = memoryDbPath(home)
  const legacy = new DatabaseSync(file)
  legacy.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)")
  legacy.exec(
    "CREATE TABLE proposals (id TEXT PRIMARY KEY, branch TEXT NOT NULL, base TEXT NOT NULL, task TEXT NOT NULL, " +
      "summary TEXT, diffstat TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL, ended_at TEXT, tests TEXT, error TEXT, " +
      "applied_at TEXT, merged_commit TEXT)",
  )
  const insert = legacy.prepare(
    "INSERT INTO proposals(id, branch, base, task, status, created_at, tests, error) VALUES (?, ?, 'main', ?, ?, ?, ?, ?)",
  )
  insert.run("green", "self/green", "green", "open", "2026-01-01T00:00:00.000Z", JSON.stringify(GREEN), null)
  insert.run("red", "self/red", "red", "open", "2026-01-02T00:00:00.000Z", JSON.stringify(RED), null)
  insert.run("bare", "self/bare", "bare", "open", "2026-01-03T00:00:00.000Z", null, null)
  insert.run("kept", "self/kept", "kept", "open", "2026-01-04T00:00:00.000Z", JSON.stringify(GREEN), "already noted")
  insert.run("gone", "self/gone", "gone", "applied", "2026-01-05T00:00:00.000Z", JSON.stringify(RED), null)
  legacy.prepare("INSERT INTO meta(key, value) VALUES ('schema_version', '5')").run()
  legacy.close()

  const db = openMemoryDb(file)
  dbs.push(db)
  assert.equal(SCHEMA_VERSION, 6)
  assert.equal(schemaVersion(db), 6)

  const columns = (db.prepare("PRAGMA table_info(proposals)").all() as Array<Record<string, unknown>>).map((row) =>
    String(row.name ?? ""),
  )
  assert.ok(columns.includes("job_id"))

  assert.equal(getProposal(db, "green")?.status, "open")
  assert.equal(getProposal(db, "green")?.error, undefined)
  assert.equal(getProposal(db, "red")?.status, "failed")
  assert.equal(getProposal(db, "red")?.error, VERIFICATION_FAILED_ERROR)
  assert.equal(getProposal(db, "bare")?.status, "failed")
  assert.equal(getProposal(db, "bare")?.error, VERIFICATION_FAILED_ERROR)
  assert.equal(getProposal(db, "kept")?.status, "open")
  assert.equal(getProposal(db, "kept")?.error, "already noted")
  assert.equal(getProposal(db, "gone")?.status, "applied")

  db.close()
  dbs.splice(dbs.indexOf(db), 1)
  const reopened = openMemoryDb(file)
  dbs.push(reopened)
  assert.equal(getProposal(reopened, "green")?.status, "open")
  assert.equal(getProposal(reopened, "green")?.error, undefined)
  assert.equal(getProposal(reopened, "red")?.status, "failed")
  assert.equal(schemaVersion(reopened), 6)
})
