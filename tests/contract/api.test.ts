import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer, request as httpRequest } from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, before, test } from "node:test"
import type { SessionEvent } from "../../src/engine/durable.ts"
import { memoryDbPath, openMemoryDb } from "../../src/memory/db.ts"
import { createProposal } from "../../src/memory/proposals.ts"
import type { ProposalStatus, ProposalTests } from "../../src/memory/proposals.ts"
import { git } from "../../src/selfedit/git.ts"
import { startServer, type RunningServer } from "../../src/server/server.ts"

interface FakeToolCall {
  name: string
  arguments: Record<string, unknown>
}

interface FakeReply {
  content?: string
  toolCalls?: FakeToolCall[]
  delayMs?: number
}

interface FakeRequestBody {
  messages: Array<{ role: string; content: string }>
  tools?: Array<{ type: string; function: { name: string } }>
}

interface FakeLlm {
  url: string
  bodies: FakeRequestBody[]
  push(reply: FakeReply): void
  reset(): void
  close(): Promise<void>
}

async function startFakeLlm(): Promise<FakeLlm> {
  const queue: FakeReply[] = []
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const bodies: FakeRequestBody[] = []
  let requests = 0

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end()
      return
    }
    const chunks: Buffer[] = []
    request.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
    request.on("end", () => {
      requests += 1
      try {
        bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as FakeRequestBody)
      } catch {

      }
      const reply = queue.shift() ?? { content: "(no further script)" }
      const sendReply = () => {
        if (response.destroyed || response.writableEnded) return
        const toolCalls = reply.toolCalls?.map((call, index) => ({
          id: `call-${requests}-${index}`,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        }))
        const payload = {
          id: `chatcmpl-${requests}`,
          object: "chat.completion",
          created: 1_700_000_000,
          model: "fake-model",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: reply.content ?? "",
                ...(toolCalls && toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
              },
              finish_reason: toolCalls && toolCalls.length > 0 ? "tool_calls" : "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }
        response.writeHead(200, { "content-type": "application/json" })
        response.end(JSON.stringify(payload))
      }
      if (reply.delayMs && reply.delayMs > 0) {
        const timer = setTimeout(() => {
          timers.delete(timer)
          sendReply()
        }, reply.delayMs)
        timers.add(timer)
      } else {
        sendReply()
      }
    })
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}/v1`,
    bodies,
    push: (reply) => {
      queue.push(reply)
    },
    reset: () => {
      queue.length = 0
      bodies.length = 0
    },
    close: async () => {
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

interface Reply {
  status: number
  text: string
  json: any
}

function request(port: number, method: string, requestPath: string, body?: unknown): Promise<Reply> {
  return new Promise<Reply>((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method,
        path: requestPath,
        headers:
          payload === undefined
            ? {}
            : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8")
          let json: unknown
          try {
            json = JSON.parse(text)
          } catch {
            json = undefined
          }
          resolve({ status: response.statusCode ?? 0, text, json })
        })
      },
    )
    req.on("error", reject)
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}

const AGENT = "contract"

const FAKE_PI_SOURCE = `#!/bin/sh
printf 'contract worker reporting in\\n'
exit 0
`

interface Fixture {
  running: RunningServer
  fake: FakeLlm
  root: string
  workspace: string
  binDir: string
  piBin: string
  repo: string
  restarts: number[]
}

let fixture: Fixture

async function startCtrl(opts: {
  baseUrl: string
  root: string
  workspace: string
  piBin: string
  repo: string
  restarts: number[]
}): Promise<RunningServer> {
  return await startServer({
    root: opts.root,
    agent: AGENT,
    workspace: opts.workspace,
    port: 0,
    host: "127.0.0.1",
    maxSteps: 6,
    dream: false,
    piBin: opts.piBin,
    piProvider: "any-endpoint",
    maxWorkers: 3,
    selfEdit: {
      repoRoot: opts.repo,
      verifyCommands: ["true"],
      restart: () => {
        opts.restarts.push(Date.now())
      },
    },
    env: {
      ...process.env,
      PI_DURABLE_API_KEY: "{{SECRET_contract_key}}",
      PI_DURABLE_BASE_URL: opts.baseUrl,
      PI_DURABLE_MODEL: "fake-model",
    },
  })
}

async function mustGit(repo: string, args: string[]): Promise<string> {
  const result = await git(repo, args)
  assert.equal(result.ok, true, `git ${args.join(" ")} failed: ${result.stderr}`)
  return result.stdout
}

async function makeRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), "ctrl-contract-repo-"))
  await mustGit(repo, ["init", "-q", "-b", "main"])
  await mustGit(repo, ["config", "user.email", "contract@example.com"])
  await mustGit(repo, ["config", "user.name", "contract"])
  await mustGit(repo, ["config", "commit.gpgsign", "false"])
  await writeFile(path.join(repo, "README.md"), "# contract\n", "utf8")
  await mustGit(repo, ["add", "-A"])
  await mustGit(repo, ["commit", "-q", "-m", "init"])
  return repo
}

async function seedProposal(opts: {
  id: string
  branch: string
  tests?: ProposalTests
  status?: ProposalStatus
  createdAt?: string
}): Promise<void> {
  const db = openMemoryDb(memoryDbPath(fixture.running.ctx.agentHome))
  try {
    createProposal(db, {
      id: opts.id,
      branch: opts.branch,
      base: "main",
      task: `contract ${opts.id}`,
      status: opts.status ?? "open",
      createdAt: opts.createdAt ?? new Date().toISOString(),
      ...(opts.tests !== undefined ? { tests: opts.tests } : {}),
    })
  } finally {
    db.close()
  }
}

function localDay(at: Date): string {
  const month = String(at.getMonth() + 1).padStart(2, "0")
  const day = String(at.getDate()).padStart(2, "0")
  return `${at.getFullYear()}-${month}-${day}`
}

async function seedUsage(promptTokens: number, completionTokens: number): Promise<void> {
  const db = openMemoryDb(memoryDbPath(fixture.running.ctx.agentHome))
  try {
    db.prepare(
      "INSERT INTO usage(id, ts, kind, model, prompt_tokens, completion_tokens, ms, ok) VALUES (?, ?, ?, ?, ?, ?, ?, 1)",
    ).run("contract-seed", new Date().toISOString(), "dream", "fake-model", promptTokens, completionTokens, 5)
  } finally {
    db.close()
  }
}

before(async () => {
  const fake = await startFakeLlm()
  const root = await mkdtemp(path.join(tmpdir(), "ctrl-contract-root-"))
  const workspace = await mkdtemp(path.join(tmpdir(), "ctrl-contract-work-"))
  const binDir = await mkdtemp(path.join(tmpdir(), "ctrl-contract-bin-"))
  const piBin = path.join(binDir, "pi")
  await writeFile(piBin, FAKE_PI_SOURCE, { mode: 0o755 })
  const repo = await makeRepo()
  const restarts: number[] = []
  const running = await startCtrl({ baseUrl: fake.url, root, workspace, piBin, repo, restarts })
  fixture = { running, fake, root, workspace, binDir, piBin, repo, restarts }
})

after(async () => {
  await fixture.running.close()
  await fixture.fake.close()
  await rm(fixture.root, { recursive: true, force: true })
  await rm(fixture.workspace, { recursive: true, force: true })
  await rm(fixture.binDir, { recursive: true, force: true })
  await rm(fixture.repo, { recursive: true, force: true })
})

function api(method: string, requestPath: string, body?: unknown): Promise<Reply> {
  return request(fixture.running.port, method, requestPath, body)
}

interface Stream {
  events: SessionEvent[]
  total: number
  since: number
  turn: { running: boolean; error?: string; aborted?: boolean; startedAt?: string }
}

async function eventsStream(query = ""): Promise<Stream> {
  const reply = await api("GET", `/api/agent/events${query}`)
  assert.equal(reply.status, 200, reply.text)
  return reply.json as Stream
}

async function settle(timeoutMs = 10_000): Promise<Stream> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const snapshot = await eventsStream("?tail=1")
    if (!snapshot.turn.running) return snapshot
    if (Date.now() > deadline) throw new Error("turn did not finish in time")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function send(text: string): Promise<Reply> {
  return await api("POST", "/api/agent/messages", { text })
}

async function eventCount(): Promise<number> {
  return (await eventsStream("?tail=1")).total
}

async function settledJobs(timeoutMs = 15_000): Promise<Array<Record<string, any>>> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const reply = await api("GET", "/api/jobs")
    assert.equal(reply.status, 200, reply.text)
    const jobs = reply.json.jobs as Array<Record<string, any>>
    if (jobs.length > 0 && jobs.every((job) => job.state !== "running")) return jobs
    if (Date.now() > deadline) throw new Error(`jobs never settled: ${JSON.stringify(jobs)}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

