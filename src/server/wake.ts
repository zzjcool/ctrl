import { openSession } from "../engine/durable.ts"
import type { Session } from "../engine/durable.ts"
import { readJobMeta, updateJobMeta } from "../jobs/store.ts"
import type { JobView } from "../jobs/store.ts"
import { formatElapsed } from "../jobs/tools.ts"
import { LOG_ID } from "./agents.ts"
import { runTurn } from "./routes.ts"
import type { AppContext } from "./routes.ts"

export const WAKE_PREFIX = "[ctrl] worker"

export function wakeText(job: JobView): string {
  return `${WAKE_PREFIX} ${job.id} finished (${job.state}, ${formatElapsed(job.elapsedMs)}) — report the result to the user.`
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
      const text = wakeText(job)
      const started = ctx.turns.start(LOG_ID, (signal) => runTurn(ctx, log, text, signal))
      if (!started) {

        warn(`job ${job.id} finished but a turn was already running — not waking twice`)
      }
    },
    stop() {
      stopped = true
    },
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
