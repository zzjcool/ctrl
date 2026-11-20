import assert from "node:assert/strict"
import { createServer, request as httpRequest } from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, before, test } from "node:test"
import type { SessionEvent } from "../../src/engine/durable.ts"
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

interface FakeLlm {
  url: string
  requests: number
  push(reply: FakeReply): void
  reset(): void

  bodies: Array<{ messages: Array<{ role: string; content: string }> }>
  close(): Promise<void>
}

async function startFakeLlm(): Promise<FakeLlm> {
  const queue: FakeReply[] = []
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const bodies: Array<{ messages: Array<{ role: string; content: string }> }> = []
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
        bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")))
      } catch {

      }
      const reply = queue.shift() ?? { content: "(no further script)" }
      const send = () => {
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
          send()
        }, reply.delayMs)
        timers.add(timer)
      } else {
        send()
      }
    })
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}/v1`,
    get requests() {
      return requests
    },
    push: (reply) => {
      queue.push(reply)
    },
    reset: () => {
      queue.length = 0
      bodies.length = 0
    },
    bodies,
    close: async () => {
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  } as FakeLlm
}

interface Reply {
  status: number
  headers: Record<string, string | string[] | undefined>
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
          resolve({ status: response.statusCode ?? 0, headers: response.headers, text, json })
        })
      },
    )
    req.on("error", reject)
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}

const AGENT = "tester"

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  "base64",
)

const FAKE_PI_SOURCE = `#!/bin/sh
printf 'args: %s\\n' "$*"
sleep 0.3
printf 'found 42 files\\n'
printf 'done\\n'
exit 0
`

interface Fixture {
  running: RunningServer
  fake: FakeLlm
  root: string
  workspace: string

  piBin: string

  binDir: string
}

let fixture: Fixture

interface StartOptions {
  baseUrl: string
  agent?: string
  root?: string
  workspace?: string
  piBin?: string
}

async function startCtrl(opts: StartOptions): Promise<RunningServer> {
  return await startServer({
    root: opts.root,
    agent: opts.agent ?? AGENT,
    workspace: opts.workspace,
    port: 0,
    host: "127.0.0.1",
    maxSteps: 6,

    piBin: opts.piBin,
    piProvider: "any-endpoint",
    piExtension: "",
    maxWorkers: 3,
    env: {
      ...process.env,
      PI_DURABLE_API_KEY: "test-key",
      PI_DURABLE_BASE_URL: opts.baseUrl,
      PI_DURABLE_MODEL: "fake-model",
    },
  })
}

async function makeFakePi(): Promise<{ piBin: string; binDir: string }> {
  const binDir = await mkdtemp(path.join(tmpdir(), "ctrl-e2e-bin-"))
  const piBin = path.join(binDir, "pi")
  await writeFile(piBin, FAKE_PI_SOURCE, { mode: 0o755 })
  return { piBin, binDir }
}

async function startFixture(baseUrl: string): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "ctrl-e2e-root-"))
  const workspace = await mkdtemp(path.join(tmpdir(), "ctrl-e2e-work-"))
  const { piBin, binDir } = await makeFakePi()
  const running = await startCtrl({ baseUrl, root, workspace, piBin })
  return { running, fake: undefined as unknown as FakeLlm, root, workspace, piBin, binDir }
}

before(async () => {
  const fake = await startFakeLlm()
  const started = await startFixture(fake.url)
  fixture = { ...started, fake }
})

after(async () => {
  await fixture.running.close()
  await fixture.fake.close()
  await rm(fixture.root, { recursive: true, force: true })
  await rm(fixture.workspace, { recursive: true, force: true })
  await rm(fixture.binDir, { recursive: true, force: true })
})

function api(method: string, requestPath: string, body?: unknown): Promise<Reply> {
  return request(fixture.running.port, method, requestPath, body)
}

function uploadImage(bytes: Buffer, contentType: string): Promise<Reply> {
  return new Promise<Reply>((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: fixture.running.port,
        method: "POST",
        path: "/api/agent/images",
        headers: { "content-type": contentType, "content-length": bytes.byteLength },
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
          resolve({ status: response.statusCode ?? 0, headers: response.headers, text, json })
        })
      },
    )
    req.on("error", reject)
    req.write(bytes)
    req.end()
  })
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

async function settle(timeoutMs = 8000): Promise<Stream> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const snapshot = await eventsStream("?since=0")
    if (!snapshot.turn.running) return snapshot
    if (Date.now() > deadline) throw new Error("turn did not finish in time")
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

async function send(text: string): Promise<Reply> {
  return await api("POST", "/api/agent/messages", { text })
}

test("one agent, named on disk, with one log and no machine", async () => {
  const health = await api("GET", "/api/health")
  assert.equal(health.status, 200)
  assert.deepEqual(health.json, { status: "ok", agent: AGENT }, "no machine and no kind: ctrl has no hands")

  const detail = await api("GET", "/api/agent")
  assert.equal(detail.status, 200, detail.text)
  assert.equal(detail.json.agent, AGENT, "the agent is a name, not a title")
  assert.equal(detail.json.session.sessionId, "main", "the log id is always main")
  assert.equal(detail.json.session.model, "fake-model")
  assert.equal(detail.json.session.cwd, fixture.workspace, "the workspace comes from the sidecar")
  assert.equal(detail.json.session.eventCount, 1, "a fresh agent has exactly session_created")
  assert.deepEqual(detail.json.resumePoint, { kind: "clean" })
  assert.equal(detail.json.turn.running, false)
  assert.equal(detail.json.machine, undefined, "there is no machine to report")
  assert.equal(detail.json.session.machine, undefined)

  const home = path.join(fixture.root, "agents", AGENT)
  const agentFile = JSON.parse(await readFile(path.join(home, "agent.json"), "utf8"))
  assert.equal(agentFile.name, AGENT)
  assert.equal(agentFile.model, "fake-model")
  assert.equal(typeof agentFile.createdAt, "string")
  assert.ok((await stat(path.join(home, "sessions", "main", "events.jsonl"))).isFile())
  const sidecar = JSON.parse(await readFile(path.join(home, "sessions", "main", "ctrl.json"), "utf8"))
  assert.deepEqual(Object.keys(sidecar).sort(), ["createdAt", "cwd"], "v3 remembers a directory, not a machine")
  assert.equal(sidecar.cwd, fixture.workspace)

  assert.deepEqual((await api("GET", "/api/jobs")).json, { jobs: [] })
  assert.equal((await api("GET", "/api/machines")).status, 404)

  assert.equal((await api("GET", "/api/agents")).status, 404)
})

async function waitForJob(id: string, timeoutMs = 10_000): Promise<Record<string, any>> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const reply = await api("GET", "/api/jobs")
    assert.equal(reply.status, 200, reply.text)
    const job = (reply.json.jobs as Record<string, any>[]).find((candidate) => candidate.id === id)
    if (job !== undefined && job.state !== "running") return job
    if (Date.now() > deadline) throw new Error(`job ${id} never finished: ${JSON.stringify(job)}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

