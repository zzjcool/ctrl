import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, test } from "node:test"
import type { LlmClient, LlmCompleteRequest, LlmResponse, SessionEvent } from "../../src/engine/durable.ts"
import { memoryDbPath, openMemoryDb, readMeta } from "../../src/memory/db.ts"
import { HEARTBEAT_PREFIX, heartbeatCounterKey, heartbeatDate } from "../../src/server/heartbeat.ts"
import { startServer, type RunningServer } from "../../src/server/server.ts"

interface ScriptedLlm {
  client: LlmClient
  calls: LlmCompleteRequest[]
}

function scriptedLlm(replies: string[]): ScriptedLlm {
  const queue = [...replies]
  const calls: LlmCompleteRequest[] = []
  return {
    calls,
    client: {
      model: "fake-model",
      async complete(request: LlmCompleteRequest): Promise<LlmResponse> {
        calls.push(request)
        return {
          text: queue.shift() ?? "(nothing to do)",
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          finishReason: "stop",
        }
      },
    },
  }
}

interface Fixture {
  running: RunningServer
  llm: ScriptedLlm
  root: string
  workspace: string
}

const scratch: string[] = []

async function scratchDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix))
  scratch.push(dir)
  return dir
}

async function startCtrl(root: string, workspace: string, llm: ScriptedLlm): Promise<Fixture> {
  const running = await startServer({
    root,
    agent: "heartbeat",
    workspace,
    port: 0,
    host: "127.0.0.1",
    model: "fake-model",
    maxSteps: 4,
    dream: false,
    heartbeatIdleMinutes: 0.001,
    heartbeatMaxPerDay: 1,
    createLlm: () => llm.client,
  })
  return { running, llm, root, workspace }
}

interface Stream {
  events: SessionEvent[]
  total: number
  since: number
  turn: { running: boolean }
}

async function api(fixture: Fixture, method: string, requestPath: string, body?: unknown): Promise<{ status: number; json: any }> {
  const response = await fetch(`${fixture.running.url}${requestPath}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  })
  const text = await response.text()
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    json = undefined
  }
  return { status: response.status, json }
}

async function events(fixture: Fixture): Promise<Stream> {
  const reply = await api(fixture, "GET", "/api/agent/events?since=0")
  assert.equal(reply.status, 200, JSON.stringify(reply.json))
  return reply.json as Stream
}

function userMessages(snapshot: Stream): string[] {
  return snapshot.events
    .filter((event): event is Extract<SessionEvent, { type: "user_message" }> => event.type === "user_message")
    .map((event) => event.data.text)
}

async function waitFor(
  read: () => Promise<Stream>,
  done: (snapshot: Stream) => boolean,
  label: string,
  timeoutMs = 10_000,
): Promise<Stream> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const snapshot = await read()
    if (done(snapshot)) return snapshot
    if (Date.now() > deadline) throw new Error(`${label} (last: ${JSON.stringify(snapshot.events.slice(-3))})`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

function counterIn(agentHome: string, date: string): string | undefined {
  const db = openMemoryDb(memoryDbPath(agentHome))
  try {
    return readMeta(db, heartbeatCounterKey(date))
  } finally {
    db.close()
  }
}

async function seedFocus(fixture: Fixture, text: string): Promise<void> {
  const reply = await api(fixture, "POST", "/api/focus", { text })
  assert.equal(reply.status, 200, JSON.stringify(reply.json))
}

test("an idle heartbeat lands in /api/agent/events under the [ctrl] heartbeat prefix, once a day", async () => {
  const root = await scratchDir("ctrl-heartbeat-root-")
  const workspace = await scratchDir("ctrl-heartbeat-work-")
  const llm = scriptedLlm(["nothing here is worth pushing today"])
  const fixture = await startCtrl(root, workspace, llm)
  try {
    await seedFocus(fixture, "contract heartbeat focus")
    await new Promise((resolve) => setTimeout(resolve, 250))

    assert.equal(fixture.running.ctx.heartbeat.tick(), true, "the idle clock and the open focus should let one heartbeat through")

    const settled = await waitFor(
      () => events(fixture),
      (snapshot) =>
        !snapshot.turn.running && userMessages(snapshot).some((text) => text.startsWith(HEARTBEAT_PREFIX)),
      "no heartbeat turn reached /api/agent/events",
    )
    const text = userMessages(settled).find((candidate) => candidate.startsWith(HEARTBEAT_PREFIX)) as string
    assert.match(text, /contract heartbeat focus/)
    assert.match(text, /proposals waiting for approval: 0\./)

    const date = heartbeatDate(Date.now())
    assert.equal(counterIn(fixture.running.ctx.agentHome, date), "1")
    assert.equal(fixture.running.ctx.heartbeat.tick(), false, "maxPerDay 1 is already spent")
    assert.equal(llm.calls.length, 1)

    await fixture.running.close()

    const again = await startCtrl(root, workspace, scriptedLlm(["nothing to do"]))
    try {
      await new Promise((resolve) => setTimeout(resolve, 250))
      assert.equal(again.running.ctx.heartbeat.tick(), false, "the day's counter survived the restart")
      assert.equal(counterIn(again.running.ctx.agentHome, date), "1")
      assert.deepEqual(
        userMessages(await events(again)).filter((candidate) => candidate.startsWith(HEARTBEAT_PREFIX)).length,
        1,
      )
    } finally {
      await again.running.close()
    }
  } finally {
    if (fixture.running.server.listening) await fixture.running.close()
  }
})

test("a spent heartbeat is not started again while a turn is running", async () => {
  const root = await scratchDir("ctrl-heartbeat-root-")
  const workspace = await scratchDir("ctrl-heartbeat-work-")
  const fixture = await startCtrl(root, workspace, scriptedLlm(["thinking", "done"]))
  try {
    await seedFocus(fixture, "another contract focus")
    await new Promise((resolve) => setTimeout(resolve, 250))
    assert.equal(fixture.running.ctx.heartbeat.tick(), true)
    assert.equal(fixture.running.ctx.heartbeat.tick(), false)
    const settled = await waitFor(
      () => events(fixture),
      (snapshot) => !snapshot.turn.running,
      "the heartbeat turn never settled",
    )
    assert.equal(userMessages(settled).filter((text) => text.startsWith(HEARTBEAT_PREFIX)).length, 1)
  } finally {
    await fixture.running.close()
  }
})

after(async () => {
  for (const dir of scratch) await rm(dir, { recursive: true, force: true })
})