const ALLOWED_EVENT_TYPES = [
  "assistant_message",
  "assistant_pending",
  "compaction",
  "error",
  "memory_recall",
  "memory_write",
  "session_created",
  "tool_call",
  "tool_result",
  "user_message",
]

test("GET /api/agent is exactly agent, session, resumePoint, turn, memory and context", async () => {
  const reply = await api("GET", "/api/agent")
  assert.equal(reply.status, 200, reply.text)
  assert.deepEqual(Object.keys(reply.json).sort(), [
    "agent",
    "context",
    "memory",
    "resumePoint",
    "session",
    "turn",
  ])
  assert.equal(reply.json.agent, AGENT)
  assert.deepEqual(Object.keys(reply.json.session).sort(), [
    "createdAt",
    "cwd",
    "eventCount",
    "lastSeq",
    "model",
    "sessionId",
    "updatedAt",
    "uptimeSeconds",
  ])
  assert.equal(reply.json.session.sessionId, "main")
  assert.equal(reply.json.session.cwd, fixture.workspace)
  assert.equal(reply.json.session.eventCount, 1)
  assert.equal(reply.json.session.lastSeq, 0)
  assert.equal(typeof reply.json.session.uptimeSeconds, "number")
  assert.ok(Number.isInteger(reply.json.session.uptimeSeconds), "uptimeSeconds is an integer")
  assert.ok(reply.json.session.uptimeSeconds >= 0, "uptimeSeconds is never negative")
  assert.deepEqual(reply.json.resumePoint, { kind: "clean" })
  assert.deepEqual(reply.json.turn, { running: false })
  assert.deepEqual(Object.keys(reply.json.memory).sort(), ["focusOpen", "lastDreamAt", "memories"])
  assert.deepEqual(reply.json.memory, { memories: 0, focusOpen: 0, lastDreamAt: null })
  assert.deepEqual(Object.keys(reply.json.context).sort(), ["chars", "windowStart"])
  assert.equal(reply.json.context.windowStart, 0)
  assert.equal(reply.json.context.chars, 0)
})

