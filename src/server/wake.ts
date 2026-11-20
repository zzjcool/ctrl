// Waking the agent when a worker finishes (B).
//
// A turn delegates and ends long before a real worker does; without this the
// agent simply never speaks again and the user has to ask "and?" — the exact
// hole `job_status`'s 8-second wait was built for on the other end.
//
// The rules, in the order they are applied:
//   * a job wakes the agent at most once, ever — `meta.json.notifiedAt` is the
//     record, so a restart does not replay an exit and the two ways a job can
//     be finalised (`exit` event, `stop()`) cannot both wake;
//   * a turn that is already running polls the job itself (CONTRACT §5), so we
//     do nothing — no queue, no second turn;
//   * the wake is an ordinary turn: a `user_message` with the fixed `[ctrl]`
//     prefix, then the same `runTurn` path `POST /api/agent/messages` takes.
//     It is not the user talking, so it does not go through HTTP and there is
//     no 409 to answer.
//
// The user_message is appended by `runAgent` itself (`session.appendUserMessage
// (input)` is the one append path a turn has); appending it here as well would
// put two identical lines in the log.

import { openSession } from "../engine/durable.ts"
import type { Session } from "../engine/durable.ts"
import { readJobMeta, updateJobMeta } from "../jobs/store.ts"
import type { JobView } from "../jobs/store.ts"
import { formatElapsed } from "../jobs/tools.ts"
import { LOG_ID } from "./agents.ts"
import { runTurn } from "./routes.ts"
import type { AppContext } from "./routes.ts"

/** Every wake message starts with this; a test (and a reader) can find it. */
export const WAKE_PREFIX = "[ctrl] worker"

/** `[ctrl] worker <id> finished (<state>, <elapsed>) — report the result to the user.` */
export function wakeText(job: JobView): string {
  return `${WAKE_PREFIX} ${job.id} finished (${job.state}, ${formatElapsed(job.elapsedMs)}) — report the result to the user.`
}

export interface Waker {
  /** The runner's `onExit` hook. Synchronous and never throwing. */
  notify(job: JobView): void
  /**
   * Stop waking: after the server closes, a late exit must not reopen the log
   * or start a turn against a closed memory database.
   */
  stop(): void
}

export function createWaker(ctx: AppContext): Waker {
  let stopped = false

  return {
    notify(job) {
      if (stopped) return
      if (!markNotified(ctx.agentHome, job.id)) return
      // Everything from here on runs in one synchronous slice, so the check and
      // the claim below cannot be interleaved by a POST /api/agent/messages.
      if (ctx.turns.isRunning(LOG_ID)) return
      let log: Session
      try {
        log = openSession(LOG_ID, { home: ctx.agentHome })
      } catch (error) {
        warn(`could not open the log to report job ${job.id}: ${errorMessage(error)}`)
        return
      }
      const text = wakeText(job)
      const started = ctx.turns.start(LOG_ID, (signal) => runTurn(ctx, log, text, signal))
      if (!started) {
        // Unreachable while notify stays synchronous; kept so a future await
        // in here degrades into "the turn that won polls the job" instead of a
        // second turn on the same log.
        warn(`job ${job.id} finished but a turn was already running — not waking twice`)
      }
    },
    stop() {
      stopped = true
    },
  }
}

/**
 * Claim the one wake this job is allowed. Returns false when it was already
 * claimed (or the job is gone). Written before the turn starts on purpose: a
 * failure after this point loses a wake, but can never double it.
 */
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
