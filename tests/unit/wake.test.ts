// Waking the agent when a worker finishes (B).
//
// A real `pi` takes minutes; the turn that delegated it ends in seconds. So the
// exit has to become an event of its own: a `[ctrl] worker …` user_message plus
// an ordinary turn. Everything here is real except the two things that must be
// fake in a test — the model (a scripted LlmClient, no HTTP) and `pi` (a shell
// script) — so the path under test is the real one: spawn → exit → runner
// callback → waker → user_message → runTurn → assistant_message.

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

// ---------------------------------------------------------------------------
// A scripted model: one reply per call, in order
// ---------------------------------------------------------------------------

interface ScriptedReply {
  text?: string
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>
  /** Hold the answer this long, so a worker can finish *during* a turn. */
  delayMs?: number
}

interface ScriptedLlm {
  client: LlmClient
  /** Every request the model saw, oldest first. */
  calls: LlmCompleteRequest[]
  /** How many scripted replies are left — a test's "nothing else happened". */
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
        if (reply.delayMs !== undefined && reply.delayMs > 0) {
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

// ---------------------------------------------------------------------------
// Fixture: a real ctrl server, a fake pi that outlives its turn
// ---------------------------------------------------------------------------

interface Fixture {
  running: RunningServer
  llm: ScriptedLlm
  root: string
  workspace: string
  binDir: string
}

const scratch: string[] = []

async function scratchDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix))
  scratch.push(dir)
  return dir
}

/** Stands in for `pi`: it names itself, sleeps, then reports. */
function fakePiSource(sleepSeconds: number): string {
  return `#!/bin/sh
printf 'args: %s\\n' "$*"
sleep ${sleepSeconds}
printf 'the worker did the thing\\n'
exit 0
`
}

async function startCtrl(opts: { sleepSeconds: number; script: ScriptedReply[] }): Promise<Fixture> {
  const root = await scratchDir("ctrl-wake-root-")
  const workspace = await scratchDir("ctrl-wake-work-")
  const binDir = await scratchDir("ctrl-wake-bin-")
  const piBin = path.join(binDir, "pi")
  await writeFile(piBin, fakePiSource(opts.sleepSeconds), { mode: 0o755 })

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
    // No background dream: this test is about worker exits, not idle memory.
    dream: false,
    createLlm: () => llm.client,
  })
  return { running, llm, root, workspace, binDir }
}

let fixtures: Fixture[] = []

async function makeFixture(opts: { sleepSeconds: number; script: ScriptedReply[] }): Promise<Fixture> {
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

// ---------------------------------------------------------------------------
// HTTP (the page's two calls, nothing more)
// ---------------------------------------------------------------------------

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

/** The user_message lines that a worker exit appended. */
function wakeLines(snapshot: Stream): string[] {
  return snapshot.events
    .filter((event) => event.type === "user_message")
    .map((event) => (event as Extract<SessionEvent, { type: "user_message" }>).data.text)
    .filter((text) => text.startsWith(WAKE_PREFIX))
}

/** The job id out of `started job <id> — poll with job_status`. */
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

// ---------------------------------------------------------------------------
// The wake
// ---------------------------------------------------------------------------

test("a worker that outlives its turn wakes the agent, once", async () => {
  const fixture = await makeFixture({
    // Longer than any turn below, so the exit can only be reported by the waker.
    sleepSeconds: 2,
    script: [
      // Turn 1: delegate without waiting, then answer and finish.
      { toolCalls: [{ name: "delegate", args: { task: "count slowly", wait: 0 } }] },
      { text: "the worker is counting" },
      // The wake turn: the model reports what happened.
      { text: "the worker finished and printed the thing" },
    ],
  })

  const sent = await api(fixture, "POST", "/api/agent/messages", { text: "count the files, slowly" })
  assert.equal(sent.status, 202, JSON.stringify(sent.json))

  // The turn ends while the worker is still running — that is the whole point.
  const afterTurn = await settle(fixture)
  const id = jobIdOf(afterTurn)
  assert.equal(await jobState(fixture, id), "running", "the worker must still be running when the turn ends")
  assert.deepEqual(wakeLines(afterTurn), [], "a running worker has nothing to report yet")

  // Now the worker exits, and the exit becomes a turn of its own.
  const woken = await waitFor(
    () => events(fixture),
    (snapshot) => wakeLines(snapshot).length > 0,
    "no [ctrl] wake message",
  )
  const wakeSeq = seqOfWake(woken)
  const [wakeText] = wakeLines(woken)
  assert.ok(wakeText !== undefined)
  // The frozen shape: [ctrl] worker <id> finished (<state>, <elapsed>) — …
  const shape = new RegExp(
    `^${WAKE_PREFIX.replace(/[[\]]/g, "\\$&")} ${id} finished \\(exited, \\d+\\.\\ds\\) — report the result to the user\\.$`,
  )
  assert.match(wakeText, shape)

  // …and it is followed by a normal assistant turn.
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

  // The wake turn is an ordinary turn: the log is still dense and 0-based.
  answered.events.forEach((event, index) => assert.equal(event.seq, index))

  // One wake per job: the same exit reported again must not append anything.
  const second = readJob(fixture.running.ctx.agentHome, id)
  assert.ok(second, "the job is on disk")
  const before = answered.total
  fixture.running.ctx.jobs.onExit?.(second as JobView)
  await new Promise((resolve) => setTimeout(resolve, 300))
  const after = await events(fixture)
  assert.equal(after.total, before, "a duplicate exit event appends nothing")
  assert.equal(wakeLines(after).length, 1, "the job woke the agent exactly once")

  // The claim is on disk, not in memory: a restart cannot wake for it again.
  const meta = readJobMeta(fixture.running.ctx.agentHome, id)
  assert.equal(typeof meta?.notifiedAt, "string")
  assert.equal(fixture.llm.remaining(), 0, "the script was consumed by exactly three model calls")
})

test("a worker that finishes during a turn does not start a second one", async () => {
  const fixture = await makeFixture({
    // Exits while the model is still answering step 2 below.
    sleepSeconds: 0.4,
    script: [
      { toolCalls: [{ name: "delegate", args: { task: "count quickly", wait: 0 } }] },
      { text: "the worker is on it", delayMs: 2_500 },
    ],
  })

  assert.equal((await api(fixture, "POST", "/api/agent/messages", { text: "count the files" })).status, 202)
  const done = await settle(fixture)
  const id = jobIdOf(done)
  assert.equal(await jobState(fixture, id), "exited", "the worker finished while the turn was still open")

  // Give a wrongly-started wake turn every chance to appear.
  await new Promise((resolve) => setTimeout(resolve, 400))
  const after = await events(fixture)
  assert.deepEqual(wakeLines(after), [], "the running turn polls the job itself; no wake message")
  assert.equal(after.turn.running, false)
  const userTexts = after.events
    .filter((event) => event.type === "user_message")
    .map((event) => (event as Extract<SessionEvent, { type: "user_message" }>).data.text)
  assert.deepEqual(userTexts, ["count the files"], "exactly one user_message, the one the user sent")
  // The wake was claimed and skipped, so it can never fire later for this job.
  assert.equal(typeof readJobMeta(fixture.running.ctx.agentHome, id)?.notifiedAt, "string")
})

/** The seq of the first `[ctrl]` user_message in a snapshot. */
function seqOfWake(snapshot: Stream): number {
  const event = snapshot.events.find(
    (candidate) => candidate.type === "user_message" && candidate.data.text.startsWith(WAKE_PREFIX),
  )
  assert.ok(event, "no [ctrl] user_message in the snapshot")
  return event.seq
}
