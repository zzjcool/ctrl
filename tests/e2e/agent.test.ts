// End-to-end: a fake LLM, a real ctrl server, a real local executor, one agent.
//
// No real network: the "model" is a scripted OpenAI-compatible HTTP server on
// 127.0.0.1 (the same trick pi-durable's tests/e2e/fake-llm-server.ts uses), so
// the whole path — HTTP route → TurnRegistry → runAgent → tools → events — is
// exercised for real. The identity under test is a directory: `<root>/agents/<name>`.

import assert from "node:assert/strict"
import { createServer, request as httpRequest } from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, before, test } from "node:test"
import type { SessionEvent } from "../../src/engine/durable.ts"
import { startServer, type RunningServer } from "../../src/server/server.ts"

// ---------------------------------------------------------------------------
// Scripted fake model
// ---------------------------------------------------------------------------

interface FakeToolCall {
  name: string
  arguments: Record<string, unknown>
}

interface FakeReply {
  content?: string
  toolCalls?: FakeToolCall[]
  /** Hold the response this long before answering (tests concurrency/abort). */
  delayMs?: number
}

interface FakeLlm {
  url: string
  requests: number
  push(reply: FakeReply): void
  reset(): void
  close(): Promise<void>
}

async function startFakeLlm(): Promise<FakeLlm> {
  const queue: FakeReply[] = []
  const timers = new Set<ReturnType<typeof setTimeout>>()
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
    },
    close: async () => {
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  } as FakeLlm
}

// ---------------------------------------------------------------------------
// Tiny HTTP client (no fetch: it normalises the encoded paths sent below)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const AGENT = "tester"

interface Fixture {
  running: RunningServer
  fake: FakeLlm
  root: string
  workspace: string
}

let fixture: Fixture

interface StartOptions {
  baseUrl: string
  agent?: string
  root?: string
  workspace?: string
}

async function startCtrl(opts: StartOptions): Promise<RunningServer> {
  return await startServer({
    root: opts.root,
    agent: opts.agent ?? AGENT,
    workspace: opts.workspace,
    port: 0,
    host: "127.0.0.1",
    machine: "local",
    allowBash: true,
    maxSteps: 6,
    env: {
      ...process.env,
      PI_DURABLE_API_KEY: "test-key",
      PI_DURABLE_BASE_URL: opts.baseUrl,
      PI_DURABLE_MODEL: "fake-model",
    },
  })
}

async function startFixture(baseUrl: string): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "ctrl-e2e-root-"))
  const workspace = await mkdtemp(path.join(tmpdir(), "ctrl-e2e-work-"))
  const running = await startCtrl({ baseUrl, root, workspace })
  return { running, fake: undefined as unknown as FakeLlm, root, workspace }
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

/** Poll the stream until the turn is done (a turn is started, not awaited). */
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

// ---------------------------------------------------------------------------
// Tests — one narrative, in order; the agent IS the directory
// ---------------------------------------------------------------------------

test("one agent, named on disk, with one log", async () => {
  const health = await api("GET", "/api/health")
  assert.equal(health.status, 200)
  assert.deepEqual(health.json, { status: "ok", agent: AGENT, machine: "local", kind: "local" })

  const detail = await api("GET", "/api/agent")
  assert.equal(detail.status, 200, detail.text)
  assert.equal(detail.json.agent, AGENT, "the agent is a name, not a title")
  assert.equal(detail.json.session.sessionId, "main", "the log id is always main")
  assert.equal(detail.json.session.model, "fake-model")
  assert.equal(detail.json.session.machine, "local")
  assert.equal(detail.json.session.remoteCwd, fixture.workspace)
  assert.equal(detail.json.session.eventCount, 1, "a fresh agent has exactly session_created")
  assert.deepEqual(detail.json.resumePoint, { kind: "clean" })
  assert.equal(detail.json.turn.running, false)
  assert.equal(detail.json.machine, "local")

  const home = path.join(fixture.root, "agents", AGENT)
  const agentFile = JSON.parse(await readFile(path.join(home, "agent.json"), "utf8"))
  assert.equal(agentFile.name, AGENT)
  assert.equal(agentFile.model, "fake-model")
  assert.equal(typeof agentFile.createdAt, "string")
  assert.ok((await stat(path.join(home, "sessions", "main", "events.jsonl"))).isFile())
  const sidecar = JSON.parse(await readFile(path.join(home, "sessions", "main", "ctrl.json"), "utf8"))
  assert.equal(sidecar.machine, "local")
  assert.equal(sidecar.remoteCwd, fixture.workspace)

  // Nothing pretends to be a second agent.
  assert.equal((await api("GET", "/api/agents")).status, 404)
})

