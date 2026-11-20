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

        entry.error = errorMessage(error)
      } finally {
        entry.running = false
      }
    })()
    return true
  }

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

  async settled(sessionId: string): Promise<void> {
    const entry = this.entries.get(sessionId)
    if (entry) await entry.done
  }

  async shutdown(): Promise<void> {
    const running = [...this.entries.values()].filter((entry) => entry.running)
    for (const entry of running) {
      entry.aborted = true
      entry.controller.abort()
    }
    await Promise.allSettled(running.map((entry) => entry.done))
  }
}

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
