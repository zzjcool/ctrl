import assert from "node:assert/strict"
import { test } from "node:test"
import {
  HEARTBEAT_INSTRUCTION,
  HEARTBEAT_PREFIX,
  createHeartbeat,
  heartbeatDate,
  type HeartbeatDeps,
} from "../../src/server/heartbeat.ts"

const NOW = Date.parse("2026-03-05T12:00:00.000Z")
const MINUTE = 60_000
const TODAY = heartbeatDate(NOW)

interface Harness {
  deps: HeartbeatDeps
  starts: string[]
  counters: Map<string, number>
}

function harness(overrides: Partial<HeartbeatDeps> = {}, seed: Record<string, number> = {}): Harness {
  const starts: string[] = []
  const counters = new Map<string, number>(Object.entries(seed))
  const deps: HeartbeatDeps = {
    now: () => NOW,
    usageToday: () => ({ tokens: 0 }),
    openFocus: () => 2,
    focusTexts: () => ["ship the heartbeat", "trim the usage ledger"],
    openProposals: () => 1,
    lastEventAt: () => new Date(NOW - 90 * MINUTE).toISOString(),
    turnRunning: () => false,
    start: (text) => {
      starts.push(text)
    },
    readCounter: (date) => counters.get(date) ?? 0,
    writeCounter: (date, count) => {
      counters.set(date, count)
    },
    ...overrides,
  }
  return { deps, starts, counters }
}

function tickOnce(h: Harness, opts: { idleMinutes?: number; dailyTokenBudget?: number; maxPerDay?: number } = {}): boolean {
  const heartbeat = createHeartbeat(h.deps, { tickMs: 0, ...opts })
  try {
    return heartbeat.tick()
  } finally {
    heartbeat.stop()
  }
}

test("an idle clock under idleMinutes starts nothing", () => {
  const h = harness({ lastEventAt: () => new Date(NOW - 59 * MINUTE).toISOString() })
  assert.equal(tickOnce(h), false)
  assert.deepEqual(h.starts, [])
  assert.equal(h.counters.get(TODAY), undefined)
})

test("a last event that never happened starts nothing", () => {
  const h = harness({ lastEventAt: () => undefined })
  assert.equal(tickOnce(h), false)
  assert.deepEqual(h.starts, [])
})

test("no open focus and no open proposal starts nothing", () => {
  const h = harness({ openFocus: () => 0, focusTexts: () => [], openProposals: () => 0 })
  assert.equal(tickOnce(h), false)
  assert.deepEqual(h.starts, [])
})

test("a running turn starts nothing", () => {
  const h = harness({ turnRunning: () => true })
  assert.equal(tickOnce(h), false)
  assert.deepEqual(h.starts, [])
})

test("a spent daily token budget starts nothing, one token short still does", () => {
  const spent = harness({ usageToday: () => ({ tokens: 150_000 }) })
  assert.equal(tickOnce(spent), false)
  assert.deepEqual(spent.starts, [])

  const short = harness({ usageToday: () => ({ tokens: 149_999 }) })
  assert.equal(tickOnce(short), true)
  assert.equal(short.starts.length, 1)
})

test("the daily cap stops the heartbeat at maxPerDay", () => {
  const h = harness({}, { [TODAY]: 4 })
  assert.equal(tickOnce(h), false)
  assert.deepEqual(h.starts, [])
  assert.equal(h.counters.get(TODAY), 4)
})

test("an idle heartbeat starts one turn, counts it and names the focus", () => {
  const h = harness()
  const heartbeat = createHeartbeat(h.deps, { tickMs: 0 })
  try {
    assert.equal(heartbeat.tick(), true)
    assert.equal(h.starts.length, 1)
    const text = h.starts[0] as string
    assert.ok(text.startsWith(`${HEARTBEAT_PREFIX} — `), text)
    assert.match(text, /idle 1h 30m/)
    assert.match(text, /ship the heartbeat/)
    assert.match(text, /trim the usage ledger/)
    assert.match(text, /proposals waiting for approval: 1\./)
    assert.ok(text.includes(HEARTBEAT_INSTRUCTION))
    assert.equal(h.counters.get(TODAY), 1)

    for (const wanted of [2, 3, 4]) {
      assert.equal(heartbeat.tick(), true)
      assert.equal(h.counters.get(TODAY), wanted)
    }
    assert.equal(heartbeat.tick(), false)
    assert.equal(h.starts.length, 4)
    assert.equal(h.counters.get(TODAY), 4)
  } finally {
    heartbeat.stop()
  }
})

test("the counter only counts the day it was written on", () => {
  const yesterday = heartbeatDate(NOW - 24 * 60 * MINUTE)
  const h = harness({}, { [yesterday]: 4 })
  assert.equal(tickOnce(h), true)
  assert.equal(h.counters.get(TODAY), 1)
  assert.equal(h.counters.get(yesterday), 4)
})

test("only the first five focus items ride along", () => {
  const focus = ["one", "two", "three", "four", "five", "six", "seven"]
  const h = harness({ openFocus: () => focus.length, focusTexts: () => focus })
  assert.equal(tickOnce(h), true)
  const text = h.starts[0] as string
  for (const item of focus.slice(0, 5)) assert.ok(text.includes(`- ${item}`), text)
  assert.ok(!text.includes("- six"), text)
  assert.ok(!text.includes("- seven"), text)
})

test("a start that throws rolls the day's counter back", () => {
  const h = harness(
    {
      start: () => {
        throw new Error("turn refused")
      },
    },
    { [TODAY]: 2 },
  )
  assert.equal(tickOnce(h), false)
  assert.equal(h.counters.get(TODAY), 2)
})

test("0 idle minutes or a 0 daily cap turns the heartbeat off", () => {
  for (const opts of [{ idleMinutes: 0 }, { idleMinutes: -5 }, { maxPerDay: 0 }]) {
    const h = harness()
    assert.equal(tickOnce(h, opts), false, JSON.stringify(opts))
    assert.deepEqual(h.starts, [], JSON.stringify(opts))
  }
})

test("the interval ticks on its own and stop() clears it", async () => {
  const h = harness()
  const heartbeat = createHeartbeat(h.deps, { tickMs: 5, maxPerDay: 100 })
  try {
    await new Promise((resolve) => setTimeout(resolve, 60))
    heartbeat.stop()
    const seen = h.starts.length
    assert.ok(seen > 0, "the timer never fired")
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.equal(h.starts.length, seen)
  } finally {
    heartbeat.stop()
  }
})
