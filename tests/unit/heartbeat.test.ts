import assert from "node:assert/strict"
import { test } from "node:test"
import {
  HEARTBEAT_INSTRUCTION,
  HEARTBEAT_PREFIX,
  PROPOSAL_BLOCKING_MS,
  PROPOSAL_DECISION_INSTRUCTION,
  createHeartbeat,
  heartbeatDate,
  heartbeatText,
  proposalSummary,
  type HeartbeatDeps,
  type ProposalSummary,
} from "../../src/server/heartbeat.ts"

const NOW = Date.parse("2026-03-05T12:00:00.000Z")
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const TODAY = heartbeatDate(NOW)

function summary(id: string, ageMs: number, diffstat = "src/a.ts | 2 ++"): ProposalSummary {
  return { id, ageMs, diffstat, blocking: ageMs > PROPOSAL_BLOCKING_MS }
}

const OPEN_PROPOSALS: ProposalSummary[] = [summary("20261121-101010", 10 * MINUTE)]

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
    openProposals: () => OPEN_PROPOSALS,
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
  const h = harness({ openFocus: () => 0, focusTexts: () => [], openProposals: () => [] })
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
    assert.match(text, /proposals waiting for approval \(1\):/)
    assert.ok(text.includes("- 20261121-101010 (10m 00s old, src/a.ts | 2 ++)"), text)
    assert.ok(text.includes(HEARTBEAT_INSTRUCTION))
    assert.ok(text.includes(PROPOSAL_DECISION_INSTRUCTION))
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

test("the heartbeat names every waiting proposal and lists blocking ones above focus", () => {
  const fresh = summary("20261121-101010", 10 * MINUTE, "src/fresh.ts | 1 +")
  const stale = summary("20261119-090000", 30 * HOUR, "src/stale.ts | 3 +++")
  const text = heartbeatText({
    idleMs: 90 * MINUTE,
    openFocus: 2,
    focus: ["ship it", "trim it"],
    openProposals: [fresh, stale],
  })
  const lines = text.split("\n")
  const staleAt = lines.findIndex((line) => line.startsWith("- 20261119-090000"))
  const freshAt = lines.findIndex((line) => line.startsWith("- 20261121-101010"))
  const focusAt = lines.findIndex((line) => line === "open focus (2):")
  assert.ok(staleAt > 0 && freshAt > 0 && focusAt > 0, text)
  assert.ok(staleAt < freshAt, "the 24h+ proposal goes first")
  assert.ok(freshAt < focusAt, "every proposal line sits above the focus lines")
  assert.match(lines[staleAt] as string, /^\- 20261119-090000 \(30h 00m old, src\/stale\.ts \| 3 \+\+\+\) \[blocking\]$/)
  assert.equal((lines[freshAt] as string).endsWith("[blocking]"), false)
  assert.ok(lines.includes("proposals waiting for approval (2):"), text)
  assert.ok(text.includes(PROPOSAL_DECISION_INSTRUCTION), text)
})

test("an empty proposal list drops the proposals section and its instruction", () => {
  const text = heartbeatText({ idleMs: 90 * MINUTE, openFocus: 1, focus: ["ship it"], openProposals: [] })
  assert.equal(text.includes("proposals waiting for approval"), false, text)
  assert.equal(text.includes(PROPOSAL_DECISION_INSTRUCTION), false, text)
  assert.ok(text.includes("- ship it"), text)
  assert.ok(text.includes(HEARTBEAT_INSTRUCTION), text)
})

test("proposals alone keep the heartbeat alive", () => {
  const h = harness({ openFocus: () => 0, focusTexts: () => [] })
  assert.equal(tickOnce(h), true)
  assert.match(h.starts[0] as string, /- 20261121-101010 \(10m 00s old, src\/a\.ts \| 2 \+\+\)/)
})

test("proposalSummary flattens the diffstat and flags anything past a day", () => {
  const fresh = proposalSummary(
    { id: "p1", createdAt: new Date(NOW - 10 * MINUTE).toISOString(), diffstat: "a.ts | 1 +\nb.ts | 2 ++" },
    NOW,
  )
  assert.equal(fresh.ageMs, 10 * MINUTE)
  assert.equal(fresh.diffstat, "a.ts | 1 + b.ts | 2 ++")
  assert.equal(fresh.blocking, false)

  const stale = proposalSummary({ id: "p2", createdAt: new Date(NOW - 25 * HOUR).toISOString() }, NOW)
  assert.equal(stale.blocking, true)
  assert.equal(stale.diffstat, "no diffstat")

  const broken = proposalSummary({ id: "p3", createdAt: "not a date" }, NOW)
  assert.equal(broken.ageMs, 0)
})
