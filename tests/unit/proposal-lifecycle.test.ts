import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
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
  reasonFor,
  updateProposal,
} from "../../src/memory/proposals.ts"
import type { ProposalReason, ProposalTests } from "../../src/memory/proposals.ts"
import { listPendingEdits } from "../../src/memory/pending-edits.ts"
import { flushPendingWake } from "../../src/server/pending-wake.ts"
import { wakeTextFor } from "../../src/server/wake.ts"
import { GateError, SelfEditGate, type SelfEditRunner } from "../../src/selfedit/gate.ts"
import { git, gitBranch } from "../../src/selfedit/git.ts"

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

test("a suite that fails once and passes on the retry is green", async () => {
  const repo = await makeRepo()
  const db = await makeDb()
  const side = await scratch("ctrl-lifecycle-retry-")
  const marker = path.join(side, "marker")
  const log = path.join(side, "log")
  const flaky = `echo run >> ${log}; if [ -f ${marker} ]; then true; else touch ${marker}; false; fi`
  const gate = makeGate({ repo, db, verifyCommands: ["true", flaky] })

  const started = await gate.start("flaky suite")
  assert.equal(started.ok, true, started.output)
  await writeFile(path.join(repo, "flaky.txt"), "one\n", "utf8")
  const proposal = await gate.handleExit({ id: started.jobId ?? "", code: 0 })
  assert.ok(proposal)
  assert.equal(proposal.status, "open")
  assert.equal(proposal.tests?.unit?.ok, true, "the retry turns the suite green")
  assert.equal((await readFile(log, "utf8")).trim().split("\n").length, 2, "the failing suite ran exactly twice")
})

