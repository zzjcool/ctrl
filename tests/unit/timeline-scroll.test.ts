import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const appJs = readFileSync(path.join(repoRoot, "src/web/public/app.js"), "utf8")

function sliceFrom(marker: string, until: string): string {
  const start = appJs.indexOf(marker)
  assert.ok(start >= 0, `app.js is missing ${marker}`)
  const end = appJs.indexOf(until, start)
  assert.ok(end > start, `app.js is missing ${until} after ${marker}`)
  return appJs.slice(start, end)
}

function constantOf(name: string): string {
  const found = new RegExp(`const ${name} = [^\\n]+`).exec(appJs)
  assert.ok(found, `app.js is missing the ${name} constant`)
  return found[0]
}

const scrollerSource = sliceFrom("let stickObserver", "function updateLoadEarlier")
const tailSource = sliceFrom("async function loadTail", "async function loadEarlier")
const bootSource = sliceFrom("async function tryLoadAgent", "function bind")
const constantsSource = ["NEAR_BOTTOM_PX", "STICK_POLL_MS", "STICK_UP_PX"].map(constantOf).join("\n")

type Timeline = { scrollTop: number; scrollHeight: number; clientHeight: number }

type State = { stickToBottom: boolean; lastTimelineScrollTop: number; eventCount?: number; loaded?: boolean }

type FakeResizeObserver = {
  callback: () => void
  disconnected: boolean
  target: unknown
  observe: (target: unknown) => void
  disconnect: () => void
  fire: () => void
}

type Observed = {
  els: { timeline: Timeline; rows: object }
  state: State
  frames: Map<number, () => void>
  timeouts: Map<number, () => void>
  intervals: Map<number, () => void>
  observers: FakeResizeObserver[]
  runTimeouts: () => void
  runIntervals: () => void
  flushFrames: () => void
}

type ScrollerApi = {
  scrollToBottom: () => void
  stopStickToBottom: () => void
  stickOnce: () => void
  scheduleStickToBottom: () => void
  noteTimelineScroll: () => void
  watchTimelineGrowth: () => void
}

type Scroller = Observed & ScrollerApi

function fakes(options: { timeline?: Partial<Timeline>; state?: Partial<State> }) {
  const frames = new Map<number, () => void>()
  const timeouts = new Map<number, () => void>()
  const intervals = new Map<number, () => void>()
  const observers: FakeResizeObserver[] = []
  let nextId = 1

  class Observer implements FakeResizeObserver {
    callback: () => void
    disconnected = false
    target: unknown = null
    constructor(callback: () => void) {
      this.callback = callback
      observers.push(this)
    }
    observe(target: unknown) {
      this.target = target
    }
    disconnect() {
      this.disconnected = true
    }
    fire() {
      if (!this.disconnected) this.callback()
    }
  }

  const fakeWindow = {
    requestAnimationFrame: (callback: () => void) => {
      const id = nextId++
      frames.set(id, callback)
      return id
    },
    cancelAnimationFrame: (id: number) => {
      frames.delete(id)
    },
    setTimeout: (callback: () => void) => {
      const id = nextId++
      timeouts.set(id, callback)
      return id
    },
    clearTimeout: (id: number) => {
      timeouts.delete(id)
    },
    setInterval: (callback: () => void) => {
      const id = nextId++
      intervals.set(id, callback)
      return id
    },
    clearInterval: (id: number) => {
      intervals.delete(id)
    },
  }

  const els = {
    timeline: { scrollTop: 0, scrollHeight: 641, clientHeight: 641, ...(options.timeline || {}) },
    rows: {},
  }
  const state: State = { stickToBottom: true, lastTimelineScrollTop: 0, ...(options.state || {}) }

  const observed: Observed = {
    els,
    state,
    frames,
    timeouts,
    intervals,
    observers,
    runTimeouts: () => {
      const pending = [...timeouts.values()]
      timeouts.clear()
      for (const callback of pending) callback()
    },
    runIntervals: () => {
      for (const callback of [...intervals.values()]) callback()
    },
    flushFrames: () => {
      for (let guard = 0; guard < 10 && frames.size > 0; guard += 1) {
        const pending = [...frames.values()]
        frames.clear()
        for (const callback of pending) callback()
      }
    },
  }

  return { observed, fakeWindow, Observer }
}

