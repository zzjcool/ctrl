import assert from "node:assert/strict"
import { test } from "node:test"
import type { JobView } from "../../src/jobs/store.ts"
import { NO_CHANGES_ERROR, VERIFICATION_FAILED_ERROR } from "../../src/memory/proposals.ts"
import type { Proposal, ProposalReason } from "../../src/memory/proposals.ts"
import { proposalWakeText, wakeText, wakeTextFor } from "../../src/server/wake.ts"

const NOW = new Date(2026, 10, 22, 1, 21, 28)

const JOB: JobView = {
  id: "20261122T012128Z-abc123",
  task: "add the answer file",
  cwd: "/tmp",
  model: "fake-model",
  thinking: "max",
  startedAt: NOW.toISOString(),
  pid: 1,
  state: "exited",
  elapsedMs: 1_500,
  code: 0,
}

const ID = "20261122-012128"

const LEAD = `[ctrl] ${JOB.id} finished → proposal ${ID}`

const SENTENCE: Record<ProposalReason, string> = {
  green: "全绿——直接 apply_proposal 合入，合完再跑一遍验证。",
  verification_failed: "验证没过，不会自动合；让它改到全绿，或写一句理由 discard。",
  no_changes: "worker 没改出任何东西，没什么可合的；要改就重新 self_edit。",
  timeout: "跑太久被停掉了，结果不完整，不会自动合；拆小一点重新 self_edit，或写一句理由 discard。",
  worker_failed: "worker 自己失败了，结果不可信，不会自动合；查一下再 self_edit，或写一句理由 discard。",
  post_boot_failed: "合进去之后启动自检没过，supervisor 已经回滚到 known-good；这个提案算失败，别当它生效，查一下再 self_edit。",
  experience_failed: "合进去之后 experience 脚本没过，supervisor 已经回滚到 known-good；这个提案算失败，别当它生效，查一下再 self_edit。",
}

const OLD_OPEN = `${LEAD} 验证全绿（老提案没记 reason），可以 apply_proposal 合入，合完再跑一遍验证。`

const OLD_FAILED = `${LEAD} 没有记录失败原因（老提案），不确定能不能合；看一眼 diff 和测试再决定 apply 还是 discard。`

function proposal(patch: Partial<Proposal> = {}): Proposal {
  return {
    id: ID,
    branch: `self/${ID}`,
    base: "main",
    task: "add the answer file",
    status: "failed",
    createdAt: NOW.toISOString(),
    ...patch,
  }
}

test("each reason code gets its own wake sentence", () => {
  const reasons: ProposalReason[] = [
    "green",
    "verification_failed",
    "no_changes",
    "timeout",
    "worker_failed",
    "post_boot_failed",
    "experience_failed",
  ]
  const seen = new Set<string>()
  for (const reason of reasons) {
    assert.equal(proposalWakeText(JOB, proposal({ reason })), `${LEAD} ${SENTENCE[reason]}`)
    seen.add(SENTENCE[reason])
  }
  assert.equal(seen.size, reasons.length, "the seven reasons must not share one sentence")
})

test("the wake sentence follows the reason code, never the error text", () => {
  assert.equal(proposalWakeText(JOB, proposal({ reason: "no_changes", error: "" })), `${LEAD} ${SENTENCE.no_changes}`)
  assert.equal(
    proposalWakeText(JOB, proposal({ reason: "no_changes", error: "something else entirely" })),
    `${LEAD} ${SENTENCE.no_changes}`,
  )
  assert.equal(proposalWakeText(JOB, proposal({ reason: "timeout", error: "" })), `${LEAD} ${SENTENCE.timeout}`)
  assert.ok(!proposalWakeText(JOB, proposal({ reason: "timeout", error: "" })).includes("验证没过"))
  assert.equal(
    proposalWakeText(JOB, proposal({ reason: "verification_failed", error: NO_CHANGES_ERROR })),
    `${LEAD} ${SENTENCE.verification_failed}`,
  )
  assert.equal(
    proposalWakeText(JOB, proposal({ status: "open", reason: "green", error: VERIFICATION_FAILED_ERROR })),
    `${LEAD} ${SENTENCE.green}`,
  )
  assert.ok(!proposalWakeText(JOB, proposal({ reason: "worker_failed", error: "" })).includes("空"))
})

test("an old proposal without a reason gets a generic sentence that names no cause", () => {
  assert.equal(proposalWakeText(JOB, proposal({ status: "open" })), OLD_OPEN)
  assert.equal(proposalWakeText(JOB, proposal({ status: "failed" })), OLD_FAILED)
  assert.equal(proposalWakeText(JOB, proposal({ status: "failed", reason: null })), OLD_FAILED)
  assert.ok(!OLD_FAILED.includes("全绿"))
  assert.ok(!OLD_FAILED.includes("验证没过"))
  assert.ok(!OLD_FAILED.includes("超时"))
})

test("a job whose proposal is applied, discarded or missing keeps the plain job wake", () => {
  assert.equal(wakeTextFor(JOB, undefined), wakeText(JOB))
  assert.equal(wakeTextFor(JOB, proposal({ status: "applied" })), wakeText(JOB))
  assert.equal(wakeTextFor(JOB, proposal({ status: "discarded" })), wakeText(JOB))
  assert.equal(wakeTextFor(JOB, proposal({ status: "open" })), proposalWakeText(JOB, proposal({ status: "open" })))
})
