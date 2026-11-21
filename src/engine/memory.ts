import { mkdirSync, writeFileSync } from "node:fs"
import type { DurablePaths } from "./log.ts"
import {
  appendRecord,
  isMemoryEntry,
  newId,
  readMemories,
  readRecords,
  readRecordsWithStats,
  resolvePaths,
  syncMemories,
} from "./log.ts"
import type { MemoryEntry, MemoryHit, MemoryKind, MemoryQuery } from "./types.ts"

const DAY_MS = 24 * 60 * 60 * 1000
const RECENCY_HALF_LIFE_MS = 30 * DAY_MS
const SALIENCE_WEIGHT = 0.1
const RECENCY_WEIGHT = 0.1
const BM25_K1 = 1.2
const BM25_B = 0.75
const BM25_DELTA = 0.5

export interface MemoryInput {
  kind: MemoryKind
  text: string
  tags?: string[]
  salience?: number
}

export interface MemoryStore {
  add(input: MemoryInput): MemoryEntry
  supersede(id: string, replacement: MemoryInput): MemoryEntry
  search(query: MemoryQuery): MemoryHit[]
  all(opts?: { includeSuperseded?: boolean }): MemoryEntry[]
  get(id: string): MemoryEntry | undefined
  count(): number
}

function tokenize(value: string): string[] {
  const segments = value.toLowerCase().match(/[a-z0-9]+|[\u3400-\u4DBF\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF\uF900-\uFAFF]+/g) ?? []
  const tokens: string[] = []
  for (const segment of segments) {
    if (/^[a-z0-9]+$/.test(segment)) {
      if (segment.length >= 2) tokens.push(segment)
      continue
    }
    for (let index = 0; index < segment.length; index++) {
      tokens.push(segment[index]!)
      if (index + 1 < segment.length) tokens.push(segment.slice(index, index + 2))
    }
  }
  return tokens
}

function isMemoryKind(value: unknown): value is MemoryKind {
  return value === "fact" || value === "preference" || value === "event" || value === "skill" || value === "lesson"
}


function physicalCount(paths: DurablePaths): number {
  const stats = readRecordsWithStats<unknown>(paths.memoryLog)
  return stats.records.length + stats.skipped
}

function replay(paths: DurablePaths): MemoryEntry[] {
  const indexed = readMemories(paths)
  if (indexed !== undefined) return indexed
  const latestById = new Map<string, MemoryEntry>()
  for (const record of readRecords<unknown>(paths.memoryLog)) {
    if (!isMemoryEntry(record)) continue
    latestById.set(record.id, record)
  }
  return [...latestById.values()]
    .sort((left, right) => left.seq - right.seq || left.id.localeCompare(right.id))
    .map((entry, seq) => ({ ...entry, seq }))
}

function writeMeta(paths: DurablePaths, entries: MemoryEntry[]): void {
  try {
    mkdirSync(paths.memory, { recursive: true })
    writeFileSync(paths.memoryMeta, `${JSON.stringify({ lastSeq: entries.length - 1 })}\n`, "utf8")
  } catch {

  }
}

function validateInput(input: MemoryInput): void {
  if (!isMemoryKind(input.kind)) throw new TypeError(`Invalid memory kind: ${String(input.kind)}`)
  if (typeof input.text !== "string" || input.text.trim() === "") {
    throw new TypeError("Memory text must be a non-empty string")
  }
  if (input.tags !== undefined && (!Array.isArray(input.tags) || input.tags.some((tag) => typeof tag !== "string"))) {
    throw new TypeError("Memory tags must be strings")
  }
  if (input.salience !== undefined && (!Number.isFinite(input.salience) || input.salience < 0 || input.salience > 1)) {
    throw new RangeError("Memory salience must be between 0 and 1")
  }
}

function createEntry(input: MemoryInput, seq: number, ts: string): MemoryEntry {
  validateInput(input)
  return {
    id: newId(),
    seq,
    ts,
    kind: input.kind,
    text: input.text.trim(),
    tags: [...new Set((input.tags ?? []).map((tag) => tag.trim()).filter(Boolean))],
    salience: input.salience ?? 0.5,
  }
}

