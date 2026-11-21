import { openSession } from "../engine/durable.ts"
import type { Session } from "../engine/durable.ts"
import { readJobMeta, updateJobMeta } from "../jobs/store.ts"
import type { JobView } from "../jobs/store.ts"
import { formatElapsed } from "../jobs/tools.ts"
import { NO_CHANGES_ERROR, getProposalByJob } from "../memory/proposals.ts"
import type { Proposal } from "../memory/proposals.ts"
import { LOG_ID } from "./agents.ts"
import { runTurn } from "./routes.ts"
import type { AppContext } from "./routes.ts"

export const WAKE_PREFIX = "[ctrl] worker"

export const PROPOSAL_WAKE_PREFIX = "[ctrl]"

export function wakeText(job: JobView): string {
  return `${WAKE_PREFIX} ${job.id} finished (${job.state}, ${formatElapsed(job.elapsedMs)}) — report the result to the user.`
}

export function proposalWakeText(job: JobView, proposal: Proposal): string {
  const lead = `${PROPOSAL_WAKE_PREFIX} ${job.id} finished → proposal ${proposal.id}`
  if (proposal.status === "open") {
    return `${lead} is green. Apply it now with apply_proposal, then verify.`
  }
  if (proposal.error !== undefined && proposal.error.includes(NO_CHANGES_ERROR)) {
    return `${lead} produced no changes; nothing to apply.`
  }
  return `${lead} failed verification. Fix it (self_edit again) or discard it with a one-line reason — decide now.`
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
