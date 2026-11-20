import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const appJs = readFileSync(path.join(repoRoot, "src/web/public/app.js"), "utf8")
const html = readFileSync(path.join(repoRoot, "src/web/public/index.html"), "utf8")

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

const constantsSource = ["NEAR_BOTTOM_PX", "STICK_POLL_MS", "STICK_UP_PX"].map(constantOf).join("\n")
const scrollerSource = sliceFrom("let stickObserver", "function updateLoadEarlier")
const appendSource = sliceFrom("function appendEvents", "function prependEvents")
const headSource = sliceFrom("function updateHead", "function updateEmpty")

type Timeline = { scrollTop: number; scrollHeight: number; clientHeight: number }

type Row = { day: string | null; date: string; el: object }

type State = {
  stickToBottom: boolean
  lastTimelineScrollTop: number
  pendingNewCount: number
  rows: Row[]
  pendingEl: object | null
  eventCount: number
  loaded: boolean
}

type TextNode = { textContent: string }

type Pill = { hidden: boolean; readonly textContent: string }

type TimelineEls = {
  timeline: Timeline
  rows: { appendChild: (node: unknown) => void }
  jumpPill: Pill
  jumpPillCount: TextNode
}

type HeadEls = {
  name: TextNode
  events: TextNode
  workers: TextNode & { title: string }
  last: TextNode & { title: string }
  resume: { hidden: boolean; title: string }
  memoryItem: { hidden: boolean }
  memoryValue: TextNode
  memoryBtnCount: TextNode
  memoryBtn: { title: string }
  windowItem: { hidden: boolean; title: string }
  windowValue: TextNode
}

type HeadState = {
  name: string
  eventCount: number
  lastActivity: string
  workerCount: number
  resumePoint: unknown
  memoryCount: number | null
  windowChars: number | null
  windowStart: number | null
  loaded: boolean
}

function timelineHarness(options: { timeline?: Partial<Timeline>; state?: Partial<State> } = {}) {
  const count: TextNode = { textContent: "" }
  const label: TextNode = { textContent: "回到最新 ↓" }
  const pill: Pill = {
    hidden: true,
    get textContent() {
      return `${count.textContent}${label.textContent}`
    },
  }
  const els: TimelineEls = {
    timeline: { scrollTop: 0, scrollHeight: 9000, clientHeight: 641, ...(options.timeline || {}) },
    rows: { appendChild: (_node: unknown) => {} },
    jumpPill: pill,
    jumpPillCount: count,
  }
  const state: State = {
    stickToBottom: true,
    lastTimelineScrollTop: 0,
    pendingNewCount: 0,
    rows: [],
    pendingEl: null,
    eventCount: 0,
    loaded: true,
    ...(options.state || {}),
  }

  const frames = new Map<number, () => void>()
  let nextId = 1
  const fakeWindow = {
    requestAnimationFrame: (callback: () => void) => {
      const id = nextId++
      frames.set(id, callback)
      return id
    },
    cancelAnimationFrame: (id: number) => {
      frames.delete(id)
    },
    setInterval: () => {
      nextId += 1
      return nextId
    },
    clearInterval: () => {},
    setTimeout: () => {
      nextId += 1
      return nextId
    },
    clearTimeout: () => {},
  }

  class Observer {
    observe() {}
    disconnect() {}
  }

  const fakeDocument = { createDocumentFragment: () => ({ appendChild: (_node: unknown) => {} }) }

  type Api = {
    appendEvents: (events: unknown[]) => void
    updateJumpPill: () => void
    noteTimelineScroll: () => void
    stopStickToBottom: () => void
    scrollToBottom: () => void
    jumpToLatest: () => void
    scheduleStickToBottom: () => void
    watchTimelineGrowth: () => void
  }

  const body = [
    constantsSource,
    scrollerSource,
    appendSource,
    "return { appendEvents, updateJumpPill, noteTimelineScroll, stopStickToBottom, scrollToBottom, jumpToLatest, scheduleStickToBottom, watchTimelineGrowth }",
  ].join("\n")

  const factory = new Function(
    "els",
    "state",
    "window",
    "ResizeObserver",
    "document",
    "recordOf",
    "separator",
    "noteCursors",
    "scheduleTaskMeasure",
    body,
  ) as (
    els: TimelineEls,
    state: State,
    window: object,
    ResizeObserver: unknown,
    document: object,
    recordOf: (event: unknown) => unknown,
    separator: (date: string, day: string | null) => unknown,
    noteCursors: (events: unknown[]) => void,
    scheduleTaskMeasure: () => void,
  ) => Api

  const api = factory(
    els,
    state,
    fakeWindow,
    Observer,
    fakeDocument,
    () => ({ day: "2026-11-21", date: "2026-11-21", el: {} }),
    () => ({}),
    () => {},
    () => {},
  )

  return { els, state, pill, count, frames, api }
}

