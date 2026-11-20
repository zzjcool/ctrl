// End-to-end: a fake LLM, a real ctrl server, a real local executor.
//
// No real network: the "model" is a scripted OpenAI-compatible HTTP server on
// 127.0.0.1 (the same trick pi-durable's tests/e2e/fake-llm-server.ts uses), so
// the whole path — HTTP route → TurnRegistry → runAgent → tools → events — is
// exercised for real.

import assert from "node:assert/strict"
import { createServer, request as httpRequest } from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtemp, readFile, rm } from "node:fs/promises"
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

interface Fixture {
  running: RunningServer
  fake: FakeLlm
  home: string
  workspace: string
}

let fixture: Fixture

async function startFixture(baseUrl: string): Promise<Fixture> {
  const home = await mkdtemp(path.join(tmpdir(), "ctrl-e2e-home-"))
  const workspace = await mkdtemp(path.join(tmpdir(), "ctrl-e2e-work-"))
  const running = await startServer({
    home,
    workspace,
    port: 0,
    host: "127.0.0.1",
    machine: "local",
    allowBash: true,
    maxSteps: 6,
    env: {
      ...process.env,
      PI_DURABLE_API_KEY: "test-key",
      PI_DURABLE_BASE_URL: baseUrl,
      PI_DURABLE_MODEL: "fake-model",
    },
  })
  return { running, fake: undefined as unknown as FakeLlm, home, workspace }
}

before(async () => {
  const fake = await startFakeLlm()
  const started = await startFixture(fake.url)
  fixture = { ...started, fake }
})