let delegatedJob = ""

test("a turn delegates to a pi worker and the log carries the job id", async () => {
  fixture.fake.reset()
  fixture.fake.push({ toolCalls: [{ name: "delegate", arguments: { task: "count the .ts files under src" } }] })
  fixture.fake.push({ content: "the worker is counting them" })

  const created = await send("how many .ts files are there?")
  assert.equal(created.status, 202, created.text)
  assert.equal(created.json.accepted, true)
  assert.equal(created.json.turn.running, true)

  const snapshot = await settle()
  const events = snapshot.events

  const types = events.map((event) => event.type)
  assert.equal(types[0], "session_created")
  assert.ok(types.includes("user_message"))
  assert.ok(types.includes("tool_call"))
  assert.ok(types.includes("tool_result"))
  assert.equal(types.filter((type) => type === "assistant_message").length, 2)

  const calls = events.filter((event) => event.type === "tool_call") as Extract<SessionEvent, { type: "tool_call" }>[]
  const results = events.filter((event) => event.type === "tool_result") as Extract<SessionEvent, { type: "tool_result" }>[]
  assert.deepEqual(calls.map((event) => event.data.name), ["delegate"])
  assert.deepEqual(results.map((event) => event.data.ok), [true])
  assert.equal(results[0]?.data.callId, calls[0]?.data.callId)

  const delegateOutput = results[0]?.data.output ?? ""
  const match = /job (\d{8}T\d{6}Z-[a-z0-9]{6})/.exec(delegateOutput)
  assert.ok(match, `unexpected delegate output: ${delegateOutput}`)
  assert.match(delegateOutput, /state: (running|exited)/)
  const id = match[1] as string
  delegatedJob = id

  const final = events.filter((event) => event.type === "assistant_message").at(-1) as
    | Extract<SessionEvent, { type: "assistant_message" }>
    | undefined
  assert.equal(final?.data.text, "the worker is counting them")

  const jobDir = path.join(fixture.root, "agents", AGENT, "jobs", id)
  const meta = JSON.parse(await readFile(path.join(jobDir, "meta.json"), "utf8"))
  assert.equal(meta.id, id)
  assert.equal(meta.task, "count the .ts files under src")
  assert.equal(meta.cwd, fixture.workspace, "the worker runs in the agent's workspace")
  assert.equal(meta.model, "fake-model", "the worker inherits ctrl's model unless delegate overrides it")
  assert.equal(typeof meta.pid, "number")
  assert.ok((await stat(path.join(jobDir, "pi"))).isDirectory())
  assert.ok((await stat(path.join(jobDir, "out.log"))).isFile())

  assert.deepEqual(await readdir(fixture.workspace), [])

  events.forEach((event, index) => assert.equal(event.seq, index))
  assert.equal(snapshot.total, events.length)

  const tail = await eventsStream("?since=3")
  assert.equal(tail.total, events.length)
  assert.equal(tail.since, 3)
  assert.equal(tail.events.length, events.length - 3)
  assert.equal(tail.events[0]?.seq, 3)
})

