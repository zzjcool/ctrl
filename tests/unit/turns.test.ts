// TurnRegistry: one turn per session, an abort that reaches the model call,
// and errors that live in memory instead of the transcript (CONTRACT §8).

import assert from "node:assert/strict"
import { test } from "node:test"
import type { LlmCompleteRequest, LlmResponse } from "../../src/engine/durable.ts"
import { createAbortableLlm, TurnRegistry } from "../../src/server/turns.ts"

test("state of an unknown session is idle", () => {
  const turns = new TurnRegistry()
  assert.deepEqual(turns.state("nope"), { running: false })
  assert.equal(turns.isRunning("nope"), false)
  assert.equal(turns.abort("nope"), false)
})

test("a second turn on the same session is refused", async () => {
  const turns = new TurnRegistry()
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  assert.equal(turns.start("s1", async () => await gate), true)
  assert.equal(turns.start("s1", async () => undefined), false, "the second start must be refused → 409")
  assert.equal(turns.isRunning("s1"), true)
  const state = turns.state("s1")
  assert.equal(state.running, true)
  assert.ok(typeof state.startedAt === "string" && state.startedAt.length > 0)
  release()
  await turns.settled("s1")
  assert.equal(turns.state("s1").running, false)
})

test("two sessions can run at the same time", async () => {
  const turns = new TurnRegistry()
  assert.equal(turns.start("a", async () => undefined), true)
  assert.equal(turns.start("b", async () => undefined), true)
  await Promise.all([turns.settled("a"), turns.settled("b")])
})

test("abort reaches the signal the runner was given", async () => {
  const turns = new TurnRegistry()
  let observed: AbortSignal | undefined
  turns.start("s1", async (signal) => {
    observed = signal
    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve())
    })
  })
  assert.equal(observed?.aborted, false)
  assert.equal(turns.abort("s1"), true)
  await turns.settled("s1")
  assert.equal(observed?.aborted, true)
  assert.deepEqual(turns.state("s1"), { running: false, aborted: true })
  // Nothing is running any more, so a second abort is a no-op.
  assert.equal(turns.abort("s1"), false)
})

test("a thrown error is recorded on the turn and the slot is released", async () => {
  const turns = new TurnRegistry()
  assert.equal(turns.start("s1", async () => { throw new Error("boom") }), true)
  await turns.settled("s1")
  assert.deepEqual(turns.state("s1"), { running: false, error: "boom" })
  assert.equal(turns.isRunning("s1"), false)
  // The lock is free again: a retry is allowed.
  assert.equal(turns.start("s1", async () => undefined), true)
  await turns.settled("s1")
  // A fresh turn clears the previous error.
  assert.deepEqual(turns.state("s1"), { running: false })
})

test("shutdown aborts everything that is still running", async () => {
  const turns = new TurnRegistry()
  const aborted: string[] = []
  for (const id of ["a", "b"]) {
    turns.start(id, async (signal) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => {
          aborted.push(id)
          resolve()
        })
      })
    })
  }
  await turns.shutdown()
  assert.deepEqual(aborted.sort(), ["a", "b"])
  assert.equal(turns.isRunning("a"), false)
})

test("createAbortableLlm injects the signal and keeps the model", async () => {
  const controller = new AbortController()
  const seen: LlmCompleteRequest[] = []
  const base = {
    model: "test-model",
    async complete(req: LlmCompleteRequest): Promise<LlmResponse> {
      seen.push(req)
      return { text: "ok", toolCalls: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, finishReason: "stop" }
    },
  }
  const wrapped = createAbortableLlm(base, controller.signal)
  assert.equal(wrapped.model, "test-model")
  await wrapped.complete({ messages: [{ role: "user", content: "hi" }] })
  assert.equal(seen.length, 1)
  assert.equal(seen[0]?.signal, controller.signal)
  assert.deepEqual(seen[0]?.messages, [{ role: "user", content: "hi" }])
})