export function createMemoryStore(paths: DurablePaths = resolvePaths()): MemoryStore {
  function nextTimestamp(entries: MemoryEntry[]): string {
    const newest = entries.reduce((max, entry) => {
      const parsed = Date.parse(entry.ts)
      return Number.isFinite(parsed) ? Math.max(max, parsed) : max
    }, Number.NEGATIVE_INFINITY)
    const now = Date.now()
    return new Date(Number.isFinite(newest) ? Math.max(now, newest + 1) : now).toISOString()
  }

  function add(input: MemoryInput): MemoryEntry {
    const entries = replay(paths)

    const seq = physicalCount(paths)
    const entry = createEntry(input, seq, nextTimestamp(entries))
    appendRecord(paths.memoryLog, entry)
    const updated = [...entries, entry]
      .sort((left, right) => left.seq - right.seq || left.id.localeCompare(right.id))
      .map((value, index) => ({ ...value, seq: index }))
    writeMeta(paths, updated)
    syncMemories(paths, updated)
    return entry
  }

  function supersede(id: string, replacement: MemoryInput): MemoryEntry {
    const entries = replay(paths)
    const previous = entries.find((entry) => entry.id === id)
    if (!previous) throw new Error(`Memory entry not found: ${id}`)
    if (previous.supersededBy) throw new Error(`Memory entry already superseded: ${id}`)

    const next = createEntry(replacement, physicalCount(paths), nextTimestamp(entries))
    appendRecord(paths.memoryLog, { ...previous, supersededBy: next.id })
    appendRecord(paths.memoryLog, next)
    const updated = entries
      .map((entry) => entry.id === previous.id ? { ...previous, supersededBy: next.id } : entry)
      .concat(next)
      .sort((left, right) => left.seq - right.seq || left.id.localeCompare(right.id))
      .map((value, index) => ({ ...value, seq: index }))
    writeMeta(paths, updated)
    syncMemories(paths, updated)
    return next
  }

  function all(opts: { includeSuperseded?: boolean } = {}): MemoryEntry[] {
    const entries = replay(paths)
    return opts.includeSuperseded ? entries : entries.filter((entry) => !entry.supersededBy)
  }

  function search(query: MemoryQuery): MemoryHit[] {
    const entries = all({ includeSuperseded: query.includeSuperseded })
      .filter((entry) => !query.kinds || query.kinds.includes(entry.kind))
    const queryTokens = tokenize(query.text)
    const indexed = entries.map((entry) => {
      const textTokens = tokenize(entry.text)
      const tagTokens = new Set(entry.tags.flatMap(tokenize))
      const frequencies = new Map<string, number>()
      for (const token of textTokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1)
      for (const token of tagTokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 2)
      return { entry, textLength: textTokens.length, frequencies }
    })
    const documentCount = indexed.length
    const averageLength = documentCount === 0
      ? 0
      : indexed.reduce((total, document) => total + document.textLength, 0) / documentCount
    const documentFrequency = new Map<string, number>()
    for (const document of indexed) {
      for (const token of document.frequencies.keys()) {
        documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1)
      }
    }
    const referenceTime = entries.reduce((newest, entry) => {
      const parsed = Date.parse(entry.ts)
      return Number.isFinite(parsed) ? Math.max(newest, parsed) : newest
    }, Number.NEGATIVE_INFINITY)
    const safeAverageLength = averageLength > 0 ? averageLength : 1

    const hits = indexed
      .map(({ entry, textLength, frequencies }): MemoryHit => {
        let keywordScore = 0
        for (const token of queryTokens) {
          const termFrequency = frequencies.get(token) ?? 0
          if (termFrequency === 0) continue
          const frequency = documentFrequency.get(token) ?? 0
          const idf = Math.log(1 + (documentCount - frequency + 0.5) / (frequency + 0.5))
          const lengthNormalization = BM25_K1 * (
            1 - BM25_B + BM25_B * textLength / safeAverageLength
          )
          keywordScore += idf * (
            BM25_DELTA + termFrequency * (BM25_K1 + 1) / (termFrequency + lengthNormalization)
          )
        }

        const parsedTime = Date.parse(entry.ts)
        const ageMs = Number.isFinite(parsedTime) && Number.isFinite(referenceTime)
          ? Math.max(0, referenceTime - parsedTime)
          : 0
        const recencyDecay = 2 ** (-ageMs / RECENCY_HALF_LIFE_MS)
        const additiveScore = keywordScore > 0
          ? SALIENCE_WEIGHT * entry.salience + RECENCY_WEIGHT * recencyDecay
          : 0
        return { entry, score: keywordScore + additiveScore }
      })
      .sort((left, right) =>
        right.score - left.score ||
        right.entry.seq - left.entry.seq ||
        left.entry.id.localeCompare(right.entry.id),
      )

    const limit = query.limit === undefined ? hits.length : Math.max(0, Math.floor(query.limit))
    return hits.slice(0, limit)
  }

  return {
    add,
    supersede,
    search,
    all,
    get(id) {
      return replay(paths).find((entry) => entry.id === id)
    },
    count() {
      return replay(paths).length
    },
  }
}