test("focus, memories and dreams answer with an empty shape instead of 404", async () => {
  const focus = await api("GET", "/api/focus")
  assert.equal(focus.status, 200, focus.text)
  assert.deepEqual(focus.json, { items: [] })

  const memories = await api("GET", "/api/memories")
  assert.equal(memories.status, 200, memories.text)
  assert.deepEqual(memories.json, { memories: [], count: 0 })

  const dreams = await api("GET", "/api/dreams")
  assert.equal(dreams.status, 200, dreams.text)
  assert.deepEqual(dreams.json, { runs: [] })
})

test("memories can be filtered by kind, and only by a kind that exists", async () => {
  const lessons = await api("GET", "/api/memories?kind=lesson")
  assert.equal(lessons.status, 200, lessons.text)
  assert.deepEqual(lessons.json, { memories: [], count: 0 })
  assert.deepEqual(Object.keys(lessons.json).sort(), ["count", "memories"])

  const unfiltered = await api("GET", "/api/memories")
  assert.equal(unfiltered.status, 200, unfiltered.text)
  assert.deepEqual(unfiltered.json, { memories: [], count: 0 })

  const bogus = await api("GET", "/api/memories?kind=nonsense")
  assert.equal(bogus.status, 400, bogus.text)
  assert.match(bogus.text, /kind must be/)
})

test("GET /api/usage answers a zeroed window on a fresh ledger", async () => {
  const reply = await api("GET", "/api/usage?days=3")
  assert.equal(reply.status, 200, reply.text)
  assert.deepEqual(Object.keys(reply.json).sort(), ["days", "today", "total"])
  assert.deepEqual(reply.json.today, { calls: 0, promptTokens: 0, completionTokens: 0, ms: 0 })
  assert.deepEqual(reply.json.total, { calls: 0, promptTokens: 0, completionTokens: 0, ms: 0 })
  assert.equal(reply.json.days.length, 3)
  for (const day of reply.json.days as Array<Record<string, any>>) {
    assert.deepEqual(Object.keys(day).sort(), ["calls", "completionTokens", "date", "promptTokens"])
    assert.equal(day.calls, 0)
    assert.equal(day.promptTokens, 0)
    assert.equal(day.completionTokens, 0)
  }
  assert.equal(reply.json.days.at(-1).date, localDay(new Date()))

  const week = await api("GET", "/api/usage")
  assert.equal(week.status, 200, week.text)
  assert.equal(week.json.days.length, 7)
})

