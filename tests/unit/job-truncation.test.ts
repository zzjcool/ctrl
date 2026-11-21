import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import type { JobView } from "../../src/jobs/store.ts"
import { jobSummary } from "../../src/server/job-routes.ts"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const appJs = readFileSync(path.join(repoRoot, "src/web/public/app.js"), "utf8")
const routesTs = readFileSync(path.join(repoRoot, "src/server/job-routes.ts"), "utf8")

function sliceFrom(marker: string, until: string): string {
  const start = appJs.indexOf(marker)
  assert.ok(start >= 0, `app.js is missing ${marker}`)
  const end = appJs.indexOf(until, start)
  assert.ok(end > start, `app.js is missing ${until} after ${marker}`)
  return appJs.slice(start, end)
}

const JOB_ID = "20260101T000000Z-trunc1"

function fakeJob(): JobView {
  return {
    id: JOB_ID,
    state: "exited",
    task: "t",
    cwd: "/w",
    model: "m",
    thinking: "low",
    startedAt: "2026-01-01T00:00:00.000Z",
    pid: 1,
    code: 0,
    elapsedMs: 1000,
  }
}

function withLog<T>(lines: string[], run: (home: string) => T): T {
  const home = mkdtempSync(path.join(tmpdir(), "ctrl-trunc-"))
  try {
    const dir = path.join(home, "jobs", JOB_ID)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, "out.log"), `${lines.join("\n")}\n`)
    return run(home)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

function summaryOutput(lines: string[]): string {
  return withLog(lines, (home) => String(jobSummary(fakeJob(), home).output ?? ""))
}

test("a log with more lines than the summary keeps is marked as truncated", () => {
  const lines = Array.from({ length: 20 }, (_, index) => `line ${index}`)
  const output = summaryOutput(lines)
  assert.ok(output.startsWith("…"), `expected a truncation mark, got ${JSON.stringify(output)}`)
  assert.ok(!output.startsWith("……"), "the mark is only added once")
  assert.match(output, /line 19$/)
  assert.doesNotMatch(output, /line 0\b/, "the first lines are dropped")
  assert.equal(output.split("\n").length, 15)
})

test("a single long line that exceeds the character budget is marked as truncated", () => {
  const output = summaryOutput([`head-${"x".repeat(4_000)}-tail`])
  assert.ok(output.startsWith("…"), `expected a truncation mark, got ${JSON.stringify(output.slice(0, 20))}`)
  assert.equal(output.length, 3_001)
  assert.match(output, /-tail$/)
})

test("a short log is left exactly as rendered", () => {
  const output = summaryOutput(["→ bash: echo hi", "← hi", "assistant: done"])
  assert.equal(output, "→ bash: echo hi\n← hi\nassistant: done")
  assert.ok(!output.startsWith("…"))
})

test("the job summary keeps the documented key set and nothing more", () => {
  const summary = withLog(["assistant: hello"], (home) => jobSummary(fakeJob(), home))
  assert.deepEqual(Object.keys(summary).sort(), ["code", "elapsedMs", "id", "output", "startedAt", "state", "task"])
  assert.equal(typeof summary.output, "string")
  const suspicious = Object.keys(summary).filter((key) => /truncat|clip|hidden/i.test(key))
  assert.deepEqual(suspicious, [])
  const assigned = [...routesTs.matchAll(/summary\.(\w+)\s*=/g)].map((match) => match[1])
  assert.deepEqual([...new Set(assigned)].sort(), ["output"])
})

type FakeNode = {
  tag: string
  className: string
  textContent: string
  hidden: boolean
  title: string
  dataset: Record<string, string>
  children: unknown[]
  classList: { remove: () => void }
  append: (...nodes: unknown[]) => void
  lastElementChild: FakeNode | undefined
}

function fakeNode(tag: string, className?: string, text?: unknown): FakeNode {
  const node: FakeNode = {
    tag,
    className: className ?? "",
    textContent: text === undefined || text === null ? "" : String(text),
    hidden: false,
    title: "",
    dataset: {},
    children: [],
    classList: { remove: () => {} },
    append: (...nodes: unknown[]) => {
      node.children.push(...nodes)
    },
    get lastElementChild() {
      const elements = node.children.filter((child) => typeof child === "object") as FakeNode[]
      return elements[elements.length - 1]
    },
  }
  return node
}

const cardSource = sliceFrom("function createJobCard", "function registerJob")
const applySource = `${sliceFrom("function outputIsTruncated", "function applyJobToCard")}${sliceFrom("function applyJobToCard", "function fillJobCall")}`

const makeCard = new Function(
  "el",
  "document",
  "cardOf",
  "state",
  `${cardSource}\nreturn createJobCard`,
)(fakeNode, { createElement: (tag: string) => fakeNode(tag) }, { set: () => {} }, { jobCards: [] })

const applyCard = new Function(
  "badgeText",
  "formatDuration",
  "setJobTask",
  `${applySource}\nreturn applyJobToCard`,
)(
  (state: string) => state,
  (ms: number) => `${ms}ms`,
  () => {},
)

function truncatedBadge(card: { details: FakeNode }): FakeNode | undefined {
  const summary = card.details.children[0] as FakeNode | undefined
  const children = summary?.children ?? []
  return children.find((child) => typeof child === "object" && (child as FakeNode).className === "job-truncated") as
    | FakeNode
    | undefined
}

test("the truncation badge lives on the summary and starts hidden", () => {
  const card = makeCard("delegate")
  const summary = card.details.children[0] as FakeNode
  assert.equal(summary.tag, "summary")
  assert.equal(summary.children[0], "输出")
  const badge = truncatedBadge(card)
  assert.ok(badge, "the badge is a child of the summary")
  assert.equal(badge.textContent, "· 已截断")
  assert.equal(badge.hidden, true)
  assert.equal(badge.title, "只显示了输出的末尾，完整内容请查看 job 日志")
})

test("applying a job shows the badge only when output starts with the mark", () => {
  const card = makeCard("delegate")
  const badge = truncatedBadge(card) as FakeNode

  applyCard(card, { id: JOB_ID, state: "exited", output: "…last 15 lines" })
  assert.equal(badge.hidden, false)
  assert.equal(card.pre.textContent, "…last 15 lines")
  assert.doesNotMatch(card.pre.textContent, /截断/)

  applyCard(card, { id: JOB_ID, state: "exited", output: "full text" })
  assert.equal(badge.hidden, true)
  assert.doesNotMatch(card.pre.textContent, /截断/)

  applyCard(card, { id: JOB_ID, state: "exited", output: "" })
  assert.equal(badge.hidden, true)

  applyCard(card, { id: JOB_ID, state: "exited" })
  assert.equal(badge.hidden, true)
  assert.equal(card.pre.textContent, "full text")
})