function harness(options: {
  resizeObserver: boolean
  timeline?: Partial<Timeline>
  state?: Partial<State>
}): Scroller {
  const { observed, fakeWindow, Observer } = fakes(options)
  const body = [
    constantsSource,
    scrollerSource,
    "return { scrollToBottom, stopStickToBottom, stickOnce, scheduleStickToBottom, noteTimelineScroll, watchTimelineGrowth }",
  ].join("\n")

  const factory = new Function("els", "state", "window", "ResizeObserver", body) as (
    els: Observed["els"],
    state: State,
    window: object,
    ResizeObserver: unknown,
  ) => ScrollerApi

  const api = factory(observed.els, observed.state, fakeWindow, options.resizeObserver ? Observer : undefined)
  return { ...observed, ...api }
}

function tailHarness(options: { timeline?: Partial<Timeline>; state?: Partial<State> }) {
  const { observed, fakeWindow, Observer } = fakes(options)
  const calls: string[] = []
  const body = [constantsSource, scrollerSource, tailSource, "return { loadTail }"].join("\n")

  const factory = new Function(
    "els",
    "state",
    "window",
    "ResizeObserver",
    "api",
    "numberOf",
    "appendEvents",
    "toast",
    "messageOf",
    "TAIL",
    body,
  ) as (
    els: Observed["els"],
    state: State,
    window: object,
    ResizeObserver: unknown,
    api: (path: string) => Promise<unknown>,
    numberOf: (value: unknown) => number | null,
    appendEvents: (events: unknown) => void,
    toast: (message: string) => void,
    messageOf: (error: unknown) => string,
    TAIL: number,
  ) => { loadTail: (options?: { scroll?: boolean }) => Promise<void> }

  const api = factory(
    observed.els,
    observed.state,
    fakeWindow,
    Observer,
    async () => ({ total: 3, events: [{ id: 1 }] }),
    (value) => (typeof value === "number" ? value : null),
    (events) => {
      calls.push("appendEvents")
      if (Array.isArray(events) && events.length) observed.els.timeline.scrollHeight = 14468
    },
    (message) => calls.push(`toast:${message}`),
    (error) => String(error),
    100,
  )
  return { ...observed, ...api, calls }
}

function bootHarness(options: { timeline?: Partial<Timeline>; state?: Partial<State> }) {
  const { observed, fakeWindow, Observer } = fakes(options)
  const calls: string[] = []
  const body = [constantsSource, scrollerSource, bootSource, "return { tryLoadAgent }"].join("\n")

  const stubbed = [
    "api",
    "applyAgent",
    "loadTail",
    "refreshJobs",
    "refreshProposals",
    "refreshFocus",
    "renderDream",
    "updateHead",
    "updateEmpty",
    "updateLoadEarlier",
    "syncPending",
    "updateComposer",
    "setConnected",
  ]
  const factory = new Function(
    "els",
    "state",
    "window",
    "ResizeObserver",
    ...stubbed,
    body,
  ) as (
    els: Observed["els"],
    state: State,
    window: object,
    ResizeObserver: unknown,
    ...stubs: unknown[]
  ) => { tryLoadAgent: () => Promise<boolean> }

  const stubs = [
    async () => ({}),
    () => calls.push("applyAgent"),
    async () => calls.push("loadTail"),
    async () => calls.push("refreshJobs"),
    async () => calls.push("refreshProposals"),
    () => calls.push("refreshFocus"),
    () => calls.push("renderDream"),
    () => calls.push("updateHead"),
    () => calls.push("updateEmpty"),
    () => calls.push("updateLoadEarlier"),
    () => calls.push("syncPending"),
    () => calls.push("updateComposer"),
    () => calls.push("setConnected"),
  ]

  const api = factory(observed.els, observed.state, fakeWindow, Observer, ...stubs)
  return { ...observed, ...api, calls }
}

function initialState(): Record<string, unknown> {
  const start = appJs.indexOf("const state = {")
  assert.ok(start >= 0, "app.js must declare the state object")
  const end = appJs.indexOf("\n}\n", start)
  assert.ok(end > start, "app.js must close the state object")
  return new Function(`${appJs.slice(start, end + 2)}\nreturn state`)() as Record<string, unknown>
}

test("refresh always jumps to the newest message because scroll restoration is manual", () => {
  const guard = /try \{\s*if \("scrollRestoration" in history\) history\.scrollRestoration = "manual"\s*\} catch \{\}/.exec(appJs)
  assert.ok(guard, 'app.js must set history.scrollRestoration = "manual" behind a feature test inside try/catch')

  const modern: { scrollRestoration?: string } = { scrollRestoration: "auto" }
  new Function("history", guard[0])(modern)
  assert.equal(modern.scrollRestoration, "manual", "modern browsers must turn off scroll restoration")

  const legacy: { scrollRestoration?: string } = {}
  assert.doesNotThrow(() => new Function("history", guard[0])(legacy), "old browsers must not throw")
  assert.equal(legacy.scrollRestoration, undefined, "old browsers must be left alone")
})

