// An agent is a directory (CONTRACT §4, PLAN §3.1).
//
// These tests own the on-disk rules: the name charset, where a name may point,
// what a fresh directory contains, and what `rm` means. Nothing here opens a
// socket — the HTTP surface is tests/e2e/agent.test.ts.

import assert from "node:assert/strict"
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { mkdtemp } from "node:fs/promises"
import { after, test } from "node:test"
import {
  AGENT_FILENAME,
  AgentError,
  DEFAULT_AGENT,
  LOG_ID,
  agentHome,
  agentSummary,
  ensureAgent,
  isAgentName,
  listAgents,
  logPath,
  newAgent,
  readAgentMeta,
  removeAgent,
  resolveRoot,
  trashStamp,
} from "../../src/server/agents.ts"
import { agentSystemPrompt } from "../../src/server/routes.ts"

const roots: string[] = []

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "ctrl-agents-"))
  roots.push(root)
  return root
}

after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// names and paths
// ---------------------------------------------------------------------------

test("agent names are lowercase, start alphanumeric, and fit in 32 chars", () => {
  for (const name of ["a", "main", "builder", "b2", "a-b_c", "x".repeat(32), "0day"]) {
    assert.equal(isAgentName(name), true, name)
  }
  for (const name of ["", "A", "Main", "-lead", "_lead", "x".repeat(33), "a b", "a/b", "..", "a.b", "über"]) {
    assert.equal(isAgentName(name), false, JSON.stringify(name))
  }
  assert.equal(isAgentName(undefined), false)
  assert.equal(isAgentName(42), false)
})

test("a name may never escape <root>/agents", () => {
  assert.equal(agentHome("/r", "builder"), path.join("/r", "agents", "builder"))
  for (const bad of ["..", "../etc", "a/b", "A"]) {
    assert.throws(() => agentHome("/r", bad), (error: unknown) => error instanceof AgentError && error.kind === "invalid-name")
  }
})

test("root resolution is --root, then CTRL_ROOT, then ~/.ctrl", () => {
  assert.equal(resolveRoot("/tmp/one", {}), "/tmp/one")
  assert.equal(resolveRoot(undefined, { CTRL_ROOT: "/tmp/two" }), "/tmp/two")
  const fallback = resolveRoot(undefined, {})
  assert.match(fallback, /\.ctrl$/)
  // A blank flag is not an answer; the env still wins.
  assert.equal(resolveRoot("   ", { CTRL_ROOT: "/tmp/three" }), "/tmp/three")
})

// ---------------------------------------------------------------------------
// ensure: serve-time open-or-create
// ---------------------------------------------------------------------------

test("a missing agent directory is created with agent.json and one log", async () => {
  const root = await freshRoot()
  const ensured = ensureAgent({ root, name: "builder", cwd: "/work", model: "test/model" })

  assert.equal(ensured.created, true)
  assert.equal(ensured.home, path.join(root, "agents", "builder"))
  assert.equal(ensured.meta.name, "builder")
  assert.equal(ensured.meta.model, "test/model")

  const onDisk = JSON.parse(await readFile(path.join(ensured.home, AGENT_FILENAME), "utf8"))
  assert.equal(onDisk.name, "builder")
  assert.equal(onDisk.model, "test/model")
  assert.equal(typeof onDisk.createdAt, "string")

  // The log id is "main" and it starts with exactly one event.
  assert.equal(LOG_ID, "main")
  assert.equal(path.basename(logPath(ensured.home)), "events.jsonl")
  assert.match(logPath(ensured.home), /sessions\/main\/events\.jsonl$/)
  const events = ensured.session.events()
  assert.equal(events.length, 1)
  assert.equal(events[0]?.type, "session_created")
  if (events[0]?.type === "session_created") {
    assert.equal(events[0].data.cwd, "/work")
    assert.equal(events[0].data.model, "test/model")
  }
  // Memory lives inside the agent, so a new name starts blank (CONTRACT §4).
  assert.equal(ensured.session.eventsFile, logPath(ensured.home))
})

