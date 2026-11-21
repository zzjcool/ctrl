import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, test } from "node:test"
import type { LlmClient, LlmCompleteRequest, LlmResponse, SessionEvent } from "../../src/engine/durable.ts"
import { META_PENDING_WAKE, memoryDbPath, openMemoryDb, readMeta, writeMeta } from "../../src/memory/db.ts"
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

const scratch: string[] = []

async function scratchDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix))
  scratch.push(dir)
  return dir
}

interface Fixture {
  running: RunningServer
  llm: ScriptedLlm
}

async function boot(root: string, workspace: string, llm: ScriptedLlm): Promise<Fixture> {
  const running = await startServer({
    root,
    agent: "relay",
    workspace,
    port: 0,
    host: "127.0.0.1",
    model: "fake-model",
    maxSteps: 4,
    dream: false,
    createLlm: () => llm.client,
  })
  return { running, llm }
}

interface Stream {
  events: SessionEvent[]
  total: number
  since: number
  turn: { running: boolean }
}

async function events(fixture: Fixture): Promise<Stream> {
  const response = await fetch(`${fixture.running.url}/api/agent/events?since=0`)
  assert.equal(response.status, 200)
  return (await response.json()) as Stream
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

function pendingWake(agentHome: string): string | undefined {
  const db = openMemoryDb(memoryDbPath(agentHome))
  try {
    return readMeta(db, META_PENDING_WAKE)
  } finally {
    db.close()
  }
}

function seedPendingWake(agentHome: string, text: string): void {
  const db = openMemoryDb(memoryDbPath(agentHome))
  try {
    writeMeta(db, META_PENDING_WAKE, text)
  } finally {
    db.close()
  }
}

test("a pending wake planted before boot is delivered once and cleared", async () => {
  const root = await scratchDir("ctrl-relay-root-")
  const workspace = await scratchDir("ctrl-relay-work-")
  const text =
    "[ctrl] you applied 20261121-155859. Run the experience script and a live smoke, then report — if it regressed, fix or revert."

  const cold = await boot(root, workspace, scriptedLlm([]))
  const agentHome = cold.running.ctx.agentHome
  assert.equal(pendingWake(agentHome), undefined)
  await cold.running.close()

  seedPendingWake(agentHome, text)
  const first = await boot(root, workspace, scriptedLlm(["ran the experience script, all green"]))
  try {
    const settled = await waitFor(
      () => events(first),
      (snapshot) => !snapshot.turn.running && userMessages(snapshot).includes(text),
      "the pending wake never reached the log",
    )
    assert.equal(userMessages(settled).filter((candidate) => candidate === text).length, 1)
    assert.equal(pendingWake(agentHome), undefined, "the delivered wake is cleared")
    assert.equal(first.llm.calls.length, 1)
  } finally {
    await first.running.close()
  }

  const second = await boot(root, workspace, scriptedLlm(["nothing queued"]))
  try {
    await new Promise((resolve) => setTimeout(resolve, 250))
    const snapshot = await events(second)
    assert.equal(userMessages(snapshot).filter((candidate) => candidate === text).length, 1, "the wake is delivered once")
    assert.equal(second.llm.calls.length, 0, "the cleared meta starts no second turn")
  } finally {
    await second.running.close()
  }
})

after(async () => {
  for (const dir of scratch) await rm(dir, { recursive: true, force: true })
})