test("job_status reports what the worker did, and /api/jobs agrees", async () => {
  const job = await waitForJob(delegatedJob)
  assert.equal(job.state, "exited")
  assert.equal(job.code, 0)
  assert.equal(job.task, "count the .ts files under src")
  assert.equal(typeof job.startedAt, "string")
  assert.ok(job.elapsedMs >= 250, `the worker's runtime is measured (got ${job.elapsedMs})`)

  assert.deepEqual(
    Object.keys(job).filter((key) => key !== "output").sort(),
    ["code", "elapsedMs", "id", "startedAt", "state", "task"],
  )
  assert.match(String(job.output ?? ""), /found 42 files/, "the summary carries the tail of the worker's log")

  const log = await readFile(path.join(fixture.root, "agents", AGENT, "jobs", delegatedJob, "out.log"), "utf8")
  assert.match(log, /args: -p count the \.ts files under src --provider any-endpoint --model fake-model --thinking max/)

  fixture.fake.reset()
  fixture.fake.push({ toolCalls: [{ name: "job_status", arguments: { id: delegatedJob, lines: 10 } }] })
  fixture.fake.push({ content: "the worker found 42 files" })

  assert.equal((await send("what did the worker say?")).status, 202)
  const snapshot = await settle()
  const calls = snapshot.events.filter((event) => event.type === "tool_call") as Extract<
    SessionEvent,
    { type: "tool_call" }
  >[]

  assert.deepEqual(calls.map((event) => event.data.name), ["delegate", "job_status"])
  assert.equal(calls.at(-1)?.data.name, "job_status", "the new turn polled the job")
  const results = snapshot.events.filter((event) => event.type === "tool_result") as Extract<
    SessionEvent,
    { type: "tool_result" }
  >[]
  const output = results.at(-1)?.data.output ?? ""
  assert.ok(output.includes(`job ${delegatedJob}`), output)
  assert.match(output, /state: exited {2}exit: 0/)
  assert.match(output, /found 42 files/)
  assert.match(output, /done/)
})

test("tail and before page through one log without losing it", async () => {
  const whole = await eventsStream("?since=0")
  const total = whole.total
  assert.ok(total > 3, `expected some history, got ${total}`)

  const lastTwo = await eventsStream("?tail=2")
  assert.deepEqual(lastTwo.events.map((event) => event.seq), [total - 2, total - 1])
  assert.equal(lastTwo.since, total - 2)

  const earlier = await eventsStream(`?before=${lastTwo.since}&tail=2`)
  assert.deepEqual(earlier.events.map((event) => event.seq), [Math.max(0, total - 4), Math.max(0, total - 3)])
  assert.equal(earlier.total, total)

  const collected: number[] = []
  let before: number | undefined = total
  for (let guard = 0; guard < 20; guard += 1) {
    const page = await eventsStream(`?before=${before}&tail=2`)
    collected.unshift(...page.events.map((event) => event.seq))
    if (page.since === 0) break
    before = page.since
  }
  assert.deepEqual(collected, whole.events.map((event) => event.seq))
})

test("a second turn while one is running is 409", async () => {
  fixture.fake.reset()
  fixture.fake.push({ content: "slow answer", delayMs: 400 })

  const first = await send("slow")
  assert.equal(first.status, 202)

  const second = await send("me too")
  assert.equal(second.status, 409, second.text)
  assert.match(second.json.error, /already running/)

  const snapshot = await settle()
  assert.equal(snapshot.turn.running, false)

  const texts = (snapshot.events.filter((event) => event.type === "user_message") as Extract<
    SessionEvent,
    { type: "user_message" }
  >[]).map((event) => event.data.text)
  assert.deepEqual(texts, ["how many .ts files are there?", "what did the worker say?", "slow"])
})

test("abort stops the turn and says so in the log", async () => {
  fixture.fake.reset()

  fixture.fake.push({ content: "never arrives", delayMs: 10_000 })

  const started = await send("hang")
  assert.equal(started.status, 202)

  const begun = Date.now()
  const aborted = await api("POST", "/api/agent/abort")
  assert.equal(aborted.status, 200)
  assert.equal(aborted.json.aborted, true)

  const snapshot = await settle(4000)
  assert.ok(Date.now() - begun < 4000, "abort must not wait for the model")
  assert.equal(snapshot.turn.aborted, true)
  assert.equal(snapshot.turn.error, undefined, "an abort is not an error")

  const errors = (snapshot.events.filter((event) => event.type === "error") as Extract<
    SessionEvent,
    { type: "error" }
  >[]).map((event) => event.data)
  const note = errors.find((data) => data.message === "turn aborted by the user")
  assert.ok(note, `expected an abort note, got ${JSON.stringify(errors)}`)
  assert.equal(note.fatal, false)

  const again = await api("POST", "/api/agent/abort")
  assert.equal(again.status, 200)
  assert.equal(again.json.aborted, false)

  fixture.fake.reset()
  fixture.fake.push({ content: "back in business" })
  const resumed = await send("again")
  assert.equal(resumed.status, 202)
  const after = await settle()
  assert.equal(after.turn.aborted, undefined)
  assert.equal(after.turn.error, undefined)
})