test("GET /api/usage only accepts days between 1 and 90", async () => {
  for (const bad of ["abc", "0", "91", "-3", "1.5", "7days"]) {
    const reply = await api("GET", `/api/usage?days=${bad}`)
    assert.equal(reply.status, 400, `${bad}: ${reply.text}`)
    assert.match(reply.json.error, /days must be an integer/)
  }
  assert.equal((await api("POST", "/api/usage")).status, 405)
})

test("machines and sessions are always 404", async () => {
  assert.equal((await api("GET", "/api/machines")).status, 404)
  assert.equal((await api("GET", "/api/machines/box")).status, 404)
  assert.equal((await api("POST", "/api/machines", {})).status, 404)
  assert.equal((await api("DELETE", "/api/machines/box")).status, 404)
  assert.equal((await api("GET", "/api/sessions")).status, 404)
  assert.equal((await api("POST", "/api/sessions", { cwd: fixture.workspace })).status, 404)
  assert.equal((await api("GET", "/api/sessions/main")).status, 404)
  assert.equal((await api("GET", "/api/sessions/main/events?since=0")).status, 404)
  assert.equal((await api("POST", "/api/sessions/main/messages", { text: "hi" })).status, 404)
  assert.equal((await api("DELETE", "/api/sessions/main")).status, 404)
  assert.equal((await api("GET", "/api/agents")).status, 404)
})

test("a message is accepted once with 202, refused with 409 while a turn runs and refused with 400 when empty", async () => {
  fixture.fake.reset()
  fixture.fake.push({ content: "still thinking", delayMs: 400 })

  const accepted = await send("first")
  assert.equal(accepted.status, 202, accepted.text)
  assert.equal(accepted.json.accepted, true)
  assert.equal(accepted.json.turn.running, true)
  assert.equal(typeof accepted.json.turn.startedAt, "string")

  const busy = await send("second")
  assert.equal(busy.status, 409, busy.text)
  assert.match(busy.json.error, /already running/)

  await settle()

  assert.equal((await send("   ")).status, 400)
  assert.equal((await api("POST", "/api/agent/messages", {})).status, 400)
  assert.equal((await api("POST", "/api/agent/messages", { text: 42 })).status, 400)
  assert.equal((await api("GET", "/api/agent/messages")).status, 405)
})

test("the model is offered exactly ten tools under fixed names", async () => {
  fixture.fake.reset()
  fixture.fake.push({ content: "no tool needed" })
  assert.equal((await send("which tools do you have?")).status, 202)
  await settle()

  const body = fixture.fake.bodies.at(-1)
  assert.ok(body, "the fake model saw a request")
  const names = (body.tools ?? []).map((tool) => tool.function.name)
  assert.equal(names.length, 10)
  assert.deepEqual(names.slice().sort(), [
    "apply_proposal",
    "delegate",
    "focus_set",
    "job_status",
    "job_stop",
    "recall",
    "remember",
    "search_context",
    "self_edit",
    "view_image",
  ])
})

test("a delegated turn logs only the durable pi event types", async () => {
  fixture.fake.reset()
  fixture.fake.push({ toolCalls: [{ name: "delegate", arguments: { task: "say hello" } }] })
  fixture.fake.push({ content: "the worker said hello" })
  assert.equal((await send("delegate the greeting")).status, 202)
  await settle()

  const whole = await eventsStream("?since=0")
  assert.ok(whole.total < 200, "the whole log has to fit on one page here")
  assert.equal(whole.events[0]?.type, "session_created")
  const types = new Set(whole.events.map((event) => event.type))
  for (const type of types) {
    assert.ok(ALLOWED_EVENT_TYPES.includes(type), `unexpected event type ${type}`)
  }
  assert.ok(types.has("user_message"))
  assert.ok(types.has("assistant_message"))
  assert.ok(types.has("tool_call"))
  assert.ok(types.has("tool_result"))
  whole.events.forEach((event, index) => assert.equal(event.seq, index))
})

