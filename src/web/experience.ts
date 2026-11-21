export const DEFAULT_WIDTHS = [390, 1280]

export const READY_TIMEOUT_MS = 15_000

export const VIEWPORT_HEIGHT = 900

export const MAX_OVERFLOW_ITEMS = 10

export const MAX_WIDE_BOXES = 60

export const ROW_SELECTOR = "#timeline .row"

export const COMPOSER_SELECTOR = "#composer"

export const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

export interface Box {
  tag: string
  cls: string
  left: number
  right: number
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface Measurement {
  scrollWidth: number
  clientWidth: number
  rows: number
  composer: Rect | null
  wide: Box[]
}

export type ConsoleEvent = { kind: "console"; type: string; text: string } | { kind: "exception"; text: string }

export interface ConsoleProblem {
  kind: "console" | "pageerror"
  text: string
}

export interface WidthReport {
  width: number
  ready: boolean
  screenshot: string
  measurement: Measurement
  overflow: Box[]
  console: ConsoleProblem[]
}

export interface ExperienceReport {
  url: string
  startedAt: string
  ok: boolean
  widths: WidthReport[]
}

export function horizontalOverflow(scrollWidth: number, clientWidth: number): boolean {
  return scrollWidth > clientWidth
}

export function boxOverflows(box: Box, clientWidth: number): boolean {
  return box.right > clientWidth || box.left < 0
}

export function findOverflow(boxes: Box[], clientWidth: number): Box[] {
  const found: Box[] = []
  for (const box of boxes) {
    if (!boxOverflows(box, clientWidth)) continue
    found.push(box)
    if (found.length >= MAX_OVERFLOW_ITEMS) break
  }
  return found
}

export function classifyConsole(events: ConsoleEvent[]): ConsoleProblem[] {
  const problems: ConsoleProblem[] = []
  for (const event of events) {
    if (event.kind === "exception") {
      problems.push({ kind: "pageerror", text: event.text })
      continue
    }
    if (event.type !== "error") continue
    problems.push({ kind: "console", text: event.text })
  }
  return problems
}

export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

export function boxName(box: Box): string {
  const classes = box.cls.split(/\s+/).filter((name) => name !== "")
  return classes.length === 0 ? box.tag : `${box.tag}.${classes.join(".")}`
}

export function widthFailed(report: WidthReport): boolean {
  return (
    !report.ready ||
    report.console.length > 0 ||
    horizontalOverflow(report.measurement.scrollWidth, report.measurement.clientWidth)
  )
}

export function reportFailed(report: ExperienceReport): boolean {
  return report.widths.some(widthFailed)
}

export function formatSummary(report: ExperienceReport): string {
  const failing = report.widths.filter(widthFailed)
  const lines = [`experience ${report.url} — ${report.widths.length} widths, ${failing.length} failing`]
  for (const item of report.widths) {
    const state = widthFailed(item) ? "fail" : "ok"
    const composer =
      item.measurement.composer === null
        ? "none"
        : `${Math.round(item.measurement.composer.width)}x${Math.round(item.measurement.composer.height)}`
    lines.push(
      `${item.width} ${state} scroll ${item.measurement.scrollWidth}/${item.measurement.clientWidth} ` +
        `rows ${item.measurement.rows} composer ${composer} console ${item.console.length}`,
    )
  }
  for (const item of failing) {
    if (!item.ready) lines.push(`  ${item.width}: timeline rows never appeared`)
    if (horizontalOverflow(item.measurement.scrollWidth, item.measurement.clientWidth)) {
      lines.push(`  ${item.width}: horizontal overflow ${item.measurement.scrollWidth} > ${item.measurement.clientWidth}`)
    }
    for (const box of item.overflow) {
      lines.push(
        `  ${item.width}: overflow ${boxName(box)} [${Math.round(box.left)}, ${Math.round(box.right)}] outside 0..${item.measurement.clientWidth}`,
      )
    }
    for (const problem of item.console) lines.push(`  ${item.width}: ${problem.kind} ${oneLine(problem.text)}`)
  }
  return lines.join("\n")
}

export function rowsExpression(): string {
  return `document.querySelectorAll(${JSON.stringify(ROW_SELECTOR)}).length`
}

export function measureExpression(): string {
  return `(() => {
  const clientWidth = document.documentElement.clientWidth
  const composer = document.querySelector(${JSON.stringify(COMPOSER_SELECTOR)})
  const rect = composer === null ? null : composer.getBoundingClientRect()
  const clipped = (node) => {
    let parent = node.parentElement
    while (parent !== null && parent !== document.body) {
      if (getComputedStyle(parent).overflowX !== "visible") return true
      parent = parent.parentElement
    }
    return false
  }
  const wide = []
  const all = document.body === null ? [] : document.body.querySelectorAll("*")
  for (const node of all) {
    if (wide.length >= ${MAX_WIDE_BOXES}) break
    const box = node.getBoundingClientRect()
    if (box.width === 0 && box.height === 0) continue
    if (box.right <= clientWidth && box.left >= 0) continue
    if (getComputedStyle(node).visibility === "hidden") continue
    if (clipped(node)) continue
    wide.push({
      tag: node.tagName.toLowerCase(),
      cls: typeof node.className === "string" ? node.className : "",
      left: Math.round(box.left),
      right: Math.round(box.right),
    })
  }
  return {
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth,
    rows: document.querySelectorAll(${JSON.stringify(ROW_SELECTOR)}).length,
    composer: rect === null ? null : { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
    wide,
  }
})()`
}