function headHarness() {
  const els: HeadEls = {
    name: { textContent: "" },
    events: { textContent: "" },
    workers: { textContent: "", title: "" },
    last: { textContent: "", title: "" },
    resume: { hidden: true, title: "" },
    memoryItem: { hidden: true },
    memoryValue: { textContent: "" },
    memoryBtnCount: { textContent: "" },
    memoryBtn: { title: "" },
    windowItem: { hidden: true, title: "" },
    windowValue: { textContent: "" },
  }
  const state: HeadState = {
    name: "",
    eventCount: 42,
    lastActivity: "",
    workerCount: 0,
    resumePoint: null,
    memoryCount: null,
    windowChars: null,
    windowStart: null,
    loaded: false,
  }
  const fakeDocument = { title: "" }

  const factory = new Function(
    "els",
    "state",
    "document",
    "resumeKind",
    "timeAgo",
    "absoluteTime",
    `${headSource}\nreturn updateHead`,
  ) as (
    els: HeadEls,
    state: HeadState,
    document: { title: string },
    resumeKind: () => string,
    timeAgo: (when: string) => string,
    absoluteTime: (when: string) => string,
  ) => () => void

  const updateHead = factory(els, state, fakeDocument, () => "", (when) => when, (when) => when)
  return { els, state, updateHead }
}

test("the jump pill ships hidden and stays hidden while the timeline is stuck to the bottom", () => {
  const anchor = html.indexOf('id="jump-pill"')
  assert.ok(anchor > 0, "index.html must contain the jump pill")
  const open = html.lastIndexOf("<button", anchor)
  const close = html.indexOf("</button>", anchor)
  assert.ok(open >= 0 && close > open, "the jump pill must be a button")
  const markup = html.slice(open, close)
  assert.match(markup, /type="button"/)
  assert.match(markup, /hidden/)
  assert.match(markup, /aria-live="polite"/)
  assert.match(markup, /回到最新 ↓/)

  const harness = timelineHarness()
  harness.api.updateJumpPill()
  assert.equal(harness.pill.hidden, true, "a fresh page must not show the pill")

  harness.api.appendEvents([{}, {}])
  assert.equal(harness.pill.hidden, true, "appending while stuck to the bottom must not reveal the pill")
  assert.equal(harness.state.pendingNewCount, 0, "following the newest row leaves nothing pending")
  assert.equal(harness.pill.textContent, "回到最新 ↓")
})

test("a manual upward swipe reveals the pill with no count yet", () => {
  const harness = timelineHarness({ timeline: { scrollTop: 4000 }, state: { lastTimelineScrollTop: 5000 } })
  harness.api.noteTimelineScroll()
  assert.equal(harness.state.stickToBottom, false)
  assert.equal(harness.pill.hidden, false, "reading history must surface the jump pill")
  assert.equal(harness.pill.textContent, "回到最新 ↓")
})

test("new rows that land while reading history stack up in the pill", () => {
  const harness = timelineHarness({ timeline: { scrollTop: 4000 }, state: { lastTimelineScrollTop: 5000 } })
  harness.api.noteTimelineScroll()
  harness.api.appendEvents([{}, {}, {}])
  assert.equal(harness.state.pendingNewCount, 3)
  assert.equal(harness.pill.textContent, "3 条新消息 · 回到最新 ↓")

  harness.api.appendEvents([{}, {}])
  assert.equal(harness.state.pendingNewCount, 5)
  assert.equal(harness.pill.textContent, "5 条新消息 · 回到最新 ↓")

  harness.api.appendEvents([])
  assert.equal(harness.state.pendingNewCount, 5, "an empty poll must not bump the counter")
})

test("jumping to the latest message clears the counter and hides the pill", () => {
  const harness = timelineHarness({ timeline: { scrollTop: 4000 }, state: { lastTimelineScrollTop: 5000 } })
  harness.api.noteTimelineScroll()
  harness.api.appendEvents([{}, {}])
  assert.equal(harness.pill.hidden, false)

  harness.api.jumpToLatest()
  assert.equal(harness.state.stickToBottom, true)
  assert.equal(harness.state.pendingNewCount, 0)
  assert.equal(harness.pill.hidden, true)
  assert.equal(harness.els.timeline.scrollTop, 9000, "the jump must land on the newest row")
})

test("scrolling back to the bottom by hand clears the pill without a jump", () => {
  const harness = timelineHarness({ timeline: { scrollTop: 4000 }, state: { lastTimelineScrollTop: 4000 } })
  harness.api.stopStickToBottom()
  harness.api.appendEvents([{}, {}])
  assert.equal(harness.pill.textContent, "2 条新消息 · 回到最新 ↓")

  harness.els.timeline.scrollTop = 8400
  harness.api.noteTimelineScroll()
  assert.equal(harness.state.stickToBottom, true)
  assert.equal(harness.state.pendingNewCount, 0)
  assert.equal(harness.pill.hidden, true)
})

test("the status bar shows — until the agent snapshot lands, and a real zero still reads 0", () => {
  const initial = /id="status-events"[^>]*>([^<]*)</.exec(html)
  assert.ok(initial, "index.html must keep the #status-events element")
  assert.equal(initial[1], "—", "the first paint must not claim 0 events")

  const head = headHarness()
  head.state.eventCount = 42
  head.updateHead()
  assert.equal(head.els.events.textContent, "—", "an unloaded snapshot must not print a number")

  head.state.loaded = true
  head.updateHead()
  assert.equal(head.els.events.textContent, "42")

  head.state.eventCount = 0
  head.updateHead()
  assert.equal(head.els.events.textContent, "0", "a real empty log must still read 0")
})