after(async () => {
  await fixture.running.close()
  await fixture.fake.close()
  await rm(fixture.home, { recursive: true, force: true })
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

async function eventsOf(sessionId: string, since = 0): Promise<Stream> {
  const reply = await api("GET", `/api/sessions/${sessionId}/events?since=${since}`)
  assert.equal(reply.status, 200, reply.text)
  return reply.json as Stream
}

/** Poll the stream until the turn is done (a turn is started, not awaited). */
async function settle(sessionId: string, timeoutMs = 8000): Promise<Stream> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const snapshot = await eventsOf(sessionId)
    if (!snapshot.turn.running) return snapshot
    if (Date.now() > deadline) throw new Error("turn did not finish in time")
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

async function newSession(): Promise<string> {
  const reply = await api("POST", "/api/sessions", { cwd: fixture.workspace })
  assert.equal(reply.status, 201, reply.text)
  assert.equal(reply.json.session.remoteCwd, fixture.workspace)
  assert.equal(reply.json.session.machine, "local")
  return reply.json.session.sessionId as string
}

// ---------------------------------------------------------------------------
// Tests — one narrative, in order; the state IS the conversation
// ---------------------------------------------------------------------------

test("health and machines describe the one machine", async () => {
  const health = await api("GET", "/api/health")
  assert.equal(health.status, 200)
  assert.deepEqual(health.json, { status: "ok", machine: "local", kind: "local" })

  const machines = await api("GET", "/api/machines")
  assert.equal(machines.status, 200)
  const current = machines.json.machines.filter((machine: { current: boolean }) => machine.current)
  assert.equal(current.length, 1)
  assert.equal(current[0].name, "local")
  assert.equal(current[0].kind, "local")
})

test("a turn runs tools and the event stream carries the card data", async () => {
  const sessionId = await newSession()
  const target = path.join(fixture.workspace, "hello.txt")
  fixture.fake.reset()

  fixture.fake.push({ toolCalls: [{ name: "write_file", arguments: { path: target, content: "hello" } }] })
  fixture.fake.push({ toolCalls: [{ name: "bash", arguments: { command: "cat hello.txt" } }] })
  fixture.fake.push({ content: "wrote and read hello.txt" })

  const created = await api("POST", `/api/sessions/${sessionId}/messages`, { text: "make hello.txt" })
  assert.equal(created.status, 202, created.text)
  assert.equal(created.json.accepted, true)
  assert.equal(created.json.turn.running, true)

  const snapshot = await settle(sessionId)
  const events = snapshot.events

  // The file really landed, in the directory the session is bound to.
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

  // The card the page draws: same callId, a name, an ok flag and output.
  assert.equal(results[0]?.data.callId, calls[0]?.data.callId)
  assert.equal(results[0]?.data.name, "write_file")
  assert.equal(results[1]?.data.name, "bash")
  assert.equal(results[1]?.data.output.trim(), "hello")

  const final = events.filter((event) => event.type === "assistant_message").at(-1) as
    | Extract<SessionEvent, { type: "assistant_message" }>
    | undefined
  assert.equal(final?.data.text, "wrote and read hello.txt")

  // seq is dense and 0-based: the array index IS the seq.
  events.forEach((event, index) => assert.equal(event.seq, index))

  // …and the whole log is retrievable in one shot.
  const detail = await api("GET", `/api/sessions/${sessionId}`)
  assert.equal(detail.status, 200)
  assert.equal(detail.json.session.sessionId, sessionId)
  assert.equal(detail.json.session.remoteCwd, fixture.workspace)
  assert.equal(detail.json.events.length, events.length)
  assert.equal(detail.json.turn.running, false)
  assert.deepEqual(detail.json.resumePoint, { kind: "clean" })

  // The stream is a tail: `since` slices it without losing the total.
  const tail = await eventsOf(sessionId, 3)
  assert.equal(tail.total, events.length)
  assert.equal(tail.since, 3)
  assert.equal(tail.events.length, events.length - 3)
  assert.equal(tail.events[0]?.seq, 3)
})

test("a second turn while one is running is 409", async () => {
  const sessionId = await newSession()
  fixture.fake.reset()
  fixture.fake.push({ content: "slow answer", delayMs: 400 })

  const first = await api("POST", `/api/sessions/${sessionId}/messages`, { text: "slow" })
  assert.equal(first.status, 202)

  const second = await api("POST", `/api/sessions/${sessionId}/messages`, { text: "me too" })
  assert.equal(second.status, 409, second.text)
  assert.match(second.json.error, /already running/)

  const snapshot = await settle(sessionId)
  assert.equal(snapshot.turn.running, false)
  // The rejected message never entered the log.
  const texts = (snapshot.events.filter((event) => event.type === "user_message") as Extract<
    SessionEvent,
    { type: "user_message" }
  >[]).map((event) => event.data.text)
  assert.deepEqual(texts, ["slow"])
})

test("abort stops the turn and says so in the log", async () => {
  const sessionId = await newSession()
  fixture.fake.reset()
  // Longer than this test is willing to wait, so the assertions below can only
  // pass through the abort path.
  fixture.fake.push({ content: "never arrives", delayMs: 10_000 })

  const started = await api("POST", `/api/sessions/${sessionId}/messages`, { text: "hang" })
  assert.equal(started.status, 202)

  const begun = Date.now()
  const aborted = await api("POST", `/api/sessions/${sessionId}/abort`)
  assert.equal(aborted.status, 200)
  assert.equal(aborted.json.aborted, true)

  const snapshot = await settle(sessionId, 4000)
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

  // Aborting an idle session is a no-op, not a failure.
  const again = await api("POST", `/api/sessions/${sessionId}/abort`)
  assert.equal(again.status, 200)
  assert.equal(again.json.aborted, false)

  // A new turn is allowed after an abort.
  fixture.fake.reset()
  fixture.fake.push({ content: "back in business" })
  const resumed = await api("POST", `/api/sessions/${sessionId}/messages`, { text: "again" })
  assert.equal(resumed.status, 202)
  const after = await settle(sessionId)
  assert.equal(after.turn.aborted, undefined)
  assert.equal(after.turn.error, undefined)
})

test("a model failure is logged once, by the engine, not twice", async () => {
  // A closed port: the client retries and then throws. Nothing to do with the
  // shared fake, so this test gets its own isolated ctrl.
  const dead = await startFakeLlm()
  const deadUrl = dead.url
  await dead.close()

  const isolated = await startFixture(deadUrl)
  try {
    const created = await request(isolated.running.port, "POST", "/api/sessions", { cwd: isolated.workspace })
    assert.equal(created.status, 201, created.text)
    const sessionId = created.json.session.sessionId as string

    const started = await request(isolated.running.port, "POST", `/api/sessions/${sessionId}/messages`, {
      text: "hello?",
    })
    assert.equal(started.status, 202)

    let snapshot: Stream | undefined
    const deadline = Date.now() + 15_000
    for (;;) {
      const reply = await request(isolated.running.port, "GET", `/api/sessions/${sessionId}/events?since=0`)
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
    await rm(isolated.home, { recursive: true, force: true })
    await rm(isolated.workspace, { recursive: true, force: true })
  }
})

test("sessions are listed newest first, with a title", async () => {
  const list = await api("GET", "/api/sessions")
  assert.equal(list.status, 200)
  assert.ok(Array.isArray(list.json.sessions))
  assert.ok(list.json.sessions.length >= 1)
  assert.ok(list.json.sessions.length <= 30)
  const titled = list.json.sessions.find(
    (session: { title: string; sessionId: string }) => session.title !== session.sessionId,
  )
  assert.ok(titled, "at least one session carries its first message as the title")
})

test("memory has tombstone semantics", async () => {
  const created = await api("POST", "/api/memory", { kind: "fact", text: "Go lives on the build box", tags: ["build"] })
  assert.equal(created.status, 201, created.text)
  const id = created.json.memory.id as string
  assert.equal(created.json.memory.kind, "fact")

  const listed = await api("GET", "/api/memory")
  assert.equal(listed.status, 200)
  assert.ok(listed.json.memories.some((entry: { id: string }) => entry.id === id))

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

test("a request body over the limit is refused before it is parsed", async () => {
  const reply = await api("POST", "/api/sessions", { cwd: "x".repeat(1_100_000) })
  assert.equal(reply.status, 413, reply.text)
})

test("unknown session ids are 404, malformed ones 400", async () => {
  assert.equal((await api("GET", "/api/sessions/20260101T000000Z-nosuchid")).status, 404)
  assert.equal((await api("GET", "/api/sessions/..%2fetc")).status, 400)
})
