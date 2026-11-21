import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, test } from "node:test"
import type { LlmClient, LlmCompleteRequest, LlmResponse, SessionEvent } from "../../src/engine/durable.ts"
import { memoryDbPath, openMemoryDb, readMeta } from "../../src/memory/db.ts"
import { HEARTBEAT_PREFIX, STALE_FOCUS_INSTRUCTION, STALE_FOCUS_OPTIONS, heartbeatCounterKey, heartbeatDate } from "../../src/server/heartbeat.ts"
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
  const reply = await api(fixture, "POST", "/api/focus", { text, accept: `${text} 做完的标准` })
  assert.equal(reply.status, 200, JSON.stringify(reply.json))
  assert.equal(reply.json?.item?.accept, `${text} 做完的标准`)
}

function ageFocus(fixture: Fixture, text: string, days: number): void {
  const db = openMemoryDb(memoryDbPath(fixture.running.ctx.agentHome))
  try {
    const row = db.prepare("SELECT id FROM focus WHERE text = ?").get(text) as { id?: string } | undefined
    assert.equal(typeof row?.id, "string", `seeded focus ${text} is in the table`)
    db.prepare("UPDATE focus SET updated_at = ? WHERE id = ?").run(
      new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString(),
      row?.id as string,
    )
  } finally {
    db.close()
  }
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
    assert.equal(text.includes("proposals waiting for approval"), false, "an empty proposal list keeps the section out")
    assert.equal(text.includes(STALE_FOCUS_INSTRUCTION), false, "a focus written just now is not stale")
    assert.equal(text.includes(STALE_FOCUS_OPTIONS), false, "no stale rows, no per-row options")

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

test("a stale focus is named row by row, oldest first, and the fresh one stays in the plain list", async () => {
  const root = await scratchDir("ctrl-heartbeat-root-")
  const workspace = await scratchDir("ctrl-heartbeat-work-")
  const fixture = await startCtrl(root, workspace, scriptedLlm(["nothing to do"]))
  try {
    await seedFocus(fixture, "陈旧 focus 甲")
    await seedFocus(fixture, "陈旧 focus 乙")
    await seedFocus(fixture, "新鲜 focus")
    ageFocus(fixture, "陈旧 focus 甲", 5)
    ageFocus(fixture, "陈旧 focus 乙", 4)
    await new Promise((resolve) => setTimeout(resolve, 250))

    assert.equal(fixture.running.ctx.heartbeat.tick(), true)
    const settled = await waitFor(
      () => events(fixture),
      (snapshot) =>
        !snapshot.turn.running && userMessages(snapshot).some((text) => text.startsWith(HEARTBEAT_PREFIX)),
      "no heartbeat turn reached /api/agent/events",
    )
    const text = userMessages(settled).find((candidate) => candidate.startsWith(HEARTBEAT_PREFIX)) as string
    const lines = text.split("\n")

    assert.ok(lines.includes(STALE_FOCUS_INSTRUCTION), text)
    const olderAt = lines.findIndex((line) => line.startsWith("- [stale 5d] open ") && line.includes("陈旧 focus 甲"))
    const newerAt = lines.findIndex((line) => line.startsWith("- [stale 4d] open ") && line.includes("陈旧 focus 乙"))
    assert.ok(olderAt > 0, text)
    assert.ok(newerAt > olderAt, `the older row comes first: ${text}`)
    assert.equal(lines[olderAt + 1], STALE_FOCUS_OPTIONS)
    assert.equal(lines[newerAt + 1], STALE_FOCUS_OPTIONS)
    assert.equal(lines.filter((line) => line === STALE_FOCUS_OPTIONS).length, 2, "one option line per stale row")
    assert.equal(
      lines.some((line) => line.startsWith("- [stale") && line.includes("新鲜 focus")),
      false,
      "a fresh row is not named stale",
    )
    assert.ok(lines.includes("- 新鲜 focus"), text)
  } finally {
    await fixture.running.close()
  }
})

after(async () => {
  for (const dir of scratch) await rm(dir, { recursive: true, force: true })
})