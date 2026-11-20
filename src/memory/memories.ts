// The memories table (MEMORY.md §4 §7) — what the agent *decided to keep*.
//
// events.jsonl is the log; this table is the part of memory that is not a log:
// a fact learned on day 3 is still true on day 40, and a fact that stopped
// being true is superseded rather than deleted (MEMORY.md §3.3 — the old row
// stays, pointing at the row that replaced it, so the change is auditable).
//
// Write discipline:
//   * text is normalised before it is compared, so "The workspace is /w" and
//     "the  workspace is /w." are one memory, not two;
//   * a duplicate never becomes a second row — it merges tags and keeps the
//     higher importance;
//   * nothing is deleted: DELETE writes `superseded_by = "deleted:<id>"`.
//
// Search discipline: the corpus here is a few thousand hand-curated sentences,
// not a log. A normalised substring scan in JS is exact for 1–2 character CJK
// queries (which trigram FTS5 cannot answer at all, MEMORY.md §4) and it is
// the same code for every query length. `memories_fts` is therefore left
// unwritten on purpose until M5 needs ranking it can trust; see the report.

import type { DatabaseSync } from "node:sqlite"
import { charLength, clipChars, isRecord } from "./events.ts"

/** MEMORY.md §4: fact|preference|decision|event|skill. */
export const MEMORY_KINDS = ["fact", "preference", "decision", "event", "skill"] as const
export type MemoryKindName = (typeof MEMORY_KINDS)[number]
export const DEFAULT_MEMORY_KIND: MemoryKindName = "fact"
export const DEFAULT_IMPORTANCE = 0.5
export const DEFAULT_CONFIDENCE = 0.8
/** One memory is a sentence, not a document. */
export const MAX_MEMORY_TEXT = 2_000
export const DEFAULT_MEMORY_LIMIT = 20
export const MAX_MEMORY_LIMIT = 100
/** `superseded_by` for a tombstone (MEMORY.md §10.1 DELETE /api/memories/:id). */
export const TOMBSTONE_PREFIX = "deleted:"
/** Recency half-life of the recall score, in days (MEMORY.md §5). */
const RECENCY_HALF_LIFE_DAYS = 30

export interface MemoryRow {
  id: string
  kind: string
  text: string
  tags: string[]
  importance: number
  confidence: number
  createdAt: string
  updatedAt: string
  /** Non-empty means the row is history: a superseded fact, or a tombstone. */
  supersededBy?: string
  sourceFrom?: number
  sourceTo?: number
}

export interface AddMemoryInput {
  text: string
  kind?: string
  tags?: string[]
  importance?: number
  confidence?: number
  /** Event seqs this memory came from (MEMORY.md §4 source_from/source_to). */
  sourceSeqs?: number[]
  /** Only tests and the dream writer pass this; production ids are generated. */
  id?: string
  now?: Date
}

export interface AddMemoryResult {
  memory: MemoryRow
  /** False when an equivalent memory already existed — it was merged, not added. */
  created: boolean
}

export interface ListMemoriesOptions {
  /** Free-text filter; empty/undefined lists by importance and recency. */
  query?: string
  limit?: number
  /** Include superseded rows and tombstones (MEMORY.md `GET /api/memories?all=`). */
  includeSuperseded?: boolean
  now?: Date
}

export function isMemoryKind(value: unknown): value is MemoryKindName {
  return typeof value === "string" && (MEMORY_KINDS as readonly string[]).includes(value)
}

/** A kind the model suggested, or undefined when it is not one of the five. */
export function cleanKindHint(value: unknown): MemoryKindName | undefined {
  if (typeof value !== "string") return undefined
  const kind = value.trim().toLowerCase()
  return isMemoryKind(kind) ? kind : undefined
}

/**
 * The comparison form of a memory's text: NFKC, case-folded, whitespace
 * collapsed, trailing sentence punctuation dropped. Deliberately conservative —
 * nothing here should ever merge two memories that say different things.
 */