test("memory is the agent's own, with tombstone semantics", async () => {
  const created = await api("POST", "/api/memory", { kind: "fact", text: "Go lives on the build box", tags: ["build"] })
  assert.equal(created.status, 201, created.text)
  const id = created.json.memory.id as string
  assert.equal(created.json.memory.kind, "fact")

  const listed = await api("GET", "/api/memory")
  assert.equal(listed.status, 200)
  assert.ok(listed.json.memories.some((entry: { id: string }) => entry.id === id))

  assert.ok((await stat(path.join(fixture.root, "agents", AGENT, "memory", "index.jsonl"))).isFile())

  const rejected = await api("POST", "/api/memory", { kind: "nonsense", text: "x" })
  assert.equal(rejected.status, 400)

  const deleted = await api("DELETE", `/api/memory/${id}`)
  assert.equal(deleted.status, 200, deleted.text)
  assert.equal(deleted.json.deleted, id)

  const after = await api("GET", "/api/memory")
  assert.ok(!after.json.memories.some((entry: { id: string }) => entry.id === id), "a tombstone hides the entry")

  const gone = await api("DELETE", `/api/memory/${id}`)
  assert.equal(gone.status, 404)
})

test("/api/search finds older turns through the SQLite mirror", async () => {

  fixture.fake.reset()
  fixture.fake.push({ content: "统计完了，一共 12 个文件" })
  assert.equal((await send("帮我统计 .ts 文件的数量")).status, 202)
  await settle()

  const english = await api("GET", "/api/search?q=counting")
  assert.equal(english.status, 200, english.text)
  assert.equal(english.json.query, "counting")
  assert.equal(english.json.count, english.json.hits.length, "count is the number of hits")
  assert.ok(english.json.count >= 1, `expected a hit, got ${english.text}`)

  const hit = english.json.hits[0]
  assert.deepEqual(Object.keys(hit).sort(), ["body", "score", "seq", "ts", "type"])
  assert.equal(typeof hit.seq, "number")
  assert.match(hit.ts, /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(hit.type, "assistant_message")
  assert.match(hit.body, /counting/, "the snippet carries the match")
  assert.ok(hit.score <= 0, "bm25 orders by score ascending")

  const trigram = await api("GET", `/api/search?q=${encodeURIComponent("统计完了")}`)
  assert.equal(trigram.status, 200, trigram.text)
  assert.ok(trigram.json.count >= 1, trigram.text)

  const substring = await api("GET", `/api/search?q=${encodeURIComponent("文件")}`)
  assert.equal(substring.status, 200, substring.text)
  assert.ok(substring.json.count >= 1, substring.text)
  for (const found of substring.json.hits as Array<{ body: string }>) {
    assert.ok(found.body.includes("文件"), "a snippet always contains what was searched for")
  }

  const punctuation = await api("GET", `/api/search?q=${encodeURIComponent("hw-")}`)
  assert.equal(punctuation.status, 200, punctuation.text)
  assert.equal(punctuation.json.count, 0, "nothing in this narrative mentions hw-")

  const page = await api("GET", `/api/search?q=${encodeURIComponent("统计完了")}&limit=1`)
  assert.equal(page.status, 200, page.text)
  assert.equal(page.json.hits.length, 1)
  const older = await api(
    "GET",
    `/api/search?q=${encodeURIComponent("统计完了")}&limit=1&before=${page.json.hits[0].seq}`,
  )
  assert.equal(older.status, 200, older.text)
  assert.ok((older.json.hits as Array<{ seq: number }>).every((row) => row.seq < page.json.hits[0].seq))

  assert.ok((await stat(path.join(fixture.root, "agents", AGENT, "memory.db"))).isFile())

  assert.equal((await api("GET", "/api/search?q=")).status, 400)
  assert.equal((await api("GET", "/api/search?q=%20%20")).status, 400)
  assert.equal((await api("POST", "/api/search?q=x")).status, 405)
})

async function waitForDreams(count: number, timeoutMs = 8000): Promise<Record<string, any>[]> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const reply = await api("GET", "/api/dreams")
    assert.equal(reply.status, 200, reply.text)
    const runs = reply.json.runs as Record<string, any>[]
    if (runs.length >= count) return runs
    if (Date.now() > deadline) throw new Error(`expected ${count} dream runs, got ${JSON.stringify(runs)}`)
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
}

