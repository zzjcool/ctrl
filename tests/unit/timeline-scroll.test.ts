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
const constantsSource = ["STICK_WINDOW_MS", "STICK_POLL_MS", "STICK_UP_PX"].map(constantOf).join("\n")

type Scroller = {
  els: { timeline: { scrollTop: number; scrollHeight: number; clientHeight: number }; rows: object }
  state: { stickToBottom: boolean; lastTimelineScrollTop: number }
  scrollToBottom: () => void
  stopStickToBottom: () => void
  stickOnce: () => void
  noteTimelineScroll: () => void
  watchTimelineGrowth: () => void
  scheduleStickToBottom: () => void
  frames: Map<number, () => void>
  timeouts: Map<number, () => void>
  intervals: Map<number, () => void>
  observers: FakeResizeObserver[]
  flushFrames: () => void
  runTimeouts: () => void
}

type FakeResizeObserver = {
  callback: () => void
  disconnected: boolean
  target: unknown
  observe: (target: unknown) => void
  disconnect: () => void
  fire: () => void
}

function harness(options: { resizeObserver: boolean }): Scroller {
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
    timeline: { scrollTop: 0, scrollHeight: 5000, clientHeight: 641 },
    rows: {},
  }
  const state = { stickToBottom: true, lastTimelineScrollTop: 0 }

  const body = [
    constantsSource,
    scrollerSource,
    "return { scrollToBottom, stopStickToBottom, stickOnce, noteTimelineScroll, watchTimelineGrowth, scheduleStickToBottom }",
  ].join("\n")

  const factory = new Function("els", "state", "window", "ResizeObserver", body) as (
    els: Scroller["els"],
    state: Scroller["state"],
    window: object,
    ResizeObserver: unknown,
  ) => Omit<Scroller, "els" | "state" | "frames" | "timeouts" | "intervals" | "observers" | "flushFrames">

  const api = factory(els, state, fakeWindow, options.resizeObserver ? Observer : undefined)

  const flushFrames = () => {
    for (let guard = 0; guard < 10 && frames.size > 0; guard += 1) {
      const pending = [...frames.values()]
      frames.clear()
      for (const callback of pending) callback()
    }
  }

  const runTimeouts = () => {
    const pending = [...timeouts.values()]
    timeouts.clear()
    for (const callback of pending) callback()
  }

  return { ...api, els, state, frames, timeouts, intervals, observers, flushFrames, runTimeouts }
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

test("the first render re-pins the timeline after layout settles and keeps following growth", () => {
  const scroller = harness({ resizeObserver: true })
  assert.equal(scroller.els.timeline.scrollTop, 0, "jsdom starts at the top")

  scroller.scheduleStickToBottom()
  assert.equal(scroller.els.timeline.scrollTop, 5000, "the immediate scroll must already jump to the bottom")
  assert.equal(scroller.els.timeline.scrollTop, scroller.els.timeline.scrollHeight)

  scroller.flushFrames()
  assert.equal(scroller.observers.length, 1, "a ResizeObserver must watch for late layout growth")
  assert.equal(scroller.observers[0].target, scroller.els.rows, "the observer must watch rows, not the timeline")
  assert.equal(scroller.timeouts.size, 1, "the 2s stick window must be scheduled")

  scroller.els.timeline.scrollHeight = 5610
  scroller.observers[0].fire()
  scroller.flushFrames()
  assert.equal(scroller.els.timeline.scrollTop, 5610, "content that grows after first paint must be followed to the bottom")

  scroller.runTimeouts()
  assert.equal(scroller.observers[0].disconnected, true, "the observer must be disconnected when the window closes")
  assert.equal(scroller.timeouts.size, 0, "the window timer must not stay armed")
})

test("a manual upward swipe wins: no later resize may steal the scrollbar", () => {
  const scroller = harness({ resizeObserver: true })
  scroller.scheduleStickToBottom()
  scroller.flushFrames()
  assert.equal(scroller.els.timeline.scrollTop, 5000)

  scroller.els.timeline.scrollTop = 4000
  scroller.noteTimelineScroll()
  assert.equal(scroller.state.stickToBottom, false, "scrolling up must drop the stick flag")
  assert.equal(scroller.observers[0].disconnected, true, "scrolling up must disconnect the observer")
  assert.equal(scroller.timeouts.size, 0, "scrolling up must clear the window timer")
  assert.equal(scroller.state.lastTimelineScrollTop, 4000, "the last seen position must be recorded")

  scroller.els.timeline.scrollHeight = 9000
  scroller.observers[0].fire()
  scroller.flushFrames()
  assert.equal(scroller.els.timeline.scrollTop, 4000, "a disabled stick must never move the scrollbar again")
})

test("without ResizeObserver the stick degrades to a 100ms interval that stops after 2s", () => {
  const scroller = harness({ resizeObserver: false })
  scroller.scheduleStickToBottom()
  scroller.flushFrames()
  assert.equal(scroller.observers.length, 0, "no ResizeObserver may be constructed when it is missing")
  assert.equal(scroller.intervals.size, 1, "the fallback must poll")

  scroller.els.timeline.scrollHeight = 5610
  for (const callback of [...scroller.intervals.values()]) callback()
  assert.equal(scroller.els.timeline.scrollTop, 5610, "the fallback poll must pin the timeline to the bottom")

  scroller.runTimeouts()
  assert.equal(scroller.intervals.size, 0, "the fallback poll must be cleared when the window closes")
})