export function normalizeMemoryText(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[\s.。!！,，;；:：、]+$/u, "")
    .trim()
}

/** `mem-<base36 ms>-<base36 random>`: sortable, short, collision-free enough. */
export function newMemoryId(now: Date = new Date()): string {
  const stamp = Math.max(0, now.getTime()).toString(36)
  const random = Math.floor(Math.random() * 36 ** 4)
    .toString(36)
    .padStart(4, "0")
  return `mem-${stamp}-${random}`
}

/**
 * Write one memory (MEMORY.md §7.2). A normalised duplicate is merged into the
 * existing live row instead of being inserted twice; the returned `created`
 * flag is what the dream run counts as added vs merged.
 */
export function addMemory(db: DatabaseSync, input: AddMemoryInput): AddMemoryResult {
  const text = clipChars(String(input.text ?? "").trim(), MAX_MEMORY_TEXT)
  if (text === "") throw new Error("memory text must be a non-empty string")
  const now = input.now ?? new Date()
  const stamp = now.toISOString()
  const kind = isMemoryKind(input.kind) ? input.kind : DEFAULT_MEMORY_KIND
  const tags = cleanTags(input.tags)
  const importance = clamp01(input.importance, DEFAULT_IMPORTANCE)
  const seqs = cleanSeqs(input.sourceSeqs)

  const duplicate = findDuplicate(db, text)
  if (duplicate !== undefined) {
    // Merge, never duplicate: tags union, importance max, tags of the new
    // claim are what made it worth saying again.
    const mergedTags = cleanTags([...duplicate.tags, ...tags])
    const mergedImportance = Math.max(duplicate.importance, importance)
    db.prepare("UPDATE memories SET tags = ?, importance = ?, updated_at = ? WHERE id = ?").run(
      JSON.stringify(mergedTags),
      mergedImportance,
      stamp,
      duplicate.id,
    )
    const row = getMemory(db, duplicate.id) ?? duplicate
    return { memory: row, created: false }
  }

  const requestedId = typeof input.id === "string" ? input.id.trim() : ""
  const id = requestedId !== "" ? requestedId : newMemoryId(now)
  db.prepare(
    "INSERT INTO memories(id, kind, text, tags, importance, confidence, created_at, updated_at, superseded_by, source_from, source_to) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)",
  ).run(
    id,
    kind,
    text,
    JSON.stringify(tags),
    importance,
    clamp01(input.confidence, DEFAULT_CONFIDENCE),
    stamp,
    stamp,
    seqs[0] ?? null,
    seqs[1] ?? null,
  )
  return { memory: getMemory(db, id) as MemoryRow, created: true }
}

/** One row by id, superseded or not; undefined when the id is unknown. */
export function getMemory(db: DatabaseSync, id: string): MemoryRow | undefined {
  const row = db.prepare("SELECT * FROM memories WHERE id = ?").get(id)
  return row === undefined ? undefined : mapRow(row)
}

/**
 * `GET /api/memories` (MEMORY.md §10.1): live rows by default, filtered and
 * ranked when a query is given.
 */
export function listMemories(db: DatabaseSync, opts: ListMemoriesOptions = {}): MemoryRow[] {
  const limit = clampLimit(opts.limit)
  const query = (opts.query ?? "").trim()
  const rows = selectRows(db, opts.includeSuperseded === true)
  if (query === "") {
    return sortByWeight(rows, opts.now ?? new Date()).slice(0, limit)
  }
  return rank(rows, query, opts.now ?? new Date()).slice(0, limit)
}

/** Relevance-filtered search — the dream writer's "top existing memories". */
export function searchMemories(db: DatabaseSync, query: string, opts: ListMemoriesOptions = {}): MemoryRow[] {
  const limit = clampLimit(opts.limit)
  const trimmed = query.trim()
  if (trimmed === "") return sortByWeight(selectRows(db, false), opts.now ?? new Date()).slice(0, limit)
  return rank(selectRows(db, false), trimmed, opts.now ?? new Date()).slice(0, limit)
}