test("GET /api/jobs reports exactly id, state, task, startedAt, elapsedMs and the optional code and output", async () => {
  const jobs = await settledJobs()
  assert.equal(jobs.length, 1)
  const job = jobs[0] as Record<string, any>
  const allowedKeys = ["id", "state", "task", "startedAt", "elapsedMs", "code", "output"]
  for (const key of Object.keys(job)) assert.ok(allowedKeys.includes(key), `unexpected job key ${key}`)
  assert.deepEqual(Object.keys(job).sort(), ["code", "elapsedMs", "id", "output", "startedAt", "state", "task"])
  assert.equal(job.state, "exited")
  assert.equal(job.code, 0)
  assert.equal(job.task, "say hello")
  assert.equal(typeof job.startedAt, "string")
  assert.equal(typeof job.elapsedMs, "number")
  assert.match(String(job.output), /contract worker reporting in/)
  assert.equal((await api("POST", "/api/jobs", {})).status, 405)
})

test("event paging caps at 200, since returns the first seq and before outranks tail", async () => {
  let guard = 0
  while ((await eventCount()) < 210) {
    guard += 1
    assert.ok(guard <= 300, "the log never grew past 210 events")
    fixture.fake.push({ content: `filler ${guard}` })
    const reply = await send(`filler ${guard}`)
    assert.equal(reply.status, 202, reply.text)
    await settle()
  }

  const firstPage = await eventsStream("?since=0")
  assert.equal(firstPage.events.length, 200)
  assert.equal(firstPage.since, 0)
  assert.equal(firstPage.events[0]?.seq, 0)

  const capped = await eventsStream("?tail=100000")
  const total = capped.total
  assert.ok(total >= 210, `expected a long log, got ${total}`)
  assert.equal(capped.events.length, 200)
  assert.equal(capped.since, total - 200)
  assert.deepEqual(
    capped.events.map((event) => event.seq),
    Array.from({ length: 200 }, (_, index) => total - 200 + index),
  )

  const fromSeq = await eventsStream("?since=150")
  assert.equal(fromSeq.total, total)
  assert.equal(fromSeq.since, 150)
  assert.equal(fromSeq.events[0]?.seq, 150)

  const shortTail = await eventsStream("?tail=3")
  assert.deepEqual(shortTail.events.map((event) => event.seq), [total - 3, total - 2, total - 1])

  const beforeWins = await eventsStream("?before=50&tail=3&since=1000")
  assert.deepEqual(beforeWins.events.map((event) => event.seq), [47, 48, 49])
  assert.equal(beforeWins.since, 47)
  assert.equal(beforeWins.total, total)

  const empty = await eventsStream("?before=0")
  assert.deepEqual(empty.events, [])
  assert.equal(empty.since, 0)
})

test("GET /api/proposals answers an empty shape and unknown ids 404", async () => {
  const empty = await api("GET", "/api/proposals")
  assert.equal(empty.status, 200, empty.text)
  assert.deepEqual(empty.json, { proposals: [] })

  assert.equal((await api("GET", "/api/proposals/nope")).status, 404)
  assert.equal((await api("POST", "/api/proposals/nope/apply")).status, 404)
  assert.equal((await api("POST", "/api/proposals/nope/discard")).status, 404)
  assert.equal((await api("POST", "/api/proposals")).status, 405)
})

test("GET /api/proposals lists newest first with the fixed proposal shape", async () => {
  await seedProposal({
    id: "older",
    branch: "self/older",
    createdAt: "2026-01-01T00:00:00.000Z",
    tests: { typecheck: { ok: true } },
  })
  await seedProposal({
    id: "newer",
    branch: "self/newer",
    createdAt: "2026-02-01T00:00:00.000Z",
    tests: { typecheck: { ok: true } },
  })

  const reply = await api("GET", "/api/proposals")
  assert.equal(reply.status, 200, reply.text)
  const proposals = reply.json.proposals as Array<Record<string, any>>
  assert.deepEqual(proposals.map((proposal) => proposal.id), ["newer", "older"])
  const first = proposals[0] as Record<string, any>
  assert.deepEqual(Object.keys(first).sort(), ["base", "branch", "createdAt", "id", "status", "task", "tests"])
  assert.equal(first.status, "open")
  assert.equal(first.base, "main")
  assert.equal(first.branch, "self/newer")
  assert.deepEqual(first.tests, { typecheck: { ok: true } })
})