test("a turn runs tools and the event stream carries the card data", async () => {
  const target = path.join(fixture.workspace, "hello.txt")
  fixture.fake.reset()

  fixture.fake.push({ toolCalls: [{ name: "write_file", arguments: { path: target, content: "hello" } }] })
  fixture.fake.push({ toolCalls: [{ name: "bash", arguments: { command: "cat hello.txt" } }] })
  fixture.fake.push({ content: "wrote and read hello.txt" })

  const created = await send("make hello.txt")
  assert.equal(created.status, 202, created.text)
  assert.equal(created.json.accepted, true)
  assert.equal(created.json.turn.running, true)

  const snapshot = await settle()
  const events = snapshot.events

  // The file really landed, in the directory the agent is bound to.
  assert.equal(await readFile(target, "utf8"), "hello")

  const types = events.map((event) => event.type)
  assert.equal(types[0], "session_created")
  assert.ok(types.includes("user_message"))
  assert.ok(types.includes("tool_call"))
  assert.ok(types.includes("tool_result"))
  assert.equal(types.filter((type) => type === "assistant_message").length, 3)

  const calls = events.filter((event) => event.type === "tool_call") as Extract<SessionEvent, { type: "tool_call" }>[]
  const results = events.filter((event) => event.type === "tool_result") as Extract<SessionEvent, { type: "tool_result" }>[]
  assert.deepEqual(calls.map((event) => event.data.name), ["write_file", "bash"])
  assert.deepEqual(results.map((event) => event.data.ok), [true, true])
  assert.equal(results[0]?.data.callId, calls[0]?.data.callId)
  assert.equal(results[1]?.data.output.trim(), "hello")

  const final = events.filter((event) => event.type === "assistant_message").at(-1) as
    | Extract<SessionEvent, { type: "assistant_message" }>
    | undefined
  assert.equal(final?.data.text, "wrote and read hello.txt")

  // seq is dense and 0-based: the array index IS the seq.
  events.forEach((event, index) => assert.equal(event.seq, index))
  assert.equal(snapshot.total, events.length)

  // The stream slices by seq, not by index.
  const tail = await eventsStream("?since=3")
  assert.equal(tail.total, events.length)
  assert.equal(tail.since, 3)
  assert.equal(tail.events.length, events.length - 3)
  assert.equal(tail.events[0]?.seq, 3)
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

  // Walking up from the newest page reaches seq 0 and stops there.
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
  // The rejected message never entered the log.
  const texts = (snapshot.events.filter((event) => event.type === "user_message") as Extract<
    SessionEvent,
    { type: "user_message" }
  >[]).map((event) => event.data.text)
  assert.deepEqual(texts, ["make hello.txt", "slow"])
})

