import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { after, test } from "node:test"
import type { ToolContext } from "../../src/engine/durable.ts"
import { SCHEMA_VERSION, memoryDbPath, openMemoryDb, schemaVersion } from "../../src/memory/db.ts"
import { createProposal, listProposals } from "../../src/memory/proposals.ts"
import { SelfEditGate, GateError, selfEditBranchName, type SelfEditRunner } from "../../src/selfedit/gate.ts"
import {
  git,
  gitBranch,
  gitBranchExists,
  gitStatusPorcelain,
} from "../../src/selfedit/git.ts"
import { createSelfEditTool } from "../../src/selfedit/tool.ts"

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
  const repo = await scratch("ctrl-self-repo-")
  await mustGit(repo, ["init", "-q", "-b", "main"])
  await mustGit(repo, ["config", "user.email", "self-edit@example.com"])
  await mustGit(repo, ["config", "user.name", "self edit"])
  await mustGit(repo, ["config", "commit.gpgsign", "false"])
  await writeFile(path.join(repo, "README.md"), "# temp\n", "utf8")
  await mustGit(repo, ["add", "-A"])
  await mustGit(repo, ["commit", "-q", "-m", "init"])
  return repo
}

async function makeDb(): Promise<DatabaseSync> {
  const home = await scratch("ctrl-self-home-")
  const db = openMemoryDb(memoryDbPath(home))
  dbs.push(db)
  return db
}

interface FakeRunner extends SelfEditRunner {
  calls: Array<{ task: string; cwd?: string }>
}

function fakeRunner(opts: { ok?: boolean; id?: string } = {}): FakeRunner {
  const calls: Array<{ task: string; cwd?: string }> = []
  let counter = 0
  return {
    calls,
    delegate(input) {
      calls.push(input)
      const ok = opts.ok ?? true
      const id = opts.id ?? `20261120T174930Z-job${String(counter += 1).padStart(3, "0")}`
      return { ok, output: ok ? `started job ${id}` : "worker refused", id }
    },
  }
}

const NOW = new Date(2026, 10, 20, 17, 49, 30)

function makeGate(opts: {
  repo: string
  db?: DatabaseSync
  runner?: SelfEditRunner
  verifyCommands?: string[]
  agentHome?: string
}): SelfEditGate {
  return new SelfEditGate({
    repoRoot: opts.repo,
    runner: opts.runner ?? fakeRunner(),
    ...(opts.db !== undefined ? { db: opts.db } : {}),
    ...(opts.agentHome !== undefined ? { agentHome: opts.agentHome } : {}),
    verifyCommands: opts.verifyCommands ?? ["true"],
    now: () => NOW,
    restart: () => {},
    warn: () => {},
  })
}

function toolContext(repo: string): ToolContext {
  return { cwd: repo, allowBash: false, timeoutMs: 5_000, maxOutputChars: 4_000 }
}

test("self_edit refuses a dirty workspace and creates no branch", async () => {
  const repo = await makeRepo()
  const gate = makeGate({ repo, db: await makeDb() })
  await writeFile(path.join(repo, "README.md"), "# temp\nlocal edit\n", "utf8")

  const started = await gate.start("touch something")
  assert.equal(started.ok, false)
  assert.match(started.output, /not clean/)
  assert.equal(await gitBranchExists(repo, "self/20261120-174930"), false)
  assert.equal(await gitBranch(repo), "main")
})

test("self_edit refuses a self branch and a second job while one runs", async () => {
  const repo = await makeRepo()
  const gate = makeGate({ repo, db: await makeDb() })
  await mustGit(repo, ["checkout", "-q", "-b", "self/other"])

  const onBranch = await gate.start("change it")
  assert.equal(onBranch.ok, false)
  assert.match(onBranch.output, /already on self\/other/)

  await mustGit(repo, ["checkout", "-q", "main"])
  const first = await gate.start("change it")
  assert.equal(first.ok, true, first.output)

  const second = await gate.start("change it again")
  assert.equal(second.ok, false)
  assert.match(second.output, /still running/)
  assert.equal(await gitBranch(repo), "self/20261120-174930")
})

test("self_edit names the branch self/<YYYYMMDD-HHMMSS> and hands the fixed constraints to the worker", async () => {
  const repo = await makeRepo()
  const runner = fakeRunner()
  const gate = makeGate({ repo, db: await makeDb(), runner })

  assert.equal(selfEditBranchName(NOW), "self/20261120-174930")

  const started = await gate.start("add the answer file")
  assert.equal(started.ok, true, started.output)
  assert.equal(started.branch, "self/20261120-174930")
  assert.equal(
    started.output,
    `started self-edit job ${started.jobId} on branch self/20261120-174930 — the proposal appears when it exits`,
  )
  assert.equal(await gitBranch(repo), "self/20261120-174930")

  const call = runner.calls[0]
  assert.ok(call)
  assert.equal(call.cwd, repo)
  assert.match(call.task, /add the answer file/)
  assert.match(call.task, new RegExp(`你在 ${repo} 的 self/20261120-174930 分支上工作`))
  assert.match(call.task, /只改源码和测试/)
  assert.match(call.task, /不要动 \.git/)
  assert.match(call.task, /不要改 package\.json 的 scripts/)
  assert.match(call.task, /不要碰仓库外的文件/)
  assert.match(call.task, /改了测试必须在 commit message 里说明理由/)
})