/** How many memories are live (the number `GET /api/agent` reports). */
export function liveMemoryCount(db: DatabaseSync): number {
  const row = db.prepare("SELECT count(*) AS n FROM memories WHERE superseded_by IS NULL").get()
  return asInteger(row?.n) ?? 0
}

/**
 * Supersede an old row with a new one (MEMORY.md §3.3). The old row stays —
 * `superseded_by` is the pointer that makes the change auditable.
 */
export function supersedeMemory(db: DatabaseSync, oldId: string, newId: string, now: Date = new Date()): boolean {
  if (oldId === "" || newId === "" || oldId === newId) return false
  const result = db
    .prepare("UPDATE memories SET superseded_by = ?, updated_at = ? WHERE id = ? AND superseded_by IS NULL")
    .run(newId, now.toISOString(), oldId)
  return asInteger(result.changes) !== undefined && (asInteger(result.changes) ?? 0) > 0
}

/** Tombstone, never a physical delete (MEMORY.md §10.1). */
export function tombstoneMemory(db: DatabaseSync, id: string, now: Date = new Date()): MemoryRow | undefined {
  const existing = getMemory(db, id)
  if (existing === undefined || existing.supersededBy !== undefined) return undefined
  db.prepare("UPDATE memories SET superseded_by = ?, updated_at = ? WHERE id = ?").run(
    `${TOMBSTONE_PREFIX}${id}`,
    now.toISOString(),
    id,
  )
  return getMemory(db, id)
}