test("focus, memories and dreams are the panel's three surfaces (MEMORY.md §10.1)", async () => {

  const created = await api("POST", "/api/focus", { text: "实现 M4 面板" })
  assert.equal(created.status, 200, created.text)
  const focusId = created.json.item.id as string
  assert.deepEqual(Object.keys(created.json.item).sort(), ["id", "seq", "state", "text", "updatedAt"])
  assert.equal(created.json.item.state, "open")
  assert.equal(created.json.item.seq, null)

  const moved = await api("POST", "/api/focus", { id: focusId, state: "doing" })
  assert.equal(moved.status, 200, moved.text)
  assert.equal(moved.json.item.state, "doing")
  assert.equal(moved.json.item.text, "实现 M4 面板")

  const listed = await api("GET", "/api/focus")
  assert.equal(listed.status, 200, listed.text)
  assert.ok(
    (listed.json.items as Array<Record<string, any>>).some((item) => item.id === focusId && item.state === "doing"),
    "the item is in the panel",
  )
  assert.equal((await api("POST", "/api/focus", {})).status, 400, "text or id is required")
  assert.equal((await api("POST", "/api/focus", { text: "x", state: "nonsense" })).status, 400)

  const memory = await api("POST", "/api/memories", {
    text: "面板用 focus 和 memories 两块数据",
    kind: "decision",
    tags: ["m4"],
    importance: 0.7,
  })
  assert.equal(memory.status, 201, memory.text)
  const memoryId = memory.json.memory.id as string
  assert.equal(memory.json.memory.kind, "decision")
  assert.deepEqual(memory.json.memory.tags, ["m4"])
  assert.equal(memory.json.memory.importance, 0.7)

  const found = await api("GET", `/api/memories?query=${encodeURIComponent("面板")}`)
  assert.equal(found.status, 200, found.text)
  assert.equal(found.json.count, found.json.memories.length)
  assert.ok((found.json.memories as Array<Record<string, any>>).some((row) => row.id === memoryId))

  const duplicate = await api("POST", "/api/memories", { text: "  面板用 focus 和 memories 两块数据。 " })
  assert.equal(duplicate.status, 201, duplicate.text)
  assert.equal(duplicate.json.memory.id, memoryId, "same memory, same id")

  assert.equal((await api("POST", "/api/memories", { text: "  " })).status, 400)
  assert.equal((await api("POST", "/api/memories", { text: "x", kind: "nonsense" })).status, 400)

  fixture.fake.reset()
  const dreamPayload = {
    memories: [{ kind: "fact", text: "做梦写下的记忆", tags: ["dream"], importance: 0.6 }],
    focus: [{ text: "整理记忆", state: "open" }],
    profileRewrite: "# Profile\n\n- 用户说中文",
  }
  fixture.fake.push({ content: `好的：\n\`\`\`json\n${JSON.stringify(dreamPayload)}\n\`\`\`` })

  const started = await api("POST", "/api/dream")
  assert.equal(started.status, 202, started.text)
  assert.deepEqual(started.json, { started: true })

  const concurrent = await api("POST", "/api/dream")
  assert.ok(concurrent.status === 409 || concurrent.status === 202, concurrent.text)

  const runs = await waitForDreams(1)
  assert.equal(runs[0]?.added, 1, JSON.stringify(runs[0]))
  assert.equal(runs[0]?.error, undefined)
  assert.deepEqual(
    Object.keys(runs[0] ?? {}).sort(),
    ["added", "endedAt", "fromSeq", "id", "lessons", "merged", "startedAt", "superseded", "toSeq"],
  )
  assert.equal(runs[0]?.lessons, 0, "the script left no lessons")

  const afterDream = await api("GET", "/api/memories")
  assert.ok(
    (afterDream.json.memories as Array<Record<string, any>>).some((row) => row.text === "做梦写下的记忆"),
    afterDream.text,
  )
  const profile = await readFile(path.join(fixture.root, "agents", AGENT, "profile.md"), "utf8")
  assert.match(profile, /用户说中文/)
  assert.equal((await api("GET", "/api/dreams?limit=1")).json.runs.length, 1)

  const detail = await api("GET", "/api/agent")
  assert.equal(detail.status, 200, detail.text)
  assert.equal(typeof detail.json.memory.memories, "number")
  assert.ok(detail.json.memory.memories >= 2, JSON.stringify(detail.json.memory))
  assert.ok(detail.json.memory.focusOpen >= 2)
  assert.equal(typeof detail.json.memory.lastDreamAt, "string")
  assert.equal(detail.json.context.windowStart, 0, "nothing has been compacted yet")
  assert.ok(detail.json.context.chars > 0, "the log costs characters")

  const closed = await api("DELETE", `/api/focus/${focusId}`)
  assert.equal(closed.status, 200, closed.text)
  assert.equal(closed.json.item.state, "done")
  assert.ok(!(await api("GET", "/api/focus")).json.items.some((item: { id: string }) => item.id === focusId))
  assert.equal((await api("GET", "/api/focus?all=1")).json.items.some((item: { id: string }) => item.id === focusId), true)
  assert.equal((await api("DELETE", "/api/focus/nope")).status, 404)

  const deleted = await api("DELETE", `/api/memories/${memoryId}`)
  assert.equal(deleted.status, 200, deleted.text)
  assert.equal(deleted.json.deleted, memoryId)
  assert.ok(!(await api("GET", "/api/memories")).json.memories.some((row: { id: string }) => row.id === memoryId))
  const withAll = (await api("GET", "/api/memories?all=1")).json.memories as Array<Record<string, any>>
  assert.equal(withAll.find((row) => row.id === memoryId)?.supersededBy, `deleted:${memoryId}`, "a tombstone in place")
  assert.equal((await api("DELETE", "/api/memories/nope")).status, 404)

  assert.equal((await api("DELETE", "/api/memories")).status, 405)
  assert.equal((await api("GET", "/api/dream")).status, 405)
  assert.equal((await api("GET", "/api/focus/x/y")).status, 404)
})