test("serving an existing agent opens its log instead of creating a new one", async () => {
  const root = await freshRoot()
  const first = ensureAgent({ root, name: "builder", cwd: "/work", model: "model/one" })
  first.session.appendUserMessage("hello")
  const createdAt = first.meta.createdAt

  const second = ensureAgent({ root, name: "builder", cwd: "/elsewhere", model: "model/two" })
  assert.equal(second.created, false)
  assert.equal(second.meta.createdAt, createdAt, "agent.json is not rewritten")
  assert.equal(second.meta.model, "model/one")
  assert.equal(second.session.events().length, 2, "the log is the same log")
  // The model recorded at creation wins over the flag (PLAN §5).
  assert.equal(second.session.meta().model, "model/one")
})

test("a directory whose log went missing is healed, not fatal", async () => {
  const root = await freshRoot()
  const ensured = ensureAgent({ root, name: "builder", cwd: "/work", model: "model/one" })
  await rm(logPath(ensured.home))

  const healed = ensureAgent({ root, name: "builder", cwd: "/work", model: "model/two" })
  assert.equal(healed.session.events().length, 1)
  assert.equal(healed.meta.model, "model/one", "agent.json survives the loss")
  // The healed log records agent.json's model, since that is the agent's.
  assert.equal(healed.session.meta().model, "model/one")
})

test("agent new refuses to touch an existing name", async () => {
  const root = await freshRoot()
  newAgent({ root, name: "builder", cwd: "/work", model: "model/one" })
  assert.throws(
    () => newAgent({ root, name: "builder", cwd: "/work", model: "model/two" }),
    (error: unknown) => error instanceof AgentError && error.kind === "exists",
  )
  assert.throws(
    () => newAgent({ root, name: "BadName", cwd: "/work", model: "m" }),
    (error: unknown) => error instanceof AgentError && error.kind === "invalid-name",
  )
})

test("a malformed agent.json is ignored instead of thrown", async () => {
  const root = await freshRoot()
  const ensured = ensureAgent({ root, name: "builder", cwd: "/work", model: "m" })
  for (const body of ["{", "", "[]", "null", '{"name":42}']) {
    await writeFile(path.join(ensured.home, AGENT_FILENAME), body)
    assert.equal(readAgentMeta(ensured.home), undefined, `body: ${body}`)
  }
})

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

test("list is creation-ordered, counts events, and ignores stray directories", async () => {
  const root = await freshRoot()
  const older = newAgent({ root, name: "builder", cwd: "/work", model: "m", now: new Date("2026-01-01T00:00:00Z") })
  older.session.appendUserMessage("first")
  const newer = newAgent({ root, name: "auditor", cwd: "/work", model: "m", now: new Date("2026-02-02T00:00:00Z") })
  assert.equal(newer.session.events().length, 1)

  // Things that are not agents must not appear in the list.
  await writeFile(path.join(root, "agents", "notes.txt"), "x")
  await mkdir(path.join(root, "agents", "NotValid"), { recursive: true })

  const agents = listAgents(root)
  assert.deepEqual(agents.map((agent) => agent.name), ["builder", "auditor"])
  assert.equal(agents[0]?.events, 2)
  assert.equal(agents[1]?.events, 1)
  assert.equal(agents[0]?.createdAt, "2026-01-01T00:00:00.000Z")
  assert.equal(agents[0]?.lastActivity, older.session.events().at(-1)?.ts)

  assert.deepEqual(listAgents(path.join(root, "nope")), [], "a root with no agents is empty, not an error")
  assert.equal(agentSummary(root, "ghost"), undefined)
  assert.equal(agentSummary(root, "NotValid"), undefined)
})