test("abort stops the turn and says so in the log", async () => {
  fixture.fake.reset()
  // Longer than this test is willing to wait, so the assertions below can only
  // pass through the abort path.
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

  // Aborting an idle agent is a no-op, not a failure.
  const again = await api("POST", "/api/agent/abort")
  assert.equal(again.status, 200)
  assert.equal(again.json.aborted, false)

  // A new turn is allowed after an abort.
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
  // Per agent (CONTRACT §4): the memory log is inside the agent directory.
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

test("restarting ctrl finds the same log, memory and machine binding", async () => {
  const beforeRestart = await eventsStream("?since=0")
  const lastSeq = beforeRestart.events.at(-1)?.seq
  assert.equal(typeof lastSeq, "number")

  await fixture.running.close()
  fixture.running = await startCtrl({ baseUrl: fixture.fake.url, root: fixture.root, workspace: fixture.workspace })

  const detail = await api("GET", "/api/agent")
  assert.equal(detail.status, 200, detail.text)
  assert.equal(detail.json.agent, AGENT)
  assert.equal(detail.json.session.eventCount, beforeRestart.total, "the log survived")
  assert.equal(detail.json.session.model, "fake-model", "the model is the one the log recorded")
  assert.equal(detail.json.session.machine, "local", "the machine binding is in ctrl.json")
  assert.equal(detail.json.session.remoteCwd, fixture.workspace)
  assert.deepEqual(detail.json.resumePoint, { kind: "clean" })
  assert.equal(detail.json.turn.running, false, "a restart is not a running turn")

  // And it keeps writing to the same log: seq continues, nothing is renumbered.
  fixture.fake.reset()
  fixture.fake.push({ content: "still here" })
  assert.equal((await send("are you there?")).status, 202)
  const snapshot = await settle()
  assert.ok(snapshot.total > beforeRestart.total)
  const last = snapshot.events.at(-1) as Extract<SessionEvent, { type: "assistant_message" }> | undefined
  assert.equal(last?.type, "assistant_message")
  assert.equal(last?.data.text, "still here")
  snapshot.events.forEach((event, index) => assert.equal(event.seq, index))

  // Memory survived the restart too.
  const memories = await api("GET", "/api/memory")
  assert.equal(memories.status, 200)
})

test("a model failure is logged once, by the engine, not twice", async () => {
  // A closed port: the client retries and then throws. Nothing to do with the
  // shared fake, so this test gets its own isolated ctrl.
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
    // And it is not repeated in the in-memory turn state.
    assert.equal(snapshot?.turn.error, undefined)
  } finally {
    await isolated.running.close()
    await rm(isolated.root, { recursive: true, force: true })
    await rm(isolated.workspace, { recursive: true, force: true })
  }
})

test("the sessions API is gone, and nothing replaces it with a roster", async () => {
  // Every shape of the v1 surface: the list, a create, and one session's routes.
  assert.equal((await api("GET", "/api/sessions")).status, 404)
  assert.equal((await api("POST", "/api/sessions", { cwd: fixture.workspace })).status, 404)
  assert.equal((await api("GET", "/api/sessions/main")).status, 404)
  assert.equal((await api("GET", "/api/sessions/main/events?since=0")).status, 404)
  assert.equal((await api("POST", "/api/sessions/main/messages", { text: "hi" })).status, 404)
  assert.equal((await api("GET", "/api/agents")).status, 404)

  // Sub-routes of /api/agent that do not exist are 404, not a guess.
  assert.equal((await api("GET", "/api/agent/events/extra")).status, 404)
  assert.equal((await api("GET", "/api/agent/nope")).status, 404)
  assert.equal((await api("GET", "/api/agent/../sessions")).status, 404)
})

test("a request body over the limit is refused before it is parsed", async () => {
  const reply = await api("POST", "/api/agent/messages", { text: "x".repeat(1_100_000) })
  assert.equal(reply.status, 413, reply.text)
})

test("an empty message is refused, and machines describe one current machine", async () => {
  const empty = await api("POST", "/api/agent/messages", { text: "   " })
  assert.equal(empty.status, 400, empty.text)

  const machines = await api("GET", "/api/machines")
  assert.equal(machines.status, 200)
  const current = machines.json.machines.filter((machine: { current: boolean }) => machine.current)
  assert.equal(current.length, 1)
  assert.equal(current[0].name, "local")
  assert.equal(current[0].kind, "local")
})

test("the page is served, and only from the public directory", async () => {
  const index = await api("GET", "/")
  // W2 owns the page; while it is missing, a 404 is the correct answer.
  assert.ok(index.status === 200 || index.status === 404, `unexpected ${index.status}`)
  if (index.status === 200) assert.match(String(index.headers["content-type"]), /text\/html/)

  const script = await api("GET", "/app.js")
  assert.ok(script.status === 200 || script.status === 404)
  if (script.status === 200) assert.match(String(script.headers["content-type"]), /javascript/)

  assert.equal((await api("GET", "/no-such-file.js")).status, 404)

  // Encoded traversal: the URL keeps %2e%2e, the resolver must refuse it.
  const escape = await api("GET", "/%2e%2e/package.json")
  assert.ok(escape.status === 403 || escape.status === 404, `traversal must not be served (got ${escape.status})`)
  assert.ok(!escape.text.includes("\"name\": \"pi-ctrl\""))

  assert.equal((await api("GET", "/api/nope")).status, 404)
})
