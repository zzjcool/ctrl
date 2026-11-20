// The bridge between pi-durable's agent loop and ctrl's memory table (M3/M4 glue).
//
// MEMORY.md §2 replaced the engine's memory store with SQLite: `remember` and
// `recall` in the loop, `search_context` in the tools, the dream writer and the
// page's memory drawer all read and write *one* table. The engine, however,
// still asks for its own seam — `AgentMemory` in pi-durable/src/core/agent.ts:
//
//   remember({ kind, text, tags?, salience? }) -> MemoryEntry
//   recall({ text, limit?, kinds?, includeSuperseded? }) -> MemoryHit[]
//
// This file is that seam, backed by `memories` (./memories.ts). Without it the
// loop recalls from `memory/index.jsonl` while the dream writes SQLite, and a
// fact learned by dreaming is never recalled — the agent would forget its own
// memories.
//
// Two shape differences are handled here, not in the table:
//   * the engine knows four kinds (fact|preference|event|skill); MEMORY.md §4
//     adds `decision`. Recall maps `decision` → `fact` for the wire type (the
//     row keeps its kind), because `MemoryEntry.kind` is the engine's union;
//   * `salience` and `importance` are the same 0..1 knob, so they are aliases.
//
// Failure policy: a broken database answers `recall` with nothing (the turn goes
// on without memories) and lets `remember` throw a sentence the tool layer turns
// into `{ ok: false, output }` — a write that did not happen must not look like
// one that did.

import type { DatabaseSync } from "node:sqlite"
import type { AgentMemory, MemoryEntry, MemoryHit, MemoryKind, MemoryQuery } from "../engine/durable.ts"
import {
  DEFAULT_MEMORY_LIMIT,
  addMemory,
  isMemoryKind,
  memoryScore,
  searchMemories,
  type MemoryRow,
} from "./memories.ts"

/** The engine's four kinds; `decision` is ctrl's addition (MEMORY.md §4). */
const ENGINE_KINDS: readonly MemoryKind[] = ["fact", "preference", "event", "skill"]

export interface AgentMemoryInput {
  kind: MemoryKind
  text: string
  tags?: string[]
  /** The engine's `salience` is our `importance`. */
  salience?: number
}

export interface SqliteAgentMemoryOptions {
  /** `<agentHome>/memory.db` via `MemoryIndex.handle()`; undefined when degraded. */
  db: DatabaseSync | undefined
  /** Recall page size when the engine does not ask for one. */
  defaultLimit?: number
  now?: () => Date
  warn?: (message: string) => void
}

/**
 * `AgentMemory` over the `memories` table.
 *
 * `recall` searches text *and* tags through the same regimes `search_context`
 * uses (FTS5 trigram for three or more characters, `LIKE` below), ranks by
 * keyword hits × importance × recency and returns the engine's hit shape.
 */
export function createSqliteAgentMemory(opts: SqliteAgentMemoryOptions): AgentMemory {
  const now = opts.now ?? (() => new Date())
  const defaultLimit = Math.max(1, opts.defaultLimit ?? DEFAULT_MEMORY_LIMIT)
  let warned = false
  const warnOnce = (message: string): void => {
    if (warned) return
    warned = true
    opts.warn?.(message)
  }

  return {
    remember(input: AgentMemoryInput): MemoryEntry {
      const db = opts.db
      if (db === undefined) throw new Error("memory database unavailable: cannot remember anything right now")
      const kind = isMemoryKind(input.kind) ? input.kind : "fact"
      const written = addMemory(db, {
        text: input.text,
        kind,
        ...(input.tags !== undefined ? { tags: input.tags } : {}),
        ...(input.salience !== undefined ? { importance: input.salience } : {}),
        now: now(),
      })
      return toEntry(written.memory)
    },

    recall(query: MemoryQuery): MemoryHit[] {
      const db = opts.db
      if (db === undefined) {
        warnOnce("memory recall degraded: the memory database is not open")
        return []
      }
      const at = now()
      const limit = Math.max(1, Math.min(query.limit ?? defaultLimit, 100))
      const rows = searchMemories(db, query.text, {
        // Over-fetch when a kind filter is about to drop rows.
        limit: query.kinds === undefined ? limit : limit * 3,
        ...(query.includeSuperseded === true ? { includeSuperseded: true } : {}),
        now: at,
      })
      const kinds = query.kinds === undefined ? undefined : new Set(query.kinds.filter(isEngineKind))
      return rows
        .filter((row) => kinds === undefined || kinds.has(engineKind(row.kind)))
        .slice(0, limit)
        .map((row) => ({ entry: toEntry(row), score: memoryScore(row, at) }))
    },
  }
}

/** `decision` is not in the engine's union; the nearest engine kind is `fact`. */
export function engineKind(kind: string): MemoryKind {
  return isEngineKind(kind) ? kind : "fact"
}

function isEngineKind(value: unknown): value is MemoryKind {
  return typeof value === "string" && (ENGINE_KINDS as readonly string[]).includes(value)
}

/**
 * A `memories` row as the engine's `MemoryEntry`.
 *
 * `seq` is where the memory came from (`source_to`, or `source_from`), so a
 * recalled entry can be traced back into the log; `ts` is when it was last
 * written, which is what the recency half of the score already used.
 */
export function toEntry(row: MemoryRow): MemoryEntry {
  return {
    id: row.id,
    seq: row.sourceTo ?? row.sourceFrom ?? 0,
    ts: row.updatedAt !== "" ? row.updatedAt : row.createdAt,
    kind: engineKind(row.kind),
    text: row.text,
    tags: row.tags,
    salience: row.importance,
    ...(row.supersededBy !== undefined ? { supersededBy: row.supersededBy } : {}),
  }
}
