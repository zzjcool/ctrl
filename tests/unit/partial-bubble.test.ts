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

const partialSource = sliceFrom("function buildPending", "const FOCUS_RANK")
const appendSource = sliceFrom("function appendEvents", "function prependEvents")

interface FakeNode {
  tag: string
  className: string
  textContent: string
  dataset: Record<string, string>
  children: FakeNode[]
  parent: FakeNode | null
  rendered: string
  fragment: boolean
  open: boolean
  listeners: Record<string, Array<() => void>>
  appendChild(node: FakeNode): FakeNode
  append(...nodes: FakeNode[]): void
  insertBefore(node: FakeNode, anchor: FakeNode | null): FakeNode
  remove(): void
  addEventListener(type: string, handler: () => void): void
  readonly lastElementChild: FakeNode | null
  readonly nextElementSibling: FakeNode | null
  readonly previousElementSibling: FakeNode | null
  readonly parentNode: FakeNode | null
}

function fakeNode(tag: string): FakeNode {
  const node = {
    tag,
    className: "",
    textContent: "",
    dataset: {},
    children: [] as FakeNode[],
    parent: null as FakeNode | null,
    rendered: "",
    fragment: false,
    open: false,
    listeners: {} as Record<string, Array<() => void>>,
    addEventListener(type: string, handler: () => void): void {
      const list = node.listeners[type] ?? []
      list.push(handler)
      node.listeners[type] = list
    },
    appendChild(child: FakeNode): FakeNode {
      if (child.fragment) {
        for (const item of child.children.splice(0)) {
          item.remove()
          item.parent = node
          node.children.push(item)
        }
        return child
      }
      child.remove()
      child.parent = node
      node.children.push(child)
      return child
    },
    append(...nodes: FakeNode[]): void {
      for (const item of nodes) {
        item.parent = node
        node.children.push(item)
      }
    },
    insertBefore(child: FakeNode, anchor: FakeNode | null): FakeNode {
      if (anchor !== null && anchor.parent === node) {
        child.remove()
        child.parent = node
        node.children.splice(node.children.indexOf(anchor), 0, child)
        return child
      }
      child.remove()
      child.parent = node
      node.children.push(child)
      return child
    },
    remove(): void {
      const parent = node.parent
      if (parent === null) return
      const at = parent.children.indexOf(node)
      if (at >= 0) parent.children.splice(at, 1)
      node.parent = null
    },
    get lastElementChild(): FakeNode | null {
      return node.children[node.children.length - 1] ?? null
    },
    get nextElementSibling(): FakeNode | null {
      const parent = node.parent
      if (parent === null) return null
      const at = parent.children.indexOf(node)
      return at < 0 ? null : (parent.children[at + 1] ?? null)
    },
    get previousElementSibling(): FakeNode | null {
      const parent = node.parent
      if (parent === null) return null
      const at = parent.children.indexOf(node)
      return at <= 0 ? null : (parent.children[at - 1] ?? null)
    },
    get parentNode(): FakeNode | null {
      return node.parent
    },
  } as FakeNode
  return node
}

interface Turn {
  running: boolean
  partial?: string
  thinking?: string
  startedAt?: string
}

interface ThinkingNode {
  row: FakeNode
  details: FakeNode
  pre: FakeNode
  manual: boolean
}

interface Harness {
  rows: FakeNode
  state: {
    turn: Turn
    pendingEl: FakeNode | null
    partialEl: FakeNode | null
    thinkingEl: ThinkingNode | null
    stickToBottom: boolean
    rows: unknown[]
  }
  syncPending: () => void
  syncPartial: () => void
  syncThinking: () => void
  appendEvents: (events: unknown[]) => void
  partialRows: () => FakeNode[]
  partialText: () => string
  rowClasses: () => string[]
}

function harness(): Harness {
  const rows = fakeNode("div")
  const state = {
    turn: { running: false } as Turn,
    pendingEl: null as FakeNode | null,
    partialEl: null as FakeNode | null,
    thinkingEl: null as ThinkingNode | null,
    stickToBottom: true,
    rows: [] as unknown[],
  }
  const els = {
    rows,
    jumpPill: null,
    jumpPillCount: null,
    timeline: { scrollHeight: 0, clientHeight: 0, scrollTop: 0 },
  }
  const document = {
    createElement: (tag: string) => fakeNode(tag),
    createDocumentFragment: () => {
      const fragment = fakeNode("#fragment")
      fragment.fragment = true
      return fragment
    },
  }
  const fakeWindow = {
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    setInterval: () => 1,
    clearInterval: () => {},
  }
  const el = (tag: string, className?: string, text?: string): FakeNode => {
    const node = fakeNode(tag)
    if (className) node.className = className
    if (text !== undefined && text !== null) node.textContent = String(text)
    return node
  }
  const assistantRow = fakeNode("div")
  assistantRow.className = "row row-agent"
  assistantRow.dataset.type = "assistant_message"
  const recordOf = () => ({ day: "2026-11-21", date: "2026-11-21", el: assistantRow })
  const factory = new Function(
    "els",
    "state",
    "window",
    "ResizeObserver",
    "document",
    "el",
    "timeLabel",
    "renderProse",
    "recordOf",
    "separator",
    "noteCursors",
    "scheduleTaskMeasure",
    "scheduleStickToBottom",
    `${partialSource}\n${appendSource}\nreturn { syncPending, syncPartial, syncThinking, appendEvents }`,
  ) as (
    els: unknown,
    state: unknown,
    window: unknown,
    ResizeObserver: unknown,
    document: unknown,
    el: unknown,
    timeLabel: unknown,
    renderProse: unknown,
    recordOf: unknown,
    separator: unknown,
    noteCursors: unknown,
    scheduleTaskMeasure: unknown,
    scheduleStickToBottom: unknown,
  ) => { syncPending: () => void; syncPartial: () => void; syncThinking: () => void; appendEvents: (events: unknown[]) => void }

  const api = factory(
    els,
    state,
    fakeWindow,
    class {
      observe() {}
      disconnect() {}
    },
    document,
    el,
    () => "12:00",
    (container: FakeNode, text: string) => {
      container.rendered = String(text)
    },
    recordOf,
    () => {
      const separator = fakeNode("div")
      separator.className = "sep"
      return separator
    },
    () => {},
    () => {},
    () => {},
  )

  return {
    rows,
    state,
    ...api,
    partialRows: () => rows.children.filter((node) => node.className.includes("row-partial")),
    rowClasses: () => rows.children.filter((node) => node.className !== "sep").map((node) => node.className),
    partialText: () => {
      const rowsWithPartial = rows.children.filter((node) => node.className.includes("row-partial"))
      const body = rowsWithPartial[0]?.children.find((node) => node.className === "row-body")
      return body?.rendered ?? ""
    },
  }
}