test("a fresh name starts blank: no memory, no log", async () => {
  const root = await freshRoot()
  const first = newAgent({ root, name: "builder", cwd: "/w", model: "m" })
  first.session.appendUserMessage("remember nothing")
  removeAgent({ root, name: "builder" })

  const again = newAgent({ root, name: "builder", cwd: "/w", model: "m" })
  assert.equal(again.session.events().length, 1)
  assert.equal(agentSummary(root, "builder")?.events, 1)
  await assert.rejects(stat(path.join(again.home, "memory", "index.jsonl")), "a blank agent has no memory log")
})

// ---------------------------------------------------------------------------
// rm: archive by default, purge on request
// ---------------------------------------------------------------------------

test("rm archives the directory under trash/<name>-<stamp>/", async () => {
  const root = await freshRoot()
  const created = newAgent({ root, name: "builder", cwd: "/w", model: "m" })
  const removed = removeAgent({ root, name: "builder", now: new Date("2026-10-16T19:36:12Z") })

  assert.equal(removed.purged, false)
  assert.equal(trashStamp(new Date("2026-10-16T19:36:12Z")).length, 14)
  assert.equal(removed.to, path.join(root, "trash", `builder-${trashStamp(new Date("2026-10-16T19:36:12Z"))}`))
  await assert.rejects(stat(created.home), "the agent directory is gone from agents/")
  // Archived means archived: the log travelled with the directory.
  const archived = JSON.parse(await readFile(path.join(removed.to ?? "", AGENT_FILENAME), "utf8"))
  assert.equal(archived.name, "builder")
  assert.equal((await readdir(removed.to ?? "")).includes("sessions"), true)
})

test("two archives in the same second get a suffix instead of clobbering", async () => {
  const root = await freshRoot()
  const now = new Date("2026-10-16T19:36:12Z")
  newAgent({ root, name: "builder", cwd: "/w", model: "m", now })
  const first = removeAgent({ root, name: "builder", now })
  newAgent({ root, name: "builder", cwd: "/w", model: "m", now })
  const second = removeAgent({ root, name: "builder", now })

  assert.notEqual(first.to, second.to)
  assert.equal(second.to, `${first.to}-2`)
  assert.equal((await readdir(path.join(root, "trash"))).length, 2)
})

test("rm --purge deletes for real", async () => {
  const root = await freshRoot()
  const created = newAgent({ root, name: "builder", cwd: "/w", model: "m" })
  const removed = removeAgent({ root, name: "builder", purge: true })
  assert.equal(removed.purged, true)
  assert.equal(removed.to, undefined)
  await assert.rejects(stat(created.home))
  await assert.rejects(stat(path.join(root, "trash")), "nothing was archived")
})

test("rm of a missing agent is a not-found, not a crash", async () => {
  const root = await freshRoot()
  assert.throws(
    () => removeAgent({ root, name: "ghost" }),
    (error: unknown) => error instanceof AgentError && error.kind === "not-found",
  )
  assert.throws(
    () => removeAgent({ root, name: "Bad Name" }),
    (error: unknown) => error instanceof AgentError && error.kind === "invalid-name",
  )
  assert.equal(DEFAULT_AGENT, "main")
})

// ---------------------------------------------------------------------------
// what the model is told (CONTRACT §6)
// ---------------------------------------------------------------------------

test("the system prompt names the agent and says it has no hands", () => {
  const prompt = agentSystemPrompt({ name: "builder", cwd: "/srv/proj" })
  assert.equal(
    prompt,
    "You are builder, a persistent agent with long-term memory. " +
      "You do not edit files or run commands yourself: delegate work to a pi worker with the delegate tool, " +
      "then report what it did. The log is your memory; there is no conversation. " +
      // MEMORY.md §5: the window is not the memory, so the prompt names the one
      // tool that reaches past it.
      "You can search your entire history with search_context(query) — use it when the user refers to something not in the recent context. " +
      "Your workspace is /srv/proj.",
  )
  assert.notEqual(
    prompt,
    agentSystemPrompt({ name: "builder", cwd: "/tmp" }),
    "the workspace is woven in per call, never cached",
  )
})
