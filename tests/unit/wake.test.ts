import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, before, test } from "node:test"
import type { LlmClient, LlmCompleteRequest, LlmResponse, SessionEvent } from "../../src/engine/durable.ts"
import { readJob, readJobMeta } from "../../src/jobs/store.ts"
import type { JobView } from "../../src/jobs/store.ts"
import { startServer, type RunningServer } from "../../src/server/server.ts"
import { WAKE_PREFIX } from "../../src/server/wake.ts"

interface ScriptedReply {
  text?: string
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>

  delayMs?: number

  hold?: Promise<void>
}

interface ScriptedLlm {
  client: LlmClient

  calls: LlmCompleteRequest[]

  remaining(): number
}

function scriptedLlm(script: ScriptedReply[]): ScriptedLlm {
  const queue = [...script]
  const calls: LlmCompleteRequest[] = []
  return {
    calls,
    remaining: () => queue.length,
    client: {
      model: "fake-model",
      async complete(request: LlmCompleteRequest): Promise<LlmResponse> {
        calls.push(request)
        const reply = queue.shift() ?? { text: "(no further script)" }
        if (reply.hold !== undefined) {
          await reply.hold
        } else if (reply.delayMs !== undefined && reply.delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, reply.delayMs))
        }
        return {
          text: reply.text ?? "",
          toolCalls: (reply.toolCalls ?? []).map((call, index) => ({
            callId: `call-${calls.length}-${index}`,
            name: call.name,
            args: call.args,
          })),
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          finishReason: reply.toolCalls === undefined ? "stop" : "tool_calls",
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
  binDir: string
  releaseWorker(): Promise<void>
}

const scratch: string[] = []

async function scratchDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix))
  scratch.push(dir)
  return dir
}

function fakePiSource(releasePath: string): string {
  return `#!/bin/sh
printf 'args: %s\\n' "$*"
while [ ! -e '${releasePath}' ]; do sleep 0.05; done
printf 'the worker did the thing\\n'
exit 0
`
}

async function startCtrl(opts: { script: ScriptedReply[] }): Promise<Fixture> {
  const root = await scratchDir("ctrl-wake-root-")
  const workspace = await scratchDir("ctrl-wake-work-")
  const binDir = await scratchDir("ctrl-wake-bin-")
  const piBin = path.join(binDir, "pi")
  const releasePath = path.join(binDir, "release")
  await writeFile(piBin, fakePiSource(releasePath), { mode: 0o755 })

  const llm = scriptedLlm(opts.script)
  const running = await startServer({
    root,
    agent: "waker",
    workspace,
    port: 0,
    host: "127.0.0.1",
    model: "fake-model",
    maxSteps: 4,
    maxWorkers: 3,
    piBin,
    piProvider: "any-endpoint",

    dream: false,
    createLlm: () => llm.client,
  })
  return { running, llm, root, workspace, binDir, releaseWorker: async () => await writeFile(releasePath, "go") }
}

let fixtures: Fixture[] = []

async function makeFixture(opts: { script: ScriptedReply[] }): Promise<Fixture> {
  const fixture = await startCtrl(opts)
  fixtures.push(fixture)
  return fixture
}

before(() => {
  fixtures = []
})

after(async () => {
  for (const fixture of fixtures) await fixture.running.close()
  for (const dir of scratch) await rm(dir, { recursive: true, force: true })
})

interface Stream {
  events: SessionEvent[]
  total: number
  since: number
  turn: { running: boolean; error?: string; aborted?: boolean }
}

