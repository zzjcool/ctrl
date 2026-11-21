import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const appJs = readFileSync(path.join(repoRoot, "src/web/public/app.js"), "utf8")
const css = readFileSync(path.join(repoRoot, "src/web/public/styles.css"), "utf8")

function sliceFrom(marker: string, until: string): string {
  const start = appJs.indexOf(marker)
  assert.ok(start >= 0, `app.js is missing ${marker}`)
  const end = appJs.indexOf(until, start)
  assert.ok(end > start, `app.js is missing ${until} after ${marker}`)
  return appJs.slice(start, end)
}

const constants = sliceFrom("const PROPOSAL_REASONS = [", "const state = {")
const normalize = sliceFrom("function normalizeProposalReason(value) {", "function proposalReasonText")
const label = sliceFrom("function proposalReasonText(reason) {", "function proposalStateText")

const api = new Function(
  `${constants}\n${normalize}\n${label}\nreturn { normalizeProposalReason, proposalReasonText, PROPOSAL_REASONS, PROPOSAL_REASON_TEXT }`,
)() as {
  normalizeProposalReason: (value: unknown) => string
  proposalReasonText: (reason: string) => string
  PROPOSAL_REASONS: string[]
  PROPOSAL_REASON_TEXT: Record<string, string>
}

test("every reason code has a console label", () => {
  assert.deepEqual(api.PROPOSAL_REASONS, ["green", "verification_failed", "no_changes", "timeout", "worker_failed"])
  assert.equal(api.proposalReasonText("green"), "全绿")
  assert.equal(api.proposalReasonText("verification_failed"), "验证失败")
  assert.equal(api.proposalReasonText("no_changes"), "空 diff")
  assert.equal(api.proposalReasonText("timeout"), "超时")
  assert.equal(api.proposalReasonText("worker_failed"), "worker 失败")
  assert.equal(new Set(Object.values(api.PROPOSAL_REASON_TEXT)).size, 5)
})

test("an unknown or missing reason normalizes to null instead of a label", () => {
  for (const value of ["greem", "GREENISH", "ok", "", "  ", null, undefined, 0, 42, {}, [], true]) {
    assert.equal(api.normalizeProposalReason(value), "", `expected no reason for ${JSON.stringify(value)}`)
  }
  assert.equal(api.normalizeProposalReason(" GREEN "), "green")
  assert.equal(api.normalizeProposalReason("Timeout"), "timeout")
  assert.equal(api.normalizeProposalReason("worker_failed"), "worker_failed")
  assert.equal(api.proposalReasonText(api.normalizeProposalReason("nonsense")), "")
})

test("a missing reason renders no badge and leaves no empty placeholder", () => {
  const card = sliceFrom("function proposalItemEl(proposal) {", "function renderProposals")
  assert.match(
    card,
    /if \(proposal\.reason\) \{\n {4}const reason = el\("span", "proposal-reason", proposalReasonText\(proposal\.reason\)\)\n {4}reason\.dataset\.reason = proposal\.reason\n {4}head\.appendChild\(reason\)\n {2}\}/,
    "the reason badge must only exist when the reason is known",
  )
  assert.match(card, /head\.appendChild\(el\("span", "proposal-task", shortProposalTask\(proposal\.task\)\)\)/)
  assert.ok(!card.includes('proposal-reason", ""'), "no empty badge text")
})

test("the console stylesheet colors every reason code", () => {
  for (const reason of api.PROPOSAL_REASONS) {
    assert.match(css, new RegExp(`\\.proposal-reason\\[data-reason="${reason}"\\]`), `styles.css has no ${reason} badge`)
  }
})
