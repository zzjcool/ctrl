// `since` slicing for the event stream (CONTRACT §10).
//
// `since` is an index into the event array, not a seq lookup: pi-durable
// re-numbers seq densely on replay, so the two coincide — but an out-of-range
// or garbage value must never make the page loop forever.

import assert from "node:assert/strict"
import { test } from "node:test"
import type { SessionEvent } from "../../src/engine/durable.ts"
import { sliceEvents } from "../../src/server/routes.ts"

function events(count: number): SessionEvent[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `e${index}`,
    seq: index,
    ts: new Date(1_700_000_000_000 + index).toISOString(),
    type: "user_message",
    data: { text: `m${index}` },
  })) as SessionEvent[]
}

test("no `since` returns the whole log", () => {
  const result = sliceEvents(events(3), null)
  assert.equal(result.total, 3)
  assert.equal(result.since, 0)
  assert.deepEqual(result.events.map((event) => event.seq), [0, 1, 2])
})

test("since=0 returns the whole log", () => {
  const result = sliceEvents(events(3), "0")
  assert.equal(result.since, 0)
  assert.equal(result.events.length, 3)
})

test("since in the middle returns the tail", () => {
  const result = sliceEvents(events(5), "2")
  assert.equal(result.total, 5)
  assert.equal(result.since, 2)
  assert.deepEqual(result.events.map((event) => event.seq), [2, 3, 4])
})

test("since == total returns nothing but reports the total", () => {
  const result = sliceEvents(events(3), "3")
  assert.equal(result.total, 3)
  assert.equal(result.since, 3)
  assert.deepEqual(result.events, [])
})

test("since beyond the end is clamped, so the page cannot ask for 999 forever", () => {
  const result = sliceEvents(events(3), "999")
  assert.equal(result.since, 3)
  assert.deepEqual(result.events, [])
})

test("garbage and negative values fall back to 0", () => {
  for (const raw of ["", "abc", "-4", "null"]) {
    const result = sliceEvents(events(2), raw)
    assert.equal(result.since, 0, `since=${JSON.stringify(raw)}`)
    assert.equal(result.events.length, 2)
  }
  assert.equal(sliceEvents(events(2), undefined).since, 0)
})

test("an empty log is not an error", () => {
  const result = sliceEvents([], "0")
  assert.deepEqual(result, { events: [], total: 0, since: 0 })
})

test("a numeric since (not a string) still works", () => {
  assert.equal(sliceEvents(events(4), 3).since, 3)
  assert.equal(sliceEvents(events(4), 3).events.length, 1)
})
