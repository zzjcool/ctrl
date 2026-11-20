import assert from "node:assert/strict"
import { test } from "node:test"
import {
  COMPOSER_SELECTOR,
  MAX_OVERFLOW_ITEMS,
  ROW_SELECTOR,
  classifyConsole,
  findOverflow,
  formatSummary,
  horizontalOverflow,
  measureExpression,
  widthFailed,
} from "../../src/web/experience.ts"
import type { Box, ConsoleEvent, WidthReport } from "../../src/web/experience.ts"

function report(widths: WidthReport[]) {
  return {
    url: "http://127.0.0.1:7333/",
    startedAt: "2026-11-21T00:00:00.000Z",
    ok: widths.every((item) => !widthFailed(item)),
    widths,
  }
}

function width(opts: {
  width: number
  scrollWidth?: number
  clientWidth?: number
  rows?: number
  composer?: { x: number; y: number; width: number; height: number } | null
  wide?: Box[]
  console?: WidthReport["console"]
  ready?: boolean
}): WidthReport {
  const clientWidth = opts.clientWidth ?? opts.width
  const wide = opts.wide ?? []
  return {
    width: opts.width,
    ready: opts.ready ?? true,
    screenshot: `/tmp/exp/${opts.width}.png`,
    measurement: {
      scrollWidth: opts.scrollWidth ?? clientWidth,
      clientWidth,
      rows: opts.rows ?? 12,
      composer: opts.composer === undefined ? { x: 0, y: 640, width: opts.width, height: 120 } : opts.composer,
      wide,
    },
    overflow: findOverflow(wide, clientWidth),
    console: opts.console ?? [],
  }
}

test("horizontal overflow means scrollWidth past clientWidth", () => {
  assert.equal(horizontalOverflow(390, 390), false)
  assert.equal(horizontalOverflow(389, 390), false)
  assert.equal(horizontalOverflow(391, 390), true)
})

test("overflow keeps only boxes outside the viewport, capped at ten", () => {
  const boxes: Box[] = [
    { tag: "div", cls: "card", left: 0, right: 390, },
    { tag: "pre", cls: "code block", left: -2, right: 120 },
    { tag: "div", cls: "", left: 0, right: 391 },
    { tag: "span", cls: "chip", left: 389, right: 391 },
  ]
  assert.deepEqual(
    findOverflow(boxes, 390).map((box) => [box.tag, box.cls]),
    [
      ["pre", "code block"],
      ["div", ""],
      ["span", "chip"],
    ],
  )
  const many: Box[] = Array.from({ length: MAX_OVERFLOW_ITEMS + 5 }, (_, index) => ({
    tag: "div",
    cls: `wide-${index}`,
    left: 0,
    right: 900,
  }))
  assert.equal(findOverflow(many, 390).length, MAX_OVERFLOW_ITEMS)
  assert.equal(findOverflow(many, 390)[0]?.cls, "wide-0")
})

test("console errors and page errors are kept, warnings are not", () => {
  const events: ConsoleEvent[] = [
    { kind: "console", type: "error", text: "Failed to load resource: 404" },
    { kind: "console", type: "warning", text: "deprecated" },
    { kind: "console", type: "log", text: "hello" },
    { kind: "exception", text: "TypeError: timeline is undefined" },
  ]
  assert.deepEqual(classifyConsole(events), [
    { kind: "console", text: "Failed to load resource: 404" },
    { kind: "pageerror", text: "TypeError: timeline is undefined" },
  ])
  assert.deepEqual(classifyConsole([]), [])
})

test("the summary prints one line per width and then the failure items", () => {
  const clean = width({ width: 390 })
  const broken = width({
    width: 1280,
    scrollWidth: 1300,
    wide: [{ tag: "div", cls: "card is-wide", left: 0, right: 1300 }],
    console: [
      { kind: "console", text: "Failed to load resource: 404" },
      { kind: "pageerror", text: "Error: boom\n    at app.js:12:3" },
    ],
  })
  const empty = width({ width: 768, ready: false, rows: 0, composer: null })
  const text = formatSummary(report([clean, broken, empty]))
  assert.deepEqual(text.split("\n"), [
    "experience http://127.0.0.1:7333/ — 3 widths, 2 failing",
    "390 ok scroll 390/390 rows 12 composer 390x120 console 0",
    "1280 fail scroll 1300/1280 rows 12 composer 1280x120 console 2",
    "768 fail scroll 768/768 rows 0 composer none console 0",
    "  1280: horizontal overflow 1300 > 1280",
    "  1280: overflow div.card.is-wide [0, 1300] outside 0..1280",
    "  1280: console Failed to load resource: 404",
    "  1280: pageerror Error: boom at app.js:12:3",
    "  768: timeline rows never appeared",
  ])
  assert.equal(formatSummary(report([clean])).split("\n")[0], "experience http://127.0.0.1:7333/ — 1 widths, 0 failing")
})

test("the measurement expression is a valid expression that reads the timeline and the composer", () => {
  const source = measureExpression()
  assert.equal(typeof new Function(`return (${source})`), "function")
  assert.ok(source.includes(JSON.stringify(ROW_SELECTOR)))
  assert.ok(source.includes(JSON.stringify(COMPOSER_SELECTOR)))
  assert.ok(source.includes("scrollWidth"))
  assert.ok(source.includes("clientWidth"))
  assert.ok(source.includes("rows"))
})