async function api(fixture: Fixture, method: string, requestPath: string, body?: unknown): Promise<{ status: number; json: any }> {
  const response = await fetch(`${fixture.running.url}${requestPath}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
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

async function settle(fixture: Fixture, timeoutMs = 10_000): Promise<Stream> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const snapshot = await events(fixture)
    if (!snapshot.turn.running) return snapshot
    if (Date.now() > deadline) throw new Error("the turn never settled")
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

async function waitFor<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  label: string,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (done(value)) return value
    if (Date.now() > deadline) throw new Error(`${label} (last: ${JSON.stringify(value).slice(0, 400)})`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

function wakeLines(snapshot: Stream): string[] {
  return snapshot.events
    .filter((event) => event.type === "user_message")
    .map((event) => (event as Extract<SessionEvent, { type: "user_message" }>).data.text)
    .filter((text) => text.startsWith(WAKE_PREFIX))
}

function userTexts(snapshot: Stream): string[] {
  return snapshot.events
    .filter((event) => event.type === "user_message")
    .map((event) => (event as Extract<SessionEvent, { type: "user_message" }>).data.text)
}

function jobIdOf(snapshot: Stream): string {
  const results = snapshot.events.filter((event) => event.type === "tool_result") as Extract<
    SessionEvent,
    { type: "tool_result" }
  >[]
  const output = results.find((event) => event.data.name === "delegate")?.data.output ?? ""
  const match = /job (\d{8}T\d{6}Z-[a-z0-9]{6})/.exec(output)
  assert.ok(match, `the delegate result carries no job id: ${output}`)
  return match[1] as string
}

async function jobState(fixture: Fixture, id: string): Promise<string> {
  const reply = await api(fixture, "GET", "/api/jobs")
  assert.equal(reply.status, 200)
  const job = (reply.json.jobs as Array<Record<string, unknown>>).find((candidate) => candidate.id === id)
  assert.ok(job, `job ${id} is not in /api/jobs`)
  return String(job.state)
}

test("a worker that outlives its turn wakes the agent, once", async () => {
  const fixture = await makeFixture({
    script: [
      { toolCalls: [{ name: "delegate", args: { task: "count slowly", wait: 0 } }] },
      { text: "the worker is counting" },
      { text: "the worker finished and printed the thing" },
    ],
  })

  const sent = await api(fixture, "POST", "/api/agent/messages", { text: "count the files, slowly" })
  assert.equal(sent.status, 202, JSON.stringify(sent.json))

  const afterTurn = await settle(fixture)
  const id = jobIdOf(afterTurn)
  assert.equal(await jobState(fixture, id), "running", "the worker must still be running when the turn ends")
  assert.deepEqual(wakeLines(afterTurn), [], "a running worker has nothing to report yet")

  await fixture.releaseWorker()

  const woken = await waitFor(
    () => events(fixture),
    (snapshot) => wakeLines(snapshot).length > 0,
    "no [ctrl] wake message",
  )
  const wakeSeq = seqOfWake(woken)
  const [wakeText] = wakeLines(woken)
  assert.ok(wakeText !== undefined)

  const shape = new RegExp(
    `^${WAKE_PREFIX.replace(/[[\]]/g, "\\$&")} ${id} finished \\(exited, \\d+\\.\\ds\\) — report the result to the user\\.$`,
  )
  assert.match(wakeText, shape)

  const wakeEvent = woken.events.find((event) => event.seq === wakeSeq)
  assert.equal(
    (wakeEvent?.data as { kind?: unknown } | undefined)?.kind,
    "job",
    "the wake is tagged as job lifecycle on the way into the log",
  )

  const answered = await waitFor(
    () => events(fixture),
    (snapshot) =>
      !snapshot.turn.running &&
      snapshot.events.some((event) => event.type === "assistant_message" && event.seq > wakeSeq),
    "the wake turn never answered",
  )
  const reply = answered.events.find(
    (event): event is Extract<SessionEvent, { type: "assistant_message" }> =>
      event.type === "assistant_message" && event.seq > wakeSeq,
  )
  assert.equal(reply?.data.text, "the worker finished and printed the thing")

  const raw = await events(fixture)
  const conversation = await api(fixture, "GET", "/api/agent/events?since=0&view=conversation")
  assert.equal(conversation.status, 200, JSON.stringify(conversation.json))
  const view = conversation.json as Stream
  assert.deepEqual(wakeLines(view), [], "job lifecycle is not part of the conversation view")
  assert.ok(
    !view.events.some((event) => event.type === "user_message" && (event.data as { kind?: unknown }).kind === "job"),
    "no tagged job message reaches the session view",
  )
  assert.equal(view.total, raw.total, "the conversation view hides the entry, it does not delete the log")
  assert.equal(await jobState(fixture, id), "exited", "the job is still readable from /api/jobs")

  answered.events.forEach((event, index) => assert.equal(event.seq, index))

  const second = readJob(fixture.running.ctx.agentHome, id)
  assert.ok(second, "the job is on disk")
  const before = answered.total
  fixture.running.ctx.jobs.onExit?.(second as JobView)
  await new Promise((resolve) => setTimeout(resolve, 300))
  const after = await events(fixture)
  assert.equal(after.total, before, "a duplicate exit event appends nothing")
  assert.equal(wakeLines(after).length, 1, "the job woke the agent exactly once")

  const meta = readJobMeta(fixture.running.ctx.agentHome, id)
  assert.equal(typeof meta?.notifiedAt, "string")
  assert.equal(fixture.llm.remaining(), 0, "the script was consumed by exactly three model calls")
})

test("a worker that finishes during a turn does not start a second one", async () => {
  let releaseTurn: () => void = () => undefined
  const turnHeld = new Promise<void>((resolve) => {
    releaseTurn = resolve
  })
  const fixture = await makeFixture({
    script: [
      { toolCalls: [{ name: "delegate", args: { task: "count quickly", wait: 0 } }] },
      { text: "the worker is on it", hold: turnHeld },
    ],
  })

  assert.equal((await api(fixture, "POST", "/api/agent/messages", { text: "count the files" })).status, 202)
  const delegated = await waitFor(
    () => events(fixture),
    (snapshot) => snapshot.events.some((event) => event.type === "tool_result" && event.data.name === "delegate"),
    "the delegate never returned a job id",
  )
  const id = jobIdOf(delegated)

  await fixture.releaseWorker()
  const exitWaitStarted = Date.now()
  try {
    await waitFor(
      () => jobState(fixture, id),
      (state) => state === "exited",
      "the worker did not exit while the turn was still open",
      5_000,
    )
  } catch (error) {
    assert.fail(
      `the worker did not exit ${Date.now() - exitWaitStarted}ms after the turn was held open: ${(error as Error).message}`,
    )
  }

  const during = await events(fixture)
  assert.equal(during.turn.running, true, "the held turn is still open when the worker exits")
  assert.deepEqual(wakeLines(during), [], "the running turn polls the job itself; no wake message")
  assert.deepEqual(userTexts(during), ["count the files"], "exactly one user_message, the one the user sent")

  releaseTurn()
  const after = await settle(fixture)
  assert.equal(after.turn.running, false)
  assert.deepEqual(wakeLines(after), [], "the settled turn does not start a second one either")
  assert.deepEqual(userTexts(after), ["count the files"], "no wake message lands once the turn is over")

  assert.equal(typeof readJobMeta(fixture.running.ctx.agentHome, id)?.notifiedAt, "string")
})

function seqOfWake(snapshot: Stream): number {
  const event = snapshot.events.find(
    (candidate) => candidate.type === "user_message" && candidate.data.text.startsWith(WAKE_PREFIX),
  )
  assert.ok(event, "no [ctrl] user_message in the snapshot")
  return event.seq
}