test("a dream-written memory is recalled into the next turn's prompt", async () => {

  fixture.fake.reset()
  fixture.fake.push({ content: "那条记忆是做梦时写下的" })
  assert.equal((await send("做梦写下的那条记忆是什么？")).status, 202)
  const snapshot = await settle()

  const recalls = snapshot.events.filter((event) => event.type === "memory_recall") as Extract<
    SessionEvent,
    { type: "memory_recall" }
  >[]
  const last = recalls.at(-1)
  assert.ok(last, "the turn recorded a recall")
  assert.ok(last.data.memoryIds.length > 0, `expected recalled ids, got ${JSON.stringify(last.data)}`)

  const request = fixture.fake.bodies.at(-1)
  assert.ok(request, "the fake model saw the request")
  const system = request.messages.find((message) => message.role === "system")?.content ?? ""
  assert.match(system, /Recalled memory:/, system)
  assert.match(system, /做梦写下的记忆/, "the dream-written memory reaches the model")
})

test("restarting ctrl finds the same log, memory, workspace and jobs", async () => {
  const beforeRestart = await eventsStream("?since=0")
  const lastSeq = beforeRestart.events.at(-1)?.seq
  assert.equal(typeof lastSeq, "number")

  await fixture.running.close()
  fixture.running = await startCtrl({
    baseUrl: fixture.fake.url,
    root: fixture.root,
    workspace: fixture.workspace,
    piBin: fixture.piBin,
  })

  const detail = await api("GET", "/api/agent")
  assert.equal(detail.status, 200, detail.text)
  assert.equal(detail.json.agent, AGENT)
  assert.equal(detail.json.session.eventCount, beforeRestart.total, "the log survived")
  assert.equal(detail.json.session.model, "fake-model", "the model is the one the log recorded")
  assert.equal(detail.json.session.cwd, fixture.workspace, "the workspace is remembered in ctrl.json")
  assert.deepEqual(detail.json.resumePoint, { kind: "clean" })
  assert.equal(detail.json.turn.running, false, "a restart is not a running turn")

  const jobs = await api("GET", "/api/jobs")
  assert.equal(jobs.status, 200, jobs.text)
  const job = (jobs.json.jobs as Record<string, any>[]).find((candidate) => candidate.id === delegatedJob)
  assert.ok(job, "the job directory survived the restart")
  assert.equal(job.state, "exited")
  assert.equal(job.code, 0)

  fixture.fake.reset()
  fixture.fake.push({ content: "still here" })
  assert.equal((await send("are you there?")).status, 202)
  const snapshot = await settle()
  assert.ok(snapshot.total > beforeRestart.total)
  const last = snapshot.events.at(-1) as Extract<SessionEvent, { type: "assistant_message" }> | undefined
  assert.equal(last?.type, "assistant_message")
  assert.equal(last?.data.text, "still here")
  snapshot.events.forEach((event, index) => assert.equal(event.seq, index))

  const memories = await api("GET", "/api/memory")
  assert.equal(memories.status, 200)

  const search = await api("GET", "/api/search?q=counting")
  assert.equal(search.status, 200, search.text)
  assert.ok(search.json.count >= 1, "the mirror outlives the process")
  const stillHere = await api("GET", `/api/search?q=${encodeURIComponent("still here")}`)
  assert.equal(stillHere.status, 200, stillHere.text)
  assert.ok(stillHere.json.count >= 1, "the turn after the restart is indexed too")
})