test("a red verification run still records the proposal with the failing output", async () => {
  const repo = await makeRepo()
  const db = await makeDb()
  const gate = makeGate({ repo, db, verifyCommands: ["false"] })

  const started = await gate.start("break the build")
  assert.equal(started.ok, true, started.output)
  await writeFile(path.join(repo, "broken.txt"), "oops\n", "utf8")

  const proposal = await gate.handleExit({ id: started.jobId ?? "", code: 0 })
  assert.ok(proposal)
  assert.equal(proposal.status, "open")
  assert.equal(proposal.branch, "self/20261120-174930")
  assert.equal(proposal.base, "main")
  assert.equal(proposal.tests?.typecheck?.ok, false)
  assert.match(String(proposal.tests?.typecheck?.output), /exit 1/)
  assert.equal(await gitBranch(repo), "main")
  assert.equal((await gitStatusPorcelain(repo)).stdout.trim(), "")
  assert.equal(await gitBranchExists(repo, "self/20261120-174930"), true)
  assert.match((await mustGit(repo, ["log", "-1", "--pretty=%s", "self/20261120-174930"])).trim(), /\(tests red\)$/)

  await assert.rejects(
    () => gate.apply(proposal.id),
    (error: unknown) => {
      assert.ok(error instanceof GateError)
      assert.equal(error.status, 409)
      assert.match(error.message, /typecheck/)
      return true
    },
  )
})

test("a green verification run records the proposal, the diffstat and the commit", async () => {
  const repo = await makeRepo()
  const db = await makeDb()
  const gate = makeGate({ repo, db })

  const task = "add the answer file 012345678901234567890123456789012345678901234567890123456789"
  const started = await gate.start(task)
  assert.equal(started.ok, true, started.output)
  await writeFile(path.join(repo, "answer.txt"), "42\n", "utf8")

  const proposal = await gate.handleExit({ id: started.jobId ?? "", code: 0 })
  assert.ok(proposal)
  assert.deepEqual(proposal.tests, { typecheck: { ok: true } })
  assert.equal(proposal.status, "open")
  assert.equal(proposal.task, task)
  assert.match(String(proposal.diffstat), /answer\.txt/)
  assert.match(String(proposal.diffstat), /1 file changed/)
  assert.equal(await gitBranch(repo), "main")
  assert.equal((await gitStatusPorcelain(repo)).stdout.trim(), "")
  assert.equal(
    (await mustGit(repo, ["log", "-1", "--pretty=%s", proposal.branch])).trim(),
    `self-edit: ${task.slice(0, 60)}`,
  )
  assert.match(await mustGit(repo, ["show", `${proposal.branch}:answer.txt`]), /42/)

  const stored = listProposals(db)
  assert.deepEqual(stored.map((item) => item.id), [proposal.id])
})

test("apply merges the branch into main once and refuses the second attempt", async () => {
  const repo = await makeRepo()
  const db = await makeDb()
  const gate = makeGate({ repo, db })

  const started = await gate.start("add the answer file")
  await writeFile(path.join(repo, "answer.txt"), "42\n", "utf8")
  const proposal = await gate.handleExit({ id: started.jobId ?? "", code: 0 })
  assert.ok(proposal)

  const applied = await gate.apply(proposal.id)
  assert.equal(applied.status, "applied")
  assert.equal(typeof applied.endedAt, "string")
  assert.equal((await readFile(path.join(repo, "answer.txt"), "utf8")).trim(), "42")
  assert.match(await mustGit(repo, ["log", "-1", "--pretty=%s"]), /^self-edit: merge self\/20261120-174930/)

  await assert.rejects(
    () => gate.apply(proposal.id),
    (error: unknown) => {
      assert.ok(error instanceof GateError)
      assert.equal(error.status, 409)
      assert.match(error.message, /applied/)
      return true
    },
  )
})

test("apply refuses a dirty workspace and an unknown id", async () => {
  const repo = await makeRepo()
  const db = await makeDb()
  const gate = makeGate({ repo, db })

  const started = await gate.start("add the answer file")
  await writeFile(path.join(repo, "answer.txt"), "42\n", "utf8")
  const proposal = await gate.handleExit({ id: started.jobId ?? "", code: 0 })
  assert.ok(proposal)

  await writeFile(path.join(repo, "scratch.txt"), "dirty\n", "utf8")
  await assert.rejects(
    () => gate.apply(proposal.id),
    (error: unknown) => {
      assert.ok(error instanceof GateError)
      assert.equal(error.status, 409)
      assert.match(error.message, /not clean/)
      return true
    },
  )

  await rm(path.join(repo, "scratch.txt"))
  await assert.rejects(
    () => gate.apply("nope"),
    (error: unknown) => {
      assert.ok(error instanceof GateError)
      assert.equal(error.status, 404)
      return true
    },
  )

  const applied = await gate.apply(proposal.id)
  assert.equal(applied.status, "applied")
})

