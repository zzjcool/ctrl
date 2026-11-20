import type { DatabaseSync } from "node:sqlite"
import type { AgentMemory, MemoryEntry, MemoryHit, MemoryKind, MemoryQuery } from "../engine/durable.ts"
import {
  DEFAULT_MEMORY_LIMIT,
  LESSON_KIND,
  addMemory,
  isMemoryKind,
  searchMemoriesScored,
  type MemoryRow,
} from "./memories.ts"

const ENGINE_KINDS: readonly MemoryKind[] = ["fact", "preference", "event", "skill"]

export const LESSON_RECALL_BOOST = 1.2

export interface AgentMemoryInput {
  kind: MemoryKind
  text: string
  tags?: string[]

  salience?: number
}

export interface SqliteAgentMemoryOptions {

  db: DatabaseSync | undefined

  defaultLimit?: number
  now?: () => Date
  warn?: (message: string) => void
}

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
      const scored = searchMemoriesScored(db, query.text, {
        limit: limit * 3,
        ...(query.includeSuperseded === true ? { includeSuperseded: true } : {}),
        now: at,
      })
      const kinds = query.kinds === undefined ? undefined : new Set(query.kinds.filter(isEngineKind))
      return scored
        .filter((entry) => kinds === undefined || kinds.has(engineKind(entry.row.kind)))
        .map((entry) => ({
          row: entry.row,
          score: entry.score * (entry.row.kind === LESSON_KIND ? LESSON_RECALL_BOOST : 1),
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((hit) => ({ entry: toEntry(hit.row), score: hit.score }))
    },
  }
}

export function engineKind(kind: string): MemoryKind {
  return isEngineKind(kind) ? kind : "fact"
}

function isEngineKind(value: unknown): value is MemoryKind {
  return typeof value === "string" && (ENGINE_KINDS as readonly string[]).includes(value)
}

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