test("the stick flag starts on and only the reader may turn it off", () => {
  const initial = initialState()
  assert.equal(initial.stickToBottom, true, "an untouched timeline follows the newest message")
  assert.equal("nearBottom" in initial, false, "there is only one flag: nearBottom must not come back")
  assert.equal(appJs.includes("nearBottom"), false, "no code may read or write nearBottom anymore")
  assert.equal(appJs.includes("STICK_WINDOW_MS"), false, "the 2s stick window must be gone")
})

test("slow data that lands after 9s still snaps to the bottom because the stick never expires", () => {
  const scroller = harness({ resizeObserver: true })
  scroller.watchTimelineGrowth()
  assert.equal(scroller.observers.length, 1, "a ResizeObserver must watch for layout growth")
  assert.equal(scroller.observers[0].target, scroller.els.rows, "the observer must watch rows, not the timeline")
  assert.equal(scroller.timeouts.size, 0, "no expiry timer may be armed")

  scroller.els.timeline.scrollTop = 0
  assert.equal(
    scroller.els.timeline.scrollHeight,
    scroller.els.timeline.clientHeight,
    "the empty container is already at the bottom",
  )

  scroller.runTimeouts()
  assert.equal(scroller.observers[0].disconnected, false, "no timeout may ever disconnect the observer")
  assert.equal(scroller.state.stickToBottom, true, "waiting for data must not drop the stick")

  scroller.els.timeline.scrollHeight = 14468
  scroller.observers[0].fire()
  scroller.flushFrames()
  assert.equal(scroller.els.timeline.scrollTop, 14468, "rows that grow after 9s must still be followed to the bottom")
  assert.equal(scroller.state.stickToBottom, true, "late growth keeps the stick on")
  assert.equal(scroller.observers[0].disconnected, false, "the observer stays alive for the next growth")
})

test("a manual upward swipe drops the stick and later growth must not steal the scrollbar", () => {
  const scroller = harness({ resizeObserver: true, timeline: { scrollHeight: 5000 } })
  scroller.watchTimelineGrowth()
  scroller.scheduleStickToBottom()
  scroller.flushFrames()
  assert.equal(scroller.els.timeline.scrollTop, 5000)

  scroller.els.timeline.scrollTop = 4000
  scroller.noteTimelineScroll()
  assert.equal(scroller.state.stickToBottom, false, "scrolling up must drop the stick flag")
  assert.equal(scroller.state.lastTimelineScrollTop, 4000, "the last seen position must be recorded")
  assert.equal(scroller.observers[0].disconnected, false, "the observer must stay alive, the flag decides instead")

  scroller.scheduleStickToBottom()
  assert.equal(scroller.frames.size, 0, "a dropped stick must not queue a scroll frame")

  scroller.els.timeline.scrollHeight = 9000
  scroller.observers[0].fire()
  scroller.flushFrames()
  assert.equal(scroller.els.timeline.scrollTop, 4000, "a dropped stick must never move the scrollbar again")
  assert.equal(scroller.state.stickToBottom, false)
})

test("scrolling back to the bottom re-arms the stick", () => {
  const scroller = harness({
    resizeObserver: true,
    timeline: { scrollTop: 4000, scrollHeight: 5000, clientHeight: 641 },
    state: { stickToBottom: false, lastTimelineScrollTop: 4000 },
  })
  scroller.watchTimelineGrowth()

  scroller.els.timeline.scrollTop = 4340
  scroller.noteTimelineScroll()
  assert.equal(scroller.state.stickToBottom, true, "a gap under NEAR_BOTTOM_PX re-arms the stick")

  scroller.els.timeline.scrollHeight = 9000
  scroller.observers[0].fire()
  scroller.flushFrames()
  assert.equal(scroller.els.timeline.scrollTop, 9000, "the re-armed stick follows the next growth")
})

test("the first loadTail always snaps to the bottom, even if the flag was somehow off", async () => {
  for (const stickToBottom of [true, false]) {
    const tail = tailHarness({
      timeline: { scrollTop: 0, scrollHeight: 641, clientHeight: 641 },
      state: { stickToBottom, lastTimelineScrollTop: 0 },
    })
    await tail.loadTail()
    assert.deepEqual(tail.calls, ["appendEvents"], "loadTail must render the tail before pinning")
    assert.equal(tail.els.timeline.scrollTop, 14468, `loadTail must pin unconditionally (stick=${stickToBottom})`)
    assert.equal(tail.state.lastTimelineScrollTop, 14468, "the pin must record the new position")
  }
})