test("discard deletes the branch and marks the proposal discarded", async () => {
  const repo = await makeRepo()
  const db = await makeDb()
  const gate = makeGate({ repo, db })

  const started = await gate.start("add the answer file")
  await writeFile(path.join(repo, "answer.txt"), "42\n", "utf8")
  const proposal = await gate.handleExit({ id: started.jobId ?? "", code: 0 })
  assert.ok(proposal)
  assert.equal(await gitBranchExists(repo, proposal.branch), true)

  const discarded = await gate.discard(proposal.id)
  assert.equal(discarded.status, "discarded")
  assert.equal(typeof discarded.endedAt, "string")
  assert.equal(await gitBranchExists(repo, proposal.branch), false)
  assert.equal(await gitBranch(repo), "main")

  await assert.rejects(
    () => gate.discard("nope"),
    (error: unknown) => {
      assert.ok(error instanceof GateError)
      assert.equal(error.status, 404)
      return true
    },
  )
})

test("detail returns the branch diff capped at 200000 characters", async () => {
  const repo = await makeRepo()
  const db = await makeDb()
  const gate = makeGate({ repo, db })

  const started = await gate.start("add the answer file")
  await writeFile(path.join(repo, "answer.txt"), "42\n", "utf8")
  const proposal = await gate.handleExit({ id: started.jobId ?? "", code: 0 })
  assert.ok(proposal)

  const detail = await gate.detail(proposal.id)
  assert.equal(detail.proposal.id, proposal.id)
  assert.match(detail.diff, /\+42/)
  assert.ok(detail.diff.length <= 200_000)
})

test("the self_edit tool starts a job and reports the branch", async () => {
  const repo = await makeRepo()
  const gate = makeGate({ repo, db: await makeDb() })
  const [tool] = createSelfEditTool({ gate })
  assert.ok(tool)
  assert.equal(tool.name, "self_edit")

  const refused = await tool.execute({}, toolContext(repo))
  assert.equal(refused.ok, false)
  assert.match(refused.output, /non-empty task/)

  const started = await tool.execute({ task: "add the answer file" }, toolContext(repo))
  assert.equal(started.ok, true, started.output)
  assert.match(started.output, /^started self-edit job .+ on branch self\/20261120-174930 — the proposal appears when it exits$/)
})

test("an old memory database gains the proposals table on open", async () => {
  const home = await scratch("ctrl-self-legacy-")
  const file = memoryDbPath(home)
  const legacy = new DatabaseSync(file)
  legacy.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)")
  legacy.prepare("INSERT INTO meta(key, value) VALUES ('schema_version', '1')").run()
  legacy.close()

  const db = openMemoryDb(file)
  dbs.push(db)
  assert.equal(SCHEMA_VERSION, 3)
  assert.equal(schemaVersion(db), SCHEMA_VERSION)
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'proposals'").get() as
    | { name?: unknown }
    | undefined
  assert.equal(row?.name, "proposals")
  createProposal(db, { id: "legacy", branch: "self/legacy", base: "main", task: "old" })
  assert.equal(listProposals(db).length, 1)
})

test("proposals are listed newest first and capped at twenty", async () => {
  const db = await makeDb()
  for (let index = 0; index < 25; index += 1) {
    createProposal(db, {
      id: `p-${String(index).padStart(2, "0")}`,
      branch: `self/p-${String(index).padStart(2, "0")}`,
      base: "main",
      task: `task ${index}`,
      createdAt: new Date(2026, 0, 1, 0, 0, index).toISOString(),
    })
  }
  const listed = listProposals(db)
  assert.equal(listed.length, 20)
  assert.equal(listed[0]?.id, "p-24")
  assert.equal(listed.at(-1)?.id, "p-05")
})

test("a verification command that times out is recorded as a failure", async () => {
  const repo = await makeRepo()
  const db = await makeDb()
  const gate = new SelfEditGate({
    repoRoot: repo,
    runner: fakeRunner(),
    db,
    verifyCommands: ["sleep 5"],
    verifyTimeoutMs: 200,
    now: () => NOW,
    restart: () => {},
    warn: () => {},
  })

  const started = await gate.start("slow down")
  assert.equal(started.ok, true, started.output)
  const proposal = await gate.handleExit({ id: started.jobId ?? "", code: 0 })
  assert.ok(proposal)
  assert.equal(proposal.tests?.typecheck?.ok, false)
  assert.match(String(proposal.tests?.typecheck?.output), /timed out/)
})
