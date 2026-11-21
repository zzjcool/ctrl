import { openSession } from "../engine/durable.ts"
import type { Session } from "../engine/durable.ts"
import { readJobMeta, updateJobMeta } from "../jobs/store.ts"
import type { JobView } from "../jobs/store.ts"
import { formatElapsed } from "../jobs/tools.ts"
import { getProposalByJob } from "../memory/proposals.ts"
import type { Proposal, ProposalReason } from "../memory/proposals.ts"
import { LOG_ID } from "./agents.ts"
import { runTurn } from "./routes.ts"
import type { AppContext } from "./routes.ts"

export const WAKE_PREFIX = "[ctrl] worker"

export const PROPOSAL_WAKE_PREFIX = "[ctrl]"

const REASON_WAKE_TEXT: Record<ProposalReason, string> = {
  green: "全绿——直接 apply_proposal 合入，合完再跑一遍验证。",
  verification_failed: "验证没过，不会自动合；让它改到全绿，或写一句理由 discard。",
  no_changes: "worker 没改出任何东西，没什么可合的；要改就重新 self_edit。",
  timeout: "跑太久被停掉了，结果不完整，不会自动合；拆小一点重新 self_edit，或写一句理由 discard。",
  worker_failed: "worker 自己失败了，结果不可信，不会自动合；查一下再 self_edit，或写一句理由 discard。",
  post_boot_failed: "合进去之后启动自检没过，supervisor 已经回滚到 known-good；这个提案算失败，别当它生效，查一下再 self_edit。",
  experience_failed: "合进去之后 experience 脚本没过，supervisor 已经回滚到 known-good；这个提案算失败，别当它生效，查一下再 self_edit。",
}

const UNKNOWN_REASON_TEXT = "没有记录失败原因（老提案），不确定能不能合；看一眼 diff 和测试再决定 apply 还是 discard。"

const UNKNOWN_REASON_OPEN_TEXT = "验证全绿（老提案没记 reason），可以 apply_proposal 合入，合完再跑一遍验证。"

export function wakeText(job: JobView): string {
  return `${WAKE_PREFIX} ${job.id} finished (${job.state}, ${formatElapsed(job.elapsedMs)}) — report the result to the user.`
}

export function proposalWakeText(job: JobView, proposal: Proposal): string {
  const lead = `${PROPOSAL_WAKE_PREFIX} ${job.id} finished → proposal ${proposal.id}`
  const reason = proposal.reason ?? null
  if (reason !== null) return `${lead} ${REASON_WAKE_TEXT[reason]}`
  if (proposal.status === "open") return `${lead} ${UNKNOWN_REASON_OPEN_TEXT}`
  return `${lead} ${UNKNOWN_REASON_TEXT}`
}

export function wakeTextFor(job: JobView, proposal: Proposal | undefined): string {
  if (proposal === undefined) return wakeText(job)
  if (proposal.status !== "open" && proposal.status !== "failed") return wakeText(job)
  return proposalWakeText(job, proposal)
}

export interface Waker {

  notify(job: JobView): void

  stop(): void
}

export function createWaker(ctx: AppContext): Waker {
  let stopped = false

  return {
    notify(job) {
      if (stopped) return
      if (!markNotified(ctx.agentHome, job.id)) return

      if (ctx.turns.isRunning(LOG_ID)) return
      let log: Session
      try {
        log = openSession(LOG_ID, { home: ctx.agentHome })
      } catch (error) {
        warn(`could not open the log to report job ${job.id}: ${errorMessage(error)}`)
        return
      }
      const text = wakeTextFor(job, proposalForJob(ctx, job.id))
      const started = ctx.turns.start(LOG_ID, (signal) => runTurn(ctx, log, text, signal, "wake"))
      if (!started) {

        warn(`job ${job.id} finished but a turn was already running — not waking twice`)
      }
    },
    stop() {
      stopped = true
    },
  }
}

function proposalForJob(ctx: AppContext, jobId: string): Proposal | undefined {
  const db = ctx.memory.handle()
  if (db === undefined) return undefined
  try {
    return getProposalByJob(db, jobId)
  } catch (error) {
    warn(`could not look up the proposal for job ${jobId}: ${errorMessage(error)}`)
    return undefined
  }
}

function markNotified(agentHome: string, id: string): boolean {
  const meta = readJobMeta(agentHome, id)
  if (meta === undefined) return false
  if (meta.notifiedAt !== undefined && meta.notifiedAt !== "") return false
  try {
    updateJobMeta(agentHome, id, { notifiedAt: new Date().toISOString() })
  } catch (error) {
    warn(`could not record the wake for job ${id}: ${errorMessage(error)}`)
    return false
  }
  return true
}

function warn(message: string): void {
  process.stderr.write(`ctrl: ${message}\n`)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