test("a worker that outlives its turn wakes the agent, and the stream shows it (B)", async () => {

  const root = await mkdtemp(path.join(tmpdir(), "ctrl-e2e-wake-root-"))
  const workspace = await mkdtemp(path.join(tmpdir(), "ctrl-e2e-wake-work-"))
  const binDir = await mkdtemp(path.join(tmpdir(), "ctrl-e2e-wake-bin-"))
  const piBin = path.join(binDir, "pi")
  await writeFile(piBin, "#!/bin/sh\nsleep 1.2\nprintf 'late result\\n'\nexit 0\n", { mode: 0o755 })
  const isolated = await startCtrl({ baseUrl: fixture.fake.url, root, workspace, piBin })

  const stream = async (): Promise<Stream> => {
    const reply = await request(isolated.port, "GET", "/api/agent/events?since=0")
    assert.equal(reply.status, 200, reply.text)
    return reply.json as Stream
  }

  try {
    fixture.fake.reset()

    fixture.fake.push({ toolCalls: [{ name: "delegate", arguments: { task: "count slowly", wait: 0 } }] })
    fixture.fake.push({ content: "the worker is counting" })
    fixture.fake.push({ content: "the worker finished counting" })

    const sent = await request(isolated.port, "POST", "/api/agent/messages", { text: "count the files, slowly" })
    assert.equal(sent.status, 202, sent.text)

    const userMessages = (snapshot: Stream): string[] =>
      snapshot.events
        .filter((event) => event.type === "user_message")
        .map((event) => (event as Extract<SessionEvent, { type: "user_message" }>).data.text)

    const deadline = Date.now() + 10_000
    let snapshot = await stream()
    let wake: Extract<SessionEvent, { type: "user_message" }> | undefined
    for (;;) {
      wake = snapshot.events.find(
        (event): event is Extract<SessionEvent, { type: "user_message" }> =>
          event.type === "user_message" && event.data.text.startsWith("[ctrl] worker "),
      )
      if (wake !== undefined && !snapshot.turn.running) break
      if (Date.now() > deadline) {
        throw new Error(`no [ctrl] wake message in the stream: ${JSON.stringify(userMessages(snapshot))}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
      snapshot = await stream()
    }

    assert.match(wake.data.text, /^\[ctrl\] worker \d{8}T\d{6}Z-[a-z0-9]{6} finished \(exited, \d+\.\ds\) — report the result to the user\.$/)
    const jobId = /\[ctrl\] worker (\S+) finished/.exec(wake.data.text)?.[1] as string
    assert.ok(jobId.length > 0)

    const answer = snapshot.events.find(
      (event): event is Extract<SessionEvent, { type: "assistant_message" }> =>
        event.type === "assistant_message" && event.seq > wake.seq,
    )
    assert.equal(answer?.data.text, "the worker finished counting")
    assert.deepEqual(userMessages(snapshot).filter((text) => text.startsWith("[ctrl]")), [wake.data.text], "one wake per job")

    const types = new Set(snapshot.events.map((event) => event.type))
    for (const type of types) {
      assert.ok(
        ["session_created", "user_message", "assistant_message", "assistant_pending", "tool_call", "tool_result", "memory_recall", "error", "compaction"].includes(type),
        `unexpected event type ${type}`,
      )
    }

    const jobs = await request(isolated.port, "GET", "/api/jobs")
    const job = (jobs.json.jobs as Record<string, any>[]).find((candidate) => candidate.id === jobId)
    assert.equal(job?.state, "exited", "the wake is about a worker that really finished")
    assert.match(String(job?.output ?? ""), /late result/)
  } finally {
    await isolated.close()
    await rm(root, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
    await rm(binDir, { recursive: true, force: true })
  }
})

test("a model failure is logged once, by the engine, not twice", async () => {

  const dead = await startFakeLlm()
  const deadUrl = dead.url
  await dead.close()

  const isolated = await startFixture(deadUrl)
  try {
    const started = await request(isolated.running.port, "POST", "/api/agent/messages", { text: "hello?" })
    assert.equal(started.status, 202)

    let snapshot: Stream | undefined
    const deadline = Date.now() + 15_000
    for (;;) {
      const reply = await request(isolated.running.port, "GET", "/api/agent/events?since=0")
      assert.equal(reply.status, 200, reply.text)
      snapshot = reply.json as Stream
      if (!snapshot.turn.running) break
      if (Date.now() > deadline) throw new Error("the failing turn never settled")
      await new Promise((resolve) => setTimeout(resolve, 50))
    }

    const errors = (snapshot?.events ?? []).filter((event) => event.type === "error") as Extract<
      SessionEvent,
      { type: "error" }
    >[]
    assert.equal(errors.length, 1, `the engine logs the failure exactly once, got ${errors.length}`)
    assert.equal(errors[0]?.data.fatal, true)
    assert.match(errors[0]?.data.message ?? "", /LLM request failed/)

    assert.equal(snapshot?.turn.error, undefined)
  } finally {
    await isolated.running.close()
    await rm(isolated.root, { recursive: true, force: true })
    await rm(isolated.workspace, { recursive: true, force: true })
  }
})

test("the sessions API is gone, and nothing replaces it with a roster", async () => {

  assert.equal((await api("GET", "/api/sessions")).status, 404)
  assert.equal((await api("POST", "/api/sessions", { cwd: fixture.workspace })).status, 404)
  assert.equal((await api("GET", "/api/sessions/main")).status, 404)
  assert.equal((await api("GET", "/api/sessions/main/events?since=0")).status, 404)
  assert.equal((await api("POST", "/api/sessions/main/messages", { text: "hi" })).status, 404)
  assert.equal((await api("GET", "/api/agents")).status, 404)

  assert.equal((await api("GET", "/api/agent/events/extra")).status, 404)
  assert.equal((await api("GET", "/api/agent/nope")).status, 404)
  assert.equal((await api("GET", "/api/agent/../sessions")).status, 404)
})

test("a request body over the limit is refused before it is parsed", async () => {
  const reply = await api("POST", "/api/agent/messages", { text: "x".repeat(1_100_000) })
  assert.equal(reply.status, 413, reply.text)
})

test("an empty message is refused, and there is no machine to describe", async () => {
  const empty = await api("POST", "/api/agent/messages", { text: "   " })
  assert.equal(empty.status, 400, empty.text)

  assert.equal((await api("GET", "/api/machines")).status, 404)

  assert.equal((await api("POST", "/api/jobs", {})).status, 405)
})

test("the page is served, and only from the public directory", async () => {
  const index = await api("GET", "/")

  assert.ok(index.status === 200 || index.status === 404, `unexpected ${index.status}`)
  if (index.status === 200) assert.match(String(index.headers["content-type"]), /text\/html/)

  const script = await api("GET", "/app.js")
  assert.ok(script.status === 200 || script.status === 404)
  if (script.status === 200) assert.match(String(script.headers["content-type"]), /javascript/)

  assert.equal((await api("GET", "/no-such-file.js")).status, 404)

  const escape = await api("GET", "/%2e%2e/package.json")
  assert.ok(escape.status === 403 || escape.status === 404, `traversal must not be served (got ${escape.status})`)
  assert.ok(!escape.text.includes("\"name\": \"pi-ctrl\""))

  assert.equal((await api("GET", "/api/nope")).status, 404)
})

test("a screenshot travels as a marker in the log and as content parts on the wire", async () => {
  const uploaded = await uploadImage(PNG_1X1, "image/png")
  assert.equal(uploaded.status, 200, uploaded.text)
  const file = String(uploaded.json.path)
  assert.ok(file.startsWith(path.join(fixture.root, "agents", AGENT, "media")))

  fixture.fake.reset()
  fixture.fake.push({ content: "这是一张 1x1 的白色 PNG" })

  const sent = await send(`这是什么图？[image:${file}]`)
  assert.equal(sent.status, 202, sent.text)
  const snapshot = await settle()

  const userMessages = snapshot.events.filter(
    (event): event is Extract<SessionEvent, { type: "user_message" }> => event.type === "user_message",
  )
  assert.equal(userMessages.at(-1)?.data.text, `这是什么图？[image:${file}]`, "the log stays text")

  const body = fixture.fake.bodies.at(-1) as { messages: Array<{ role: string; content: unknown }> } | undefined
  const marked = body?.messages.find((message) => message.role === "user" && Array.isArray(message.content))
  assert.ok(marked, "the model must receive parts, not the raw marker")
  assert.deepEqual(marked.content, [
    { type: "text", text: "这是什么图？" },
    { type: "image_url", image_url: { url: `data:image/png;base64,${PNG_1X1.toString("base64")}` } },
  ])

  const replies = snapshot.events.filter(
    (event): event is Extract<SessionEvent, { type: "assistant_message" }> => event.type === "assistant_message",
  )
  assert.equal(replies.at(-1)?.data.text, "这是一张 1x1 的白色 PNG")

  const preview = await api("GET", `/media/${encodeURIComponent(path.basename(file))}`)
  assert.equal(preview.status, 200, preview.text)
  assert.equal(preview.headers["content-type"], "image/png")
})

test("view_image attaches a file to the log, and refuses a path outside its reach", async () => {
  const uploaded = await uploadImage(PNG_1X1, "image/png")
  assert.equal(uploaded.status, 200, uploaded.text)
  const file = String(uploaded.json.path)

  fixture.fake.reset()
  fixture.fake.push({ toolCalls: [{ name: "view_image", arguments: { path: file } }] })
  fixture.fake.push({ content: "看到了：一张 1x1 的图" })

  const sent = await send("把那张图看一遍")
  assert.equal(sent.status, 202, sent.text)
  const snapshot = await settle()

  const results = snapshot.events.filter(
    (event): event is Extract<SessionEvent, { type: "tool_result" }> => event.type === "tool_result",
  )
  const result = results.at(-1)
  assert.equal(result?.data.name, "view_image")
  assert.equal(result?.data.ok, true)
  assert.equal(result?.data.output, `attached ${file} — you will see it on the next step`)

  const attached = snapshot.events.filter(
    (event) => event.type === "user_message" && event.data.text === `[image:${file}]`,
  )
  assert.equal(attached.length, 1, "the tool appends exactly one marker message")
  assert.ok((attached[0]?.seq ?? 0) > (result?.seq ?? 0), "the attachment lands after the tool result")

  const body = fixture.fake.bodies.at(-1) as { messages: Array<{ role: string; content: unknown }> } | undefined
  const parts = (body?.messages ?? []).filter((message) => message.role === "user" && Array.isArray(message.content))
  assert.deepEqual(parts.at(-1)?.content, [
    { type: "image_url", image_url: { url: `data:image/png;base64,${PNG_1X1.toString("base64")}` } },
  ])

  fixture.fake.reset()
  fixture.fake.push({ toolCalls: [{ name: "view_image", arguments: { path: "/etc/passwd" } }] })
  fixture.fake.push({ content: "那张看不了" })
  const refused = await send("看看 /etc/passwd")
  assert.equal(refused.status, 202, refused.text)
  const second = await settle()
  const refusedResults = second.events.filter(
    (event): event is Extract<SessionEvent, { type: "tool_result" }> => event.type === "tool_result",
  )
  assert.equal(refusedResults.at(-1)?.data.ok, false)
  assert.match(JSON.stringify(refusedResults.at(-1)?.data.output), /must live under/)
  assert.equal(
    second.events.filter((event) => event.type === "user_message" && event.data.text === "[image:/etc/passwd]").length,
    0,
  )
})