test("applying a proposal with red tests answers 409 and keeps it open", async () => {
  await seedProposal({
    id: "red",
    branch: "self/red",
    tests: { typecheck: { ok: false, output: "boom" } },
  })

  const reply = await api("POST", "/api/proposals/red/apply")
  assert.equal(reply.status, 409, reply.text)
  assert.match(reply.json.error, /typecheck/)

  const detail = await api("GET", "/api/proposals/red")
  assert.equal(detail.status, 200, detail.text)
  assert.equal(detail.json.proposal.status, "open")
  assert.equal(detail.json.diff, "")
})

test("applying a green proposal merges its branch and schedules a restart", async () => {
  const branch = "self/green"
  await mustGit(fixture.repo, ["checkout", "-q", "-b", branch])
  await writeFile(path.join(fixture.repo, "green.txt"), "green\n", "utf8")
  await mustGit(fixture.repo, ["add", "-A"])
  await mustGit(fixture.repo, ["commit", "-q", "-m", "green"])
  await mustGit(fixture.repo, ["checkout", "-q", "main"])
  await seedProposal({
    id: "green",
    branch,
    tests: { typecheck: { ok: true }, unit: { ok: true } },
  })

  const restarts = fixture.restarts.length
  const preApply = await api("GET", "/api/proposals/green")
  assert.equal(preApply.status, 200, preApply.text)
  assert.match(preApply.json.diff, /\+green/)

  const reply = await api("POST", "/api/proposals/green/apply")
  assert.equal(reply.status, 200, reply.text)
  assert.deepEqual(reply.json, { applied: true, restarting: true })
  assert.equal((await readFile(path.join(fixture.repo, "green.txt"), "utf8")).trim(), "green")

  const detail = await api("GET", "/api/proposals/green")
  assert.equal(detail.status, 200, detail.text)
  assert.equal(detail.json.proposal.status, "applied")
  assert.equal(detail.json.diff, "")

  const deadline = Date.now() + 3_000
  while (fixture.restarts.length === restarts && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.equal(fixture.restarts.length, restarts + 1)
})

test("discarding a proposal deletes its branch and marks it discarded", async () => {
  const branch = "self/red"
  await mustGit(fixture.repo, ["checkout", "-q", "-b", branch])
  await writeFile(path.join(fixture.repo, "red.txt"), "red\n", "utf8")
  await mustGit(fixture.repo, ["add", "-A"])
  await mustGit(fixture.repo, ["commit", "-q", "-m", "red"])
  await mustGit(fixture.repo, ["checkout", "-q", "main"])

  const reply = await api("POST", "/api/proposals/red/discard")
  assert.equal(reply.status, 200, reply.text)
  assert.equal(reply.json.discarded, true)
  assert.equal(reply.json.proposal.status, "discarded")

  const gone = await git(fixture.repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])
  assert.equal(gone.ok, false)

  const listed = await api("GET", "/api/proposals")
  const red = (listed.json.proposals as Array<Record<string, any>>).find((proposal) => proposal.id === "red")
  assert.equal(red?.status, "discarded")

  assert.equal((await api("POST", "/api/proposals/green/discard")).status, 409)
})

test("the usage ledger counts every model call and buckets it by local day", async () => {
  await seedUsage(1000, 2000)

  const reply = await api("GET", "/api/usage?days=2")
  assert.equal(reply.status, 200, reply.text)
  assert.equal(reply.json.days.length, 2)
  assert.ok(reply.json.total.calls >= 2, `expected the turns and the seed, got ${reply.json.total.calls}`)
  assert.ok(reply.json.total.promptTokens >= 1000)
  assert.ok(reply.json.total.completionTokens >= 2000)
  assert.deepEqual(
    reply.json.today,
    {
      calls: reply.json.total.calls,
      promptTokens: reply.json.total.promptTokens,
      completionTokens: reply.json.total.completionTokens,
      ms: reply.json.today.ms,
    },
    "every call in a two day window landed today",
  )
  const summed = (reply.json.days as Array<Record<string, any>>).reduce((sum, day) => sum + day.calls, 0)
  assert.equal(summed, reply.json.total.calls)
  assert.ok(reply.json.days.at(-1).promptTokens >= 1000)
})
