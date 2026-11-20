import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { after, test } from "node:test"
import type { ToolContext } from "../../src/engine/durable.ts"
import { SCHEMA_VERSION, memoryDbPath, openMemoryDb } from "../../src/memory/db.ts"
import { createProposal, getProposal, updateProposal } from "../../src/memory/proposals.ts"
import type { ProposalTests } from "../../src/memory/proposals.ts"
import {
  APPLY_PROPOSAL_TOOL,
  createApplyProposalTool,
  parseNameStatus,
  protectedViolations,
  scriptsChanged,
} from "../../src/selfedit/apply.ts"
import { SelfEditGate } from "../../src/selfedit/gate.ts"
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

const BASE_PACKAGE = `${JSON.stringify({ name: "scratch", scripts: { test: "node --test" } }, null, 2)}\n`

async function makeRepo(): Promise<string> {
  const repo = await scratch("ctrl-apply-repo-")
  await mustGit(repo, ["init", "-q", "-b", "main"])
  await mustGit(repo, ["config", "user.email", "apply@example.com"])
  await mustGit(repo, ["config", "user.name", "apply"])
  await mustGit(repo, ["config", "commit.gpgsign", "false"])
  await mkdir(path.join(repo, "tests"), { recursive: true })
  await writeFile(path.join(repo, "README.md"), "# scratch\n", "utf8")
  await writeFile(path.join(repo, "package.json"), BASE_PACKAGE, "utf8")
  await writeFile(path.join(repo, "tests", "old.test.ts"), "export const old = 1\n", "utf8")
  await mustGit(repo, ["add", "-A"])
  await mustGit(repo, ["commit", "-q", "-m", "init"])
  return repo
}

async function makeDb(): Promise<DatabaseSync> {
  const home = await scratch("ctrl-apply-home-")
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

const NOW = new Date(2026, 10, 20, 17, 49, 30)

function makeGate(opts: { repo: string; db: DatabaseSync; restart?: () => void }): SelfEditGate {
  return new SelfEditGate({
    repoRoot: opts.repo,
    runner: { delegate: () => ({ ok: false, output: "no workers here" }) },
    db: opts.db,
    verifyCommands: ["true"],
    now: () => NOW,
    restart: opts.restart ?? (() => {}),
    warn: () => {},
  })
}

function toolContext(repo: string): ToolContext {
  return { cwd: repo, allowBash: false, timeoutMs: 5_000, maxOutputChars: 4_000 }
}

async function seedBranch(repo: string, branch: string, files: Record<string, string | null>): Promise<void> {
  await mustGit(repo, ["checkout", "-q", "-b", branch])
  for (const [name, body] of Object.entries(files)) {
    const target = path.join(repo, name)
    if (body === null) {
      await rm(target)
      continue
    }
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, body, "utf8")
  }
  await mustGit(repo, ["add", "-A"])
  await mustGit(repo, ["commit", "-q", "-m", `edit ${branch}`])
  await mustGit(repo, ["checkout", "-q", "main"])
}