test("a running turn shows one partial bubble under the last row and above the pending line", () => {
  const ui = harness()
  ui.state.turn = { running: true, partial: "half an " }
  ui.syncPending()

  assert.deepEqual(ui.rowClasses(), ["row row-agent row-partial", "row row-pending"])
  assert.equal(ui.partialText(), "half an ")
})

test("the partial bubble grows in place instead of stacking copies", () => {
  const ui = harness()
  for (const partial of ["half ", "half an ", "half an answer"]) {
    ui.state.turn = { running: true, partial }
    ui.syncPending()
    assert.equal(ui.partialRows().length, 1, `only one bubble may exist at ${partial}`)
    assert.equal(ui.partialText(), partial)
  }
  assert.equal(ui.rowClasses().length, 2, "the timeline holds the bubble and the pending line")
})

test("the committed assistant message replaces the bubble, so the text is never on screen twice", () => {
  const ui = harness()
  ui.state.turn = { running: true, partial: "half an answer" }
  ui.syncPending()
  assert.equal(ui.partialRows().length, 1)

  ui.state.turn = { running: true }
  ui.appendEvents([{ seq: 1, ts: "2026-11-21T12:00:00.000Z", type: "assistant_message", data: { text: "half an answer" } }])
  ui.syncPending()

  assert.deepEqual(ui.partialRows(), [], "the bubble is gone once the message is logged")
  assert.deepEqual(ui.rowClasses(), ["row row-agent", "row row-pending"], "the logged row and the pending line remain")
})

test("a turn without partial text and a settled turn both keep the timeline free of bubbles", () => {
  const ui = harness()
  ui.state.turn = { running: true }
  ui.syncPending()
  assert.deepEqual(ui.partialRows(), [])
  assert.deepEqual(ui.rowClasses(), ["row row-pending"])

  ui.state.turn = { running: true, partial: "later text" }
  ui.syncPending()
  assert.equal(ui.partialRows().length, 1)

  ui.state.turn = { running: false }
  ui.syncPending()
  assert.deepEqual(ui.rowClasses(), [], "a finished turn leaves neither bubble nor pending line")
})

test("a thinking block sits above the answer and collapses once the answer starts", () => {
  const ui = harness()
  ui.state.turn = { running: true, thinking: "想一想" }
  ui.syncPending()
  assert.deepEqual(ui.rowClasses(), ["row row-agent row-thinking", "row row-pending"])
  assert.equal(ui.state.thinkingEl?.pre.textContent, "想一想")
  assert.equal(ui.state.thinkingEl?.details.open, true)

  ui.state.turn = { running: true, thinking: "想一想更多", partial: "答案" }
  ui.syncPending()
  assert.deepEqual(ui.rowClasses(), [
    "row row-agent row-thinking",
    "row row-agent row-partial",
    "row row-pending",
  ])
  assert.equal(ui.state.thinkingEl?.details.open, false, "the answer starting collapses the thinking block")

  const listeners = ui.state.thinkingEl?.details.children.find((node) => node.tag === "summary")?.listeners.click ?? []
  assert.equal(listeners.length, 1, "the title toggles with a click, so Enter and Space work too")
  listeners[0]?.()
  if (ui.state.thinkingEl) ui.state.thinkingEl.details.open = true

  ui.state.turn = { running: true, thinking: "想一想更多", partial: "答案更多" }
  ui.syncPending()
  assert.equal(ui.state.thinkingEl?.details.open, true, "a manually opened block stays open for the rest of the turn")
})

test("no thinking block is rendered when the turn has no thinking", () => {
  const ui = harness()
  ui.state.turn = { running: true, partial: "答案" }
  ui.syncPending()
  assert.equal(ui.rowClasses().some((name) => name.includes("row-thinking")), false)
  assert.equal(ui.state.thinkingEl, null)

  ui.state.turn = { running: true }
  ui.syncThinking()
  assert.equal(ui.rowClasses().some((name) => name.includes("row-thinking")), false)
})

test("a thinking block disappears when the turn ends", () => {
  const ui = harness()
  ui.state.turn = { running: true, thinking: "想一想" }
  ui.syncPending()
  assert.equal(ui.rowClasses().some((name) => name.includes("row-thinking")), true)

  ui.state.turn = { running: false }
  ui.syncPending()
  assert.equal(ui.rowClasses().some((name) => name.includes("row-thinking")), false)
  assert.equal(ui.state.thinkingEl, null)
})
