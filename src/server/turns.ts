// One turn per session, started and not awaited (CONTRACT §8).
//
// A turn outlives the HTTP request that started it and outlives the tab that
// was watching. The registry therefore holds the only mutable state about
// "is something running right now", and it is deliberately in memory: crash
// recovery is pi-durable's job, derived from the event log, not from here.

import type { LlmClient, LlmCompleteRequest, LlmResponse } from "../engine/durable.ts"

export interface TurnState {
  running: boolean
  startedAt?: string
  error?: string
  aborted?: boolean
}

interface TurnEntry {
  controller: AbortController
  startedAt: string
  running: boolean
  error?: string
  aborted: boolean
  done: Promise<void>
}

export class TurnRegistry {
  private readonly entries = new Map<string, TurnEntry>()

  /**
   * Claim the session's single turn slot and run it in the background.
   * Returns false when a turn is already running — the caller turns that into
   * 409. Never rejects: a failure is recorded on the turn, not thrown.
   */
  start(sessionId: string, run: (signal: AbortSignal) => Promise<void>): boolean {
    const existing = this.entries.get(sessionId)
    if (existing?.running) return false

    const controller = new AbortController()
    const entry: TurnEntry = {
      controller,
      startedAt: new Date().toISOString(),
      running: true,
      aborted: false,
      done: Promise.resolve(),
    }
    this.entries.set(sessionId, entry)
    entry.done = (async () => {
      try {
        await run(controller.signal)
      } catch (error) {
        // Errors live here and only here; the session log is pi-durable's to
        // write (it already wrote one for a failed model call).
        entry.error = errorMessage(error)
      } finally {
        entry.running = false
      }
    })()
    return true
  }

  /** Ask the running turn to stop. Returns false when nothing was running. */
  abort(sessionId: string): boolean {
    const entry = this.entries.get(sessionId)
    if (!entry?.running) return false
    entry.aborted = true
    entry.controller.abort()
    return true
  }

  isRunning(sessionId: string): boolean {
    return this.entries.get(sessionId)?.running === true
  }

  state(sessionId: string): TurnState {
    const entry = this.entries.get(sessionId)
    if (!entry) return { running: false }
    if (entry.running) return { running: true, startedAt: entry.startedAt }
    return {
      running: false,
      ...(entry.error !== undefined ? { error: entry.error } : {}),
      ...(entry.aborted ? { aborted: true } : {}),
    }
  }

  /** Await the last turn of a session (tests and graceful shutdown). */
  async settled(sessionId: string): Promise<void> {
    const entry = this.entries.get(sessionId)
    if (entry) await entry.done
  }

  /** Abort and await every running turn. */
  async shutdown(): Promise<void> {
    const running = [...this.entries.values()].filter((entry) => entry.running)
    for (const entry of running) {
      entry.aborted = true
      entry.controller.abort()
    }
    await Promise.allSettled(running.map((entry) => entry.done))
  }
}

/**
 * Inject the abort signal into every model call (CONTRACT §8): the engine does
 * not pass one, and wrapping `complete` is the whole trick — no engine change.
 */
export function createAbortableLlm(base: LlmClient, signal: AbortSignal): LlmClient {
  return {
    model: base.model,
    complete(req: LlmCompleteRequest): Promise<LlmResponse> {
      return base.complete({ ...req, signal })
    },
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