/** Edit a live row in place: text, tags, importance (MEMORY.md M4 "改一条错记忆"). */
export function updateMemory(
  db: DatabaseSync,
  id: string,
  patch: { text?: string; tags?: string[]; importance?: number; kind?: string },
  now: Date = new Date(),
): MemoryRow | undefined {
  const existing = getMemory(db, id)
  if (existing === undefined || existing.supersededBy !== undefined) return undefined
  const text = patch.text === undefined ? existing.text : clipChars(patch.text.trim(), MAX_MEMORY_TEXT)
  if (text === "") throw new Error("memory text must be a non-empty string")
  const tags = patch.tags === undefined ? existing.tags : cleanTags(patch.tags)
  const importance = patch.importance === undefined ? existing.importance : clamp01(patch.importance, existing.importance)
  const kind = isMemoryKind(patch.kind) ? patch.kind : existing.kind
  db.prepare("UPDATE memories SET text = ?, tags = ?, importance = ?, kind = ?, updated_at = ? WHERE id = ?").run(
    text,
    JSON.stringify(tags),
    importance,
    kind,
    now.toISOString(),
    id,
  )
  return getMemory(db, id)
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

function selectRows(db: DatabaseSync, includeSuperseded: boolean): MemoryRow[] {
  const sql = includeSuperseded
    ? "SELECT * FROM memories ORDER BY importance DESC, updated_at DESC, id"
    : "SELECT * FROM memories WHERE superseded_by IS NULL ORDER BY importance DESC, updated_at DESC, id"
  return (db.prepare(sql).all() as unknown[]).map((row) => mapRow(row))
}

/** A live memory whose normalised text equals this one's; the dedupe rule. */
function findDuplicate(db: DatabaseSync, text: string): MemoryRow | undefined {
  const wanted = normalizeMemoryText(text)
  if (wanted === "") return undefined
  for (const row of selectRows(db, false)) {
    if (normalizeMemoryText(row.text) === wanted) return row
  }
  return undefined
}

/**
 * Rank rows against a query: keyword hits × importance × recency, the same
 * three factors MEMORY.md §5 names. Rows that match nothing are dropped, so a
 * query is a filter and not decoration.
 */
function rank(rows: MemoryRow[], query: string, now: Date): MemoryRow[] {
  const words = keywords(query)
  const scored: Array<{ row: MemoryRow; score: number }> = []
  for (const row of rows) {
    const haystack = normalizeMemoryText(row.text)
    let hits = 0
    for (const word of words) {
      if (word !== "" && haystack.includes(word)) hits += charLength(word)
    }
    if (hits === 0) continue
    scored.push({ row, score: hits * weight(row, now) })
  }
  scored.sort((a, b) => b.score - a.score || b.row.importance - a.row.importance)
  return scored.map((entry) => entry.row)
}

function sortByWeight(rows: MemoryRow[], now: Date): MemoryRow[] {
  return [...rows].sort((a, b) => weight(b, now) - weight(a, now))
}

/** (0.5 + importance) × recency: importance is the cheap knob, time decays it. */
function weight(row: MemoryRow, now: Date): number {
  return (0.5 + row.importance) * recency(row.updatedAt, now)
}

function recency(iso: string, now: Date): number {
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return 1
  const days = Math.max(0, (now.getTime() - at) / 86_400_000)
  return Math.pow(0.5, days / RECENCY_HALF_LIFE_DAYS)
}

/** Words worth matching: split on punctuation/space, keep CJK runs whole. */
export function keywords(query: string): string[] {
  return normalizeMemoryText(query)
    .split(/[\s,.!?;:'"()[\]{}<>|/\\，。！？；：、“”‘’（）【】《》—–…]+/u)
    .filter((word) => word !== "")
}

function mapRow(raw: unknown): MemoryRow {
  const row = isRecord(raw) ? raw : {}
  const created = asString(row.created_at) ?? ""
  return {
    id: asString(row.id) ?? "",
    kind: asString(row.kind) ?? DEFAULT_MEMORY_KIND,
    text: asString(row.text) ?? "",
    tags: parseTags(asString(row.tags)),
    importance: asNumber(row.importance) ?? DEFAULT_IMPORTANCE,
    confidence: asNumber(row.confidence) ?? DEFAULT_CONFIDENCE,
    createdAt: created,
    updatedAt: asString(row.updated_at) ?? created,
    ...(asString(row.superseded_by) !== undefined ? { supersededBy: asString(row.superseded_by) as string } : {}),
    ...(asInteger(row.source_from) !== undefined ? { sourceFrom: asInteger(row.source_from) as number } : {}),
    ...(asInteger(row.source_to) !== undefined ? { sourceTo: asInteger(row.source_to) as number } : {}),
  }
}

function parseTags(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === "") return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === "string") : []
  } catch {
    return []
  }
}

function cleanTags(tags: string[] | undefined): string[] {
  if (tags === undefined) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const tag of tags) {
    if (typeof tag !== "string") continue
    const clean = tag.trim().slice(0, 64)
    if (clean === "" || seen.has(clean)) continue
    seen.add(clean)
    out.push(clean)
    if (out.length >= 12) break
  }
  return out
}

function cleanSeqs(seqs: number[] | undefined): number[] {
  if (seqs === undefined) return []
  const clean = seqs.filter((seq) => Number.isFinite(seq)).map((seq) => Math.trunc(seq))
  if (clean.length === 0) return []
  return [Math.min(...clean), Math.max(...clean)]
}

function clampLimit(value: unknown): number {
  const parsed = asNumber(value)
  if (parsed === undefined) return DEFAULT_MEMORY_LIMIT
  return Math.max(1, Math.min(Math.trunc(parsed), MAX_MEMORY_LIMIT))
}

function clamp01(value: unknown, fallback: number): number {
  const parsed = asNumber(value)
  if (parsed === undefined) return fallback
  return Math.max(0, Math.min(1, parsed))
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "bigint") return Number(value)
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value)) return Number(value)
  return undefined
}

function asInteger(value: unknown): number | undefined {
  const parsed = asNumber(value)
  return parsed === undefined ? undefined : Math.trunc(parsed)
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string") return value
  if (value === null || value === undefined) return undefined
  if (typeof value === "number" || typeof value === "bigint") return String(value)
  return undefined
}
