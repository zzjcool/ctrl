import assert from "node:assert/strict"
import { test } from "node:test"
import type { SessionEvent } from "../../src/engine/durable.ts"
import { MAX_EVENTS_PER_CALL, pageEvents } from "../../src/server/routes.ts"

function events(count: number): SessionEvent[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `e${index}`,
    seq: index,
    ts: new Date(1_700_000_000_000 + index).toISOString(),
    type: "user_message",
    data: { text: `m${index}` },
  })) as SessionEvent[]
}

function seqs(page: { events: SessionEvent[] }): number[] {
  return page.events.map((event) => event.seq)
}

test("since=N returns events from seq N, and says where it started", () => {
  const page = pageEvents(events(5), { since: "2" })
  assert.equal(page.total, 5)
  assert.equal(page.since, 2)
  assert.deepEqual(seqs(page), [2, 3, 4])
})

test("no `since` at all means the beginning", () => {
  const page = pageEvents(events(3), {})
  assert.equal(page.since, 0)
  assert.deepEqual(seqs(page), [0, 1, 2])
})

test("a poller that is already up to date gets nothing and keeps its cursor", () => {
  const page = pageEvents(events(5), { since: "5" })
  assert.deepEqual(page.events, [])
  assert.equal(page.total, 5)
  assert.equal(page.since, 5, "unchanged, so the page does not rewind")
})

test("a cursor past the end is clamped, so the page cannot ask for 999 forever", () => {
  const page = pageEvents(events(3), { since: "999" })
  assert.deepEqual(page.events, [])
  assert.equal(page.total, 3)
  assert.equal(page.since, 3)
})

test("garbage and negative since fall back to the beginning", () => {
  for (const since of ["", "abc", "-4", "null", "1.5"]) {
    const page = pageEvents(events(2), { since })
    assert.deepEqual(seqs(page), [0, 1], `since=${JSON.stringify(since)}`)
  }
  assert.deepEqual(seqs(pageEvents(events(2), { since: null })), [0, 1])
  assert.deepEqual(seqs(pageEvents(events(2), { since: 1 })), [1], "a number works too")
})

test("one call never returns more than 200 events", () => {
  const page = pageEvents(events(250), { since: "0" })
  assert.equal(page.events.length, MAX_EVENTS_PER_CALL)
  assert.equal(page.total, 250, "the total is the whole log, not the slice")
  assert.deepEqual(seqs(page), Array.from({ length: 200 }, (_, index) => index))
})

test("tail=T is the last T events, since = the seq of the first one", () => {
  const page = pageEvents(events(10), { tail: "3" })
  assert.equal(page.total, 10)
  assert.deepEqual(seqs(page), [7, 8, 9])
  assert.equal(page.since, 7)
})

test("tail larger than the log returns the whole log", () => {
  const page = pageEvents(events(4), { tail: "100" })
  assert.deepEqual(seqs(page), [0, 1, 2, 3])
  assert.equal(page.since, 0, "since 0 means there is nothing earlier to load")
})

test("a tail over 200 is capped", () => {
  const page = pageEvents(events(500), { tail: "1000" })
  assert.equal(page.events.length, MAX_EVENTS_PER_CALL)
  assert.equal(page.since, 300)
})

test("tail=0 asks for nothing instead of slice(-0) returning everything", () => {
  for (const tail of ["0", "-3"]) {
    const page = pageEvents(events(5), { tail })
    assert.deepEqual(page.events, [], `tail=${tail}`)
    assert.equal(page.since, 0)
    assert.equal(page.total, 5)
  }
})

test("before=S&tail=T is the T events just before seq S", () => {
  const page = pageEvents(events(10), { before: "7", tail: "3" })
  assert.deepEqual(seqs(page), [4, 5, 6])
  assert.equal(page.since, 4)
  assert.equal(page.total, 10)
})

test("before at the start of the log yields nothing, so the button can stop", () => {
  const page = pageEvents(events(10), { before: "0", tail: "3" })
  assert.deepEqual(page.events, [])
  assert.equal(page.since, 0)
})

test("before without a tail looks back a full page", () => {
  const page = pageEvents(events(300), { before: "300" })
  assert.equal(page.events.length, MAX_EVENTS_PER_CALL)
  assert.equal(page.since, 100)
  assert.equal(page.events.at(-1)?.seq, 299)
})

test("paging up reaches the very first event one page at a time", () => {
  const log = events(450)
  const collected: number[] = []
  let before: string | undefined = String(log.length)
  for (let guard = 0; guard < 10; guard += 1) {
    const page = pageEvents(log, { before, tail: "200" })
    collected.unshift(...seqs(page))
    if (page.since === 0) break
    before = String(page.since)
  }
  assert.deepEqual(collected, seqs({ events: log }))
})

test("priority is before > tail > since", () => {
  const withBefore = pageEvents(events(10), { before: "7", tail: "2", since: "9" })
  assert.deepEqual(seqs(withBefore), [5, 6])

  const withTail = pageEvents(events(10), { tail: "2", since: "9" })
  assert.deepEqual(seqs(withTail), [8, 9])
})

test("an empty log is not an error in any mode", () => {
  for (const query of [{}, { since: "0" }, { tail: "10" }, { before: "5", tail: "10" }]) {
    assert.deepEqual(pageEvents([], query), { events: [], total: 0, since: 0 }, JSON.stringify(query))
  }
})