test("a green suite runs once and a deterministic typecheck never retries", async () => {
  const repo = await makeRepo()
  const db = await makeDb()
  const side = await scratch("ctrl-lifecycle-single-")
  const log = path.join(side, "log")
  const gate = makeGate({ repo, db, verifyCommands: [`echo run >> ${log}; true`, "true"] })

  const started = await gate.start("single run")
  assert.equal(started.ok, true, started.output)
  await writeFile(path.join(repo, "quick.txt"), "one\n", "utf8")
  await gate.handleExit({ id: started.jobId ?? "", code: 0 })
  assert.equal((await readFile(log, "utf8")).trim().split("\n").length, 1)
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

test("the wake text names the job and branches on the reason code", async () => {
  const db = openMemoryDb(":memory:")
  dbs.push(db)
  const created = (
    id: string,
    status: "open" | "failed",
    tests: ProposalTests | undefined,
    reason: ProposalReason | undefined,
  ) => {
    createProposal(db, {
      id,
      branch: `self/${id}`,
      base: "main",
      task: `task ${id}`,
      status,
      jobId: `job-${id}`,
      createdAt: NOW.toISOString(),
      ...(tests !== undefined ? { tests } : {}),
      ...(reason !== undefined ? { reason } : {}),
    })
  }
  created("green", "open", GREEN, "green")
  created("red", "failed", RED, "verification_failed")
  created("empty", "failed", GREEN, "no_changes")
  created("slow", "failed", RED, "timeout")
  created("broken", "failed", RED, "worker_failed")
  created("old", "failed", RED, undefined)

  assert.equal(
    wakeTextFor(jobView("job-green"), getProposalByJob(db, "job-green")),
    "[ctrl] job-green finished → proposal green 全绿——直接 apply_proposal 合入，合完再跑一遍验证。",
  )
  assert.equal(
    wakeTextFor(jobView("job-red"), getProposalByJob(db, "job-red")),
    "[ctrl] job-red finished → proposal red 验证没过，不会自动合；让它改到全绿，或写一句理由 discard。",
  )
  assert.equal(
    wakeTextFor(jobView("job-empty"), getProposalByJob(db, "job-empty")),
    "[ctrl] job-empty finished → proposal empty worker 没改出任何东西，没什么可合的；要改就重新 self_edit。",
  )
  assert.equal(
    wakeTextFor(jobView("job-slow"), getProposalByJob(db, "job-slow")),
    "[ctrl] job-slow finished → proposal slow 跑太久被停掉了，结果不完整，不会自动合；拆小一点重新 self_edit，或写一句理由 discard。",
  )
  assert.equal(
    wakeTextFor(jobView("job-broken"), getProposalByJob(db, "job-broken")),
    "[ctrl] job-broken finished → proposal broken worker 自己失败了，结果不可信，不会自动合；查一下再 self_edit，或写一句理由 discard。",
  )
  assert.equal(
    wakeTextFor(jobView("job-old"), getProposalByJob(db, "job-old")),
    "[ctrl] job-old finished → proposal old 没有记录失败原因（老提案），不确定能不能合；看一眼 diff 和测试再决定 apply 还是 discard。",
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

test("reasonFor names the one reason that explains a proposal", () => {
  assert.equal(reasonFor({ green: true, changed: true, failure: "ok" }), "green")
  assert.equal(reasonFor({ green: false, changed: true, failure: "ok" }), "verification_failed")
  assert.equal(reasonFor({ green: true, changed: false, failure: "ok" }), "no_changes")
  assert.equal(reasonFor({ green: true, changed: true, failure: "timeout" }), "timeout")
  assert.equal(reasonFor({ green: true, changed: true, failure: "worker_failed" }), "worker_failed")
})

test("reasonFor ranks timeout, then worker_failed, then no_changes, then verification_failed, then green", () => {
  const cases: Array<[{ green: boolean; changed: boolean; failure: "ok" | "timeout" | "worker_failed" }, ProposalReason]> = [
    [{ green: true, changed: true, failure: "timeout" }, "timeout"],
    [{ green: true, changed: false, failure: "timeout" }, "timeout"],
    [{ green: false, changed: true, failure: "timeout" }, "timeout"],
    [{ green: false, changed: false, failure: "timeout" }, "timeout"],
    [{ green: true, changed: true, failure: "worker_failed" }, "worker_failed"],
    [{ green: true, changed: false, failure: "worker_failed" }, "worker_failed"],
    [{ green: false, changed: true, failure: "worker_failed" }, "worker_failed"],
    [{ green: false, changed: false, failure: "worker_failed" }, "worker_failed"],
    [{ green: true, changed: false, failure: "ok" }, "no_changes"],
    [{ green: false, changed: false, failure: "ok" }, "no_changes"],
    [{ green: false, changed: true, failure: "ok" }, "verification_failed"],
    [{ green: true, changed: true, failure: "ok" }, "green"],
  ]
  for (const [input, expected] of cases) {
    assert.equal(reasonFor(input), expected, JSON.stringify(input))
  }
})

test("the gate labels a green, an empty, a red and a crashed job with distinct reasons", async () => {
  const greenRepo = await makeRepo()
  const greenDb = await makeDb()
  const greenGate = makeGate({ repo: greenRepo, db: greenDb })
  const greenStart = await greenGate.start("add the answer file")
  assert.equal(greenStart.ok, true, greenStart.output)
  assert.equal(listPendingEdits(greenDb).length, 1, "start claims the job on disk")
  await writeFile(path.join(greenRepo, "answer.txt"), "42\n", "utf8")
  const green = await greenGate.handleExit({ id: greenStart.jobId ?? "", code: 0 })
  assert.equal(green?.status, "open")
  assert.equal(green?.reason, "green")
  assert.deepEqual(listPendingEdits(greenDb), [], "the claim is released once the proposal lands")

  const emptyRepo = await makeRepo()
  const emptyGate = makeGate({ repo: emptyRepo, db: await makeDb() })
  const emptyStart = await emptyGate.start("pretend to work")
  const empty = await emptyGate.handleExit({ id: emptyStart.jobId ?? "", code: 0 })
  assert.equal(empty?.status, "failed")
  assert.equal(empty?.reason, "no_changes")
  assert.equal(empty?.error, NO_CHANGES_ERROR)

  const redRepo = await makeRepo()
  const redGate = makeGate({ repo: redRepo, db: await makeDb(), verifyCommands: ["false"] })
  const redStart = await redGate.start("break the build")
  await writeFile(path.join(redRepo, "broken.txt"), "oops\n", "utf8")
  const red = await redGate.handleExit({ id: redStart.jobId ?? "", code: 0 })
  assert.equal(red?.status, "failed")
  assert.equal(red?.reason, "verification_failed")

  const crashRepo = await makeRepo()
  const crashGate = makeGate({ repo: crashRepo, db: await makeDb() })
  const crashStart = await crashGate.start("die on me")
  await writeFile(path.join(crashRepo, "answer.txt"), "42\n", "utf8")
  const crashed = await crashGate.handleExit({ id: crashStart.jobId ?? "", code: 1 })
  assert.equal(crashed?.status, "failed")
  assert.equal(crashed?.reason, "worker_failed")
  assert.match(String(crashed?.error), /exited with code 1/)
})

const STOPPED_JOB_ID = "20261122T012128Z-sto001"

function stoppingRunner(id: string): SelfEditRunner {
  return {
    delegate() {
      return { ok: true, output: "started", id }
    },
  }
}

async function jobLogHome(jobId: string, log: string): Promise<string> {
  const home = await scratch("ctrl-lifecycle-jobs-")
  await mkdir(path.join(home, "jobs", jobId), { recursive: true })
  await writeFile(path.join(home, "jobs", jobId, "out.log"), log, "utf8")
  return home
}

async function stoppedGate(log: string): Promise<{ gate: SelfEditGate; repo: string; jobId: string }> {
  const repo = await makeRepo()
  const db = await makeDb()
  const home = await jobLogHome(STOPPED_JOB_ID, log)
  const gate = new SelfEditGate({
    repoRoot: repo,
    runner: stoppingRunner(STOPPED_JOB_ID),
    db,
    agentHome: home,
    verifyCommands: ["true"],
    now: () => NOW,
    restart: () => {},
    warn: () => {},
  })
  return { gate, repo, jobId: STOPPED_JOB_ID }
}

test("a job stopped by the timeout sweep records timeout", async () => {
  const { gate, repo, jobId } = await stoppedGate("working\nctrl: job exceeded 30m — stopped\n")
  assert.equal((await gate.start("run forever")).ok, true)
  await writeFile(path.join(repo, "answer.txt"), "42\n", "utf8")
  const proposal = await gate.handleExit({ id: jobId, code: null, signal: "SIGTERM" })
  assert.equal(proposal?.status, "failed")
  assert.equal(proposal?.reason, "timeout")
  assert.match(String(proposal?.error), /signal SIGTERM/)
})

test("a job stopped by the stall sweep records timeout", async () => {
  const { gate, repo, jobId } = await stoppedGate("working\nctrl: no output for 8m — stopped\n")
  assert.equal((await gate.start("stall")).ok, true)
  await writeFile(path.join(repo, "answer.txt"), "42\n", "utf8")
  const proposal = await gate.handleExit({ id: jobId, code: null, signal: "SIGKILL" })
  assert.equal(proposal?.reason, "timeout")
})

test("a signal without a ctrl stop note is the worker failing, not a timeout", async () => {
  const { gate, repo, jobId } = await stoppedGate("working\nctrl: something else happened\n")
  assert.equal((await gate.start("get killed elsewhere")).ok, true)
  await writeFile(path.join(repo, "answer.txt"), "42\n", "utf8")
  const proposal = await gate.handleExit({ id: jobId, code: null, signal: "SIGTERM" })
  assert.equal(proposal?.status, "failed")
  assert.equal(proposal?.reason, "worker_failed")
})

test("a job that outlives a ctrl restart still lands its proposal", async () => {
  const repo = await makeRepo()
  const home = await scratch("ctrl-lifecycle-restart-")
  const file = memoryDbPath(home)
  const first = openMemoryDb(file)
  dbs.push(first)
  const before = makeGate({ repo, db: first })
  const started = await before.start("add the answer file")
  assert.equal(started.ok, true, started.output)
  const claimed = listPendingEdits(first)
  assert.equal(claimed.length, 1)
  assert.equal(claimed[0]?.jobId, started.jobId)
  assert.equal(claimed[0]?.branch, started.branch)

  await writeFile(path.join(repo, "answer.txt"), "42\n", "utf8")
  dbs.splice(dbs.indexOf(first), 1)
  first.close()

  const second = openMemoryDb(file)
  dbs.push(second)
  const after = makeGate({ repo, db: second })
  assert.equal(after.busy, false, "a restart does not adopt the old job in memory")
  const proposal = await after.handleExit({ id: started.jobId ?? "", code: 0 })
  assert.ok(proposal, "the recovered job still produces its proposal")
  assert.equal(proposal.id, claimed[0]?.proposalId)
  assert.equal(proposal.status, "open")
  assert.equal(proposal.reason, "green")
  assert.equal(proposal.jobId, started.jobId)
  assert.deepEqual(listPendingEdits(second), [])
  assert.equal(getProposalByJob(second, started.jobId ?? "")?.id, proposal.id)
})

test("an exit for a job that was never claimed changes nothing", async () => {
  const repo = await makeRepo()
  const db = await makeDb()
  const gate = makeGate({ repo, db })
  assert.equal(await gate.handleExit({ id: "20261122T012128Z-nope01", code: 0 }), undefined)
  assert.deepEqual(listProposals(db), [])
  assert.equal(await gitBranch(repo), "main")
})