function seedProposal(
  db: DatabaseSync,
  draft: { id: string; branch: string; tests?: ProposalTests; status?: "open" | "applied" | "discarded" },
): void {
  createProposal(db, {
    id: draft.id,
    branch: draft.branch,
    base: "main",
    task: `apply ${draft.id}`,
    status: draft.status ?? "open",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...(draft.tests !== undefined ? { tests: draft.tests } : {}),
  })
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

test("the guard reads a name-status listing and names every protected path", () => {
  const entries = parseNameStatus(
    [
      "M\tsrc/web/experience.ts",
      "A\tsrc/selfedit/apply.ts",
      "M\t.pi/settings.json",
      "D\ttests/unit/old.test.ts",
      "R100\ttests/unit/keep.test.ts\tsrc/keep.ts",
      "M\tpackage.json",
      "",
    ].join("\n"),
  )
  assert.deepEqual(entries[3], { status: "D", from: "tests/unit/old.test.ts", to: "tests/unit/old.test.ts" })
  assert.deepEqual(entries[4], { status: "R100", from: "tests/unit/keep.test.ts", to: "src/keep.ts" })
  assert.deepEqual(protectedViolations(entries), [
    "touches src/selfedit/** (src/selfedit/apply.ts)",
    "touches .pi/** (.pi/settings.json)",
    "deletes tests/unit/old.test.ts under tests/**",
    "moves tests/unit/keep.test.ts out of tests/**",
  ])
  assert.deepEqual(protectedViolations(parseNameStatus("M\tsrc/web/app.ts\nM\ttests/unit/new.test.ts\n")), [])
})

test("only the package.json scripts field counts as a protected change", () => {
  const base = JSON.stringify({ name: "x", scripts: { test: "node --test" }, devDependencies: { a: "1" } })
  assert.equal(scriptsChanged(base, JSON.stringify({ name: "x", scripts: { test: "node --test" }, devDependencies: { a: "2" } })), false)
  assert.equal(scriptsChanged(base, JSON.stringify({ name: "x", scripts: { test: "node --test --force" }, devDependencies: { a: "1" } })), true)
  assert.equal(scriptsChanged(base, JSON.stringify({ name: "x", scripts: {} })), true)
  assert.equal(scriptsChanged(base, "{ not json"), true)
  assert.equal(scriptsChanged(undefined, JSON.stringify({ name: "x" })), false)
  assert.equal(scriptsChanged(undefined, JSON.stringify({ name: "x", scripts: { test: "1" } })), true)
})

test("apply_proposal refuses closed, red and unverified proposals", async () => {
  const repo = await makeRepo()
  const db = await makeDb()
  const gate = makeGate({ repo, db })
  const tool = createApplyProposalTool({ gate })
  assert.equal(tool.name, APPLY_PROPOSAL_TOOL)
  assert.deepEqual(tool.parameters.required, ["id"])

  seedProposal(db, { id: "done", branch: "self/done", tests: GREEN, status: "applied" })
  seedProposal(db, { id: "gone", branch: "self/gone", tests: GREEN, status: "discarded" })
  seedProposal(db, { id: "red", branch: "self/red", tests: { ...GREEN, e2e: { ok: false, output: "boom" } } })
  seedProposal(db, { id: "bare", branch: "self/bare" })

  assert.deepEqual(await tool.execute({}, toolContext(repo)), {
    ok: false,
    output: "apply_proposal requires a non-empty proposal id",
  })
  assert.deepEqual(await tool.execute({ id: "nope" }, toolContext(repo)), { ok: false, output: "no such proposal: nope" })
  assert.deepEqual(await tool.execute({ id: "done" }, toolContext(repo)), { ok: false, output: "proposal done is applied" })
  assert.deepEqual(await tool.execute({ id: "gone" }, toolContext(repo)), {
    ok: false,
    output: "proposal gone is discarded",
  })
  assert.deepEqual(await tool.execute({ id: "red" }, toolContext(repo)), {
    ok: false,
    output: "proposal red failed e2e — it cannot be applied",
  })
  assert.deepEqual(await tool.execute({ id: "bare" }, toolContext(repo)), {
    ok: false,
    output: "proposal bare has no verification results — it cannot be applied",
  })
  assert.equal((await mustGit(repo, ["log", "--oneline", "main"])).trim().split("\n").length, 1)
})

test("apply_proposal refuses any diff that touches a protected path and merges nothing", async () => {
  const repo = await makeRepo()
  const db = await makeDb()
  const gate = makeGate({ repo, db })
  const tool = createApplyProposalTool({ gate })

  await seedBranch(repo, "self/selfedit", { "src/selfedit/apply.ts": "export const hijack = 1\n" })
  await seedBranch(repo, "self/pi", { ".pi/settings.json": "{}\n" })
  await seedBranch(repo, "self/scripts", {
    "package.json": `${JSON.stringify({ name: "scratch", scripts: { test: "node evil.mjs" } }, null, 2)}\n`,
  })
  await seedBranch(repo, "self/delete", { "tests/old.test.ts": null })
  await seedBranch(repo, "self/fine", { "src/web/extra.ts": "export const extra = 2\n" })
  for (const id of ["selfedit", "pi", "scripts", "delete", "fine"]) {
    seedProposal(db, { id, branch: `self/${id}`, tests: GREEN })
  }

  const hijack = await tool.execute({ id: "selfedit" }, toolContext(repo))
  assert.equal(hijack.ok, false)
  assert.equal(hijack.output, "proposal selfedit touches src/selfedit/** (src/selfedit/apply.ts) — refusing to merge")

  const pi = await tool.execute({ id: "pi" }, toolContext(repo))
  assert.equal(pi.output, "proposal pi touches .pi/** (.pi/settings.json) — refusing to merge")

  const scripts = await tool.execute({ id: "scripts" }, toolContext(repo))
  assert.equal(scripts.output, "proposal scripts changes the package.json scripts field — refusing to merge")

  const deleted = await tool.execute({ id: "delete" }, toolContext(repo))
  assert.equal(deleted.output, "proposal delete deletes tests/old.test.ts under tests/** — refusing to merge")

  assert.equal((await mustGit(repo, ["log", "--oneline", "main"])).trim().split("\n").length, 1)
  const tracked = await mustGit(repo, ["ls-tree", "-r", "--name-only", "main"])
  assert.equal(tracked.includes("src/selfedit/apply.ts"), false)
  assert.equal(tracked.includes(".pi/settings.json"), false)
  assert.match(await mustGit(repo, ["show", "main:package.json"]), /node --test/)
  assert.equal(tracked.includes("tests/old.test.ts"), true)

  const fine = await tool.execute({ id: "fine" }, toolContext(repo))
  assert.equal(fine.ok, true, fine.output)
  assert.equal((await readFile(path.join(repo, "src", "web", "extra.ts"), "utf8")).trim(), "export const extra = 2")
})

test("apply_proposal merges for real, writes appliedAt and mergedCommit and schedules a restart", async () => {
  const repo = await makeRepo()
  const db = await makeDb()
  const restarts: number[] = []
  const gate = makeGate({ repo, db, restart: () => restarts.push(Date.now()) })
  const tool = createApplyProposalTool({ gate })

  await seedBranch(repo, "self/20261120-174930", { "answer.txt": "42\n" })
  seedProposal(db, { id: "20261120-174930", branch: "self/20261120-174930", tests: GREEN })

  const reply = await tool.execute({ id: "20261120-174930" }, toolContext(repo))
  assert.deepEqual(reply, { ok: true, output: "applied 20261120-174930 — restarting" })
  assert.equal((await readFile(path.join(repo, "answer.txt"), "utf8")).trim(), "42")
  assert.equal((await mustGit(repo, ["log", "-1", "--pretty=%s"])).trim(), "self-edit: merge self/20261120-174930")
  assert.equal((await mustGit(repo, ["status", "--porcelain"])).trim(), "")

  const head = (await mustGit(repo, ["rev-parse", "HEAD"])).trim()
  const stored = getProposal(db, "20261120-174930")
  assert.ok(stored)
  assert.equal(stored.status, "applied")
  assert.equal(stored.mergedCommit, head)
  assert.equal(stored.appliedAt, NOW.toISOString())
  assert.equal(stored.endedAt, NOW.toISOString())

  const deadline = Date.now() + 3_000
  while (restarts.length === 0 && Date.now() < deadline) await sleep(20)
  assert.equal(restarts.length, 1, "the injected restart ran once")

  assert.deepEqual(await tool.execute({ id: "20261120-174930" }, toolContext(repo)), {
    ok: false,
    output: "proposal 20261120-174930 is applied",
  })
})

test("apply still refuses a dirty workspace after the protected paths pass", async () => {
  const repo = await makeRepo()
  const db = await makeDb()
  const gate = makeGate({ repo, db })
  const tool = createApplyProposalTool({ gate })

  await seedBranch(repo, "self/clean", { "note.txt": "hi\n" })
  seedProposal(db, { id: "clean", branch: "self/clean", tests: GREEN })
  await writeFile(path.join(repo, "scratch.txt"), "dirty\n", "utf8")

  assert.deepEqual(await tool.execute({ id: "clean" }, toolContext(repo)), {
    ok: false,
    output: "the workspace is not clean — commit or stash the changes before applying",
  })
  await rm(path.join(repo, "scratch.txt"))
  assert.equal((await tool.execute({ id: "clean" }, toolContext(repo))).ok, true)
})

test("an old proposals table gains applied_at and merged_commit on open", async () => {
  const home = await scratch("ctrl-apply-legacy-")
  const file = memoryDbPath(home)
  const legacy = new DatabaseSync(file)
  legacy.exec(
    "CREATE TABLE proposals (id TEXT PRIMARY KEY, branch TEXT NOT NULL, base TEXT NOT NULL, task TEXT NOT NULL, " +
      "summary TEXT, diffstat TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL, ended_at TEXT, tests TEXT, error TEXT)",
  )
  legacy
    .prepare("INSERT INTO proposals(id, branch, base, task, status, created_at) VALUES ('old', 'self/old', 'main', 'old', 'open', '2026-01-01T00:00:00.000Z')")
    .run()
  legacy.close()

  const db = openMemoryDb(file)
  dbs.push(db)
  assert.equal(SCHEMA_VERSION, 5)
  const columns = db.prepare("PRAGMA table_info(proposals)").all() as Array<Record<string, unknown>>
  const names = columns.map((row) => String(row.name ?? ""))
  assert.ok(names.includes("applied_at"))
  assert.ok(names.includes("merged_commit"))

  const updated = updateProposal(db, "old", {
    status: "applied",
    appliedAt: "2026-02-01T00:00:00.000Z",
    mergedCommit: "cafe1234",
  })
  assert.equal(updated?.appliedAt, "2026-02-01T00:00:00.000Z")
  assert.equal(updated?.mergedCommit, "cafe1234")
})