test("a slow boot must not resurrect the stick after the reader scrolled up", async () => {
  for (const stickToBottom of [true, false]) {
    const boot = bootHarness({
      timeline: { scrollTop: 4000, scrollHeight: 9000, clientHeight: 641 },
      state: { stickToBottom, lastTimelineScrollTop: 4000, eventCount: 5 },
    })
    assert.equal(await boot.tryLoadAgent(), true, "the boot load must report success")
    assert.ok(boot.calls.includes("loadTail"), "the boot must render the tail")
    assert.equal(boot.state.stickToBottom, stickToBottom, "boot must leave the reader's intent alone")

    boot.flushFrames()
    const expected = stickToBottom ? 9000 : 4000
    assert.equal(boot.els.timeline.scrollTop, expected, `boot must only pin when the stick is on (stick=${stickToBottom})`)
  }
})

test("without ResizeObserver the fallback poll runs until the reader scrolls up, then re-arms at the bottom", () => {
  const scroller = harness({ resizeObserver: false, timeline: { scrollHeight: 5000, clientHeight: 641 } })
  scroller.watchTimelineGrowth()
  assert.equal(scroller.observers.length, 0, "no ResizeObserver may be constructed when it is missing")
  assert.equal(scroller.intervals.size, 1, "the fallback must poll")
  assert.equal(scroller.timeouts.size, 0, "the fallback must not be killed by a timeout")

  scroller.els.timeline.scrollHeight = 5610
  scroller.runIntervals()
  scroller.flushFrames()
  assert.equal(scroller.els.timeline.scrollTop, 5610, "the fallback poll must pin the timeline to the bottom")
  assert.equal(scroller.intervals.size, 1, "the fallback keeps polling after growth")

  scroller.els.timeline.scrollTop = 4000
  scroller.noteTimelineScroll()
  assert.equal(scroller.state.stickToBottom, false)
  assert.equal(scroller.intervals.size, 0, "scrolling up must stop the fallback poll")

  scroller.els.timeline.scrollTop = 4969
  scroller.noteTimelineScroll()
  assert.equal(scroller.state.stickToBottom, true, "returning to the bottom must re-arm the flag")
  assert.equal(scroller.intervals.size, 1, "returning to the bottom must restart the fallback poll")
})

test("the first screen pins the timeline once, after the tail and the job cards have both landed", () => {
  const parallel = bootSource.indexOf("await Promise.all([")
  assert.ok(parallel >= 0, "boot must fetch the tail and the job cards in parallel")

  const pins = [...bootSource.matchAll(/scrollToBottom\(/g)]
  assert.equal(pins.length, 1, "boot must pin the timeline exactly once")
  const pin = pins[0].index ?? -1
  assert.ok(pin > parallel, "the only pin must sit after the parallel load, never inside it")
  assert.equal(/await loadTail\(\)/.test(bootSource), false, "boot must not let loadTail pin on its own")
  assert.equal(/await refreshJobs\(\)/.test(bootSource), false, "the job cards must not be awaited after the pin")

  const tail = bootSource.slice(parallel)
  assert.ok(tail.indexOf("scrollToBottom(") > tail.indexOf("Promise.all(["), "the pin must follow the parallel load")
})

test("loadTail can be asked to skip its own pin so the first screen only pins once", async () => {
  const calls = [...appJs.matchAll(/(?<!function )\bloadTail\(([^)]*)\)/g)].map((match) => match[1].trim())
  assert.deepEqual(calls, ["{ scroll: false }"], "the only caller is the boot, and it must disable the inner pin")

  const off = tailHarness({ timeline: { scrollTop: 0, scrollHeight: 641, clientHeight: 641 } })
  await off.loadTail({ scroll: false })
  assert.deepEqual(off.calls, ["appendEvents"], "the tail must still be rendered")
  assert.equal(off.els.timeline.scrollTop, 0, "scroll:false must leave the scrollbar for the caller")
  assert.equal(off.state.lastTimelineScrollTop, 0, "skipping the pin must not record a new position")

  const on = tailHarness({ timeline: { scrollTop: 0, scrollHeight: 641, clientHeight: 641 } })
  await on.loadTail()
  assert.equal(on.els.timeline.scrollTop, 14468, "the default must keep pinning for every other flow")
  assert.equal(on.state.lastTimelineScrollTop, 14468, "the default pin must record the new position")
})
