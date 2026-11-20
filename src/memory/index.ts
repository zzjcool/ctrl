// The event mirror and the search over it (MEMORY.md §4 §10, contract M1).
//
// events.jsonl is the truth (MEMORY.md §3.1). This file derives a searchable
// copy of it in `<agentHome>/memory.db` and answers `search_context` / `/api/search`
// from that copy. Nothing here writes to the log, and nothing here decides what
// the model sees — it hands back timestamped snippets and seq numbers, and the
// model (or the page) reads them.
//
// Two search regimes, because SQLite's trigram tokenizer needs three characters
// (MEMORY.md §4, measured):
//
//   query >= 3 code points   FTS5 MATCH, quoted, ordered by bm25 (small = good)
//   query  < 3 code points   substring scan, newest first (`LIKE` semantics)
//
// The fallback scans `events` in chunks and builds the body in JS instead of
// issuing `LIKE` in SQL: the body lives in `events.data` as JSON, and a second
// copy of "how a body is built" written in SQL would drift from the one used
// for indexing. One implementation, two consumers.
//
// Failure policy (MEMORY.md §12, task M1 §8): a database that will not open, or
// an import that throws, must never stop the server or a turn. `createMemoryIndex`
// reports the problem once on stderr and answers every search with `[]`.

import { readFileSync } from "node:fs"
import type { DatabaseSync } from "node:sqlite"
import {
  META_LAST_INDEXED_SEQ,
  lastIndexedSeq,
  memoryDbPath,
  openMemoryDb,
  writeMeta,
} from "./db.ts"

/** Default page size for a search (`search_context` and `/api/search` agree). */
export const DEFAULT_SEARCH_LIMIT = 8
/** The model may ask for more, but not the whole log in one call. */
export const MAX_SEARCH_LIMIT = 20
/** A body is clipped before it is indexed — one long tool result must not eat the log. */
export const INDEX_BODY_LIMIT = 2_000
/** A hit's body is clipped again for the model: 400 chars, 120 of context before the match. */
export const SNIPPET_LIMIT = 400
export const SNIPPET_LEAD = 120
/** Code points; below this the trigram tokenizer cannot help (MEMORY.md §4). */
export const TRIGRAM_MIN_CHARS = 3

export interface MemoryHit {
  seq: number
  ts: string
  type: string
  /** The snippet, not the whole event. */
  body: string
  /** bm25(events_fts) for FTS hits (smaller is better); 0 for substring hits. */
  score: number
}

export interface SearchOptions {
  /** 1..MAX_SEARCH_LIMIT; default DEFAULT_SEARCH_LIMIT. */
  limit?: number
  /** Paging: only hits with `seq < beforeSeq`. */
  beforeSeq?: number
}

export interface ImportResult {
  /** Every record in the log, valid or not. */
  scanned: number
  /** New seqs written to the mirror. */
  added: number
  /** Seqs whose stored event changed (a repaired log, a renumbering). */
  updated: number
  /** Seqs that were already mirrored, byte for byte — the idempotent case. */
  unchanged: number
  /** Lines that are not session events (a torn tail, a foreign line). */
  skipped: number
  /** Highest seq the mirror now holds, -1 for an empty log. */
  lastSeq: number
}

export interface MemoryIndexOptions {
  /** `<root>/agents/<name>` — the database lives here. */
  agentHome: string
  /** `<agentHome>/sessions/main/events.jsonl`, the append-only source. */
  eventsFile: string
  /** Override the database location (tests). */
  dbPath?: string
  /** Where warnings go; defaults to `process.stderr`. */
  warn?: (message: string) => void
}

/** The shape of one line of events.jsonl, as far as this layer cares. */
interface RawEvent {
  seq: number
  ts: string
  type: string
  data: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// body: one event, one searchable string
// ---------------------------------------------------------------------------

/**
 * What the FTS row for an event says (task M1 §3).
 *
 * `undefined` means "mirror this event but do not index its text": lifecycle
 * noise (session_created, assistant_pending) and the recall receipts carry
 * nothing worth finding later, and indexing them would only dilute bm25.
 */
export function eventBody(type: string, data: unknown): string | undefined {
  const record = isRecord(data) ? data : {}
  const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined)

  let body: string | undefined
  switch (type) {
    case "user_message":
    case "assistant_message":
      body = text(record.text)
      break
    case "tool_call": {
      const name = text(record.name) ?? ""
      const args = record.args === undefined ? "" : safeJson(record.args)
      body = `${name} ${args}`.trim()
      break
    }
    case "tool_result":
      body = text(record.output)
      break
    case "error":
      body = text(record.message)
      break
    case "memory_write":
      // { memoryId, kind, text } — the text is the memory, the id is a receipt.
      body = text(record.text)
      break
    case "compaction":
      // The summary is the part of a compaction worth finding again.
      body = text(record.summary)
      break
    default:
      body = undefined
  }
  if (body === undefined) return undefined
  const clipped = clipChars(body, INDEX_BODY_LIMIT).trim()
  return clipped === "" ? undefined : clipped
}

// ---------------------------------------------------------------------------
// snippet: 400 chars with 120 before the match
// ---------------------------------------------------------------------------

/**
 * Clip `body` to a window around the first match of `query` (task M1 §4).
 *
 * Case-insensitive; when the query does not occur literally (a trigram match on
 * a normalised form, a multi-word query), each word is tried, and failing that
 * the head of the body is used — as the spec says. The result is never longer
 * than SNIPPET_LIMIT, ellipses included.
 */
export function snippet(body: string, query: string, opts: { limit?: number; lead?: number } = {}): string {
  const limit = Math.max(1, Math.floor(opts.limit ?? SNIPPET_LIMIT))
  const lead = Math.max(0, Math.floor(opts.lead ?? SNIPPET_LEAD))
  const points = Array.from(body)
  if (points.length <= limit) return body

  const needle = query.trim()
  let at = -1
  if (needle !== "") {
    for (const candidate of [needle, ...needle.split(/\s+/).filter((word) => word !== "")]) {
      const index = body.toLowerCase().indexOf(candidate.toLowerCase())
      if (index >= 0) {
        at = Array.from(body.slice(0, index)).length
        break
      }
    }
  }

  const from = at < 0 ? 0 : Math.max(0, Math.min(at - lead, points.length - limit))
  const to = Math.min(points.length, from + limit)
  const head = from > 0 ? "…" : ""
  const tail = to < points.length ? "…" : ""
  // The ellipses are part of the budget, so a hit stays within `limit` chars.
  const room = Math.max(0, limit - head.length - tail.length)
  const slice = points.slice(from, Math.min(to, from + room)).join("")
  return `${head}${slice}${tail}`
}

// ---------------------------------------------------------------------------
// the index
// ---------------------------------------------------------------------------

export class MemoryIndex {
  readonly dbPath: string
  readonly eventsFile: string
  private readonly warn: (message: string) => void
  private db: DatabaseSync | undefined
  /** Why search cannot answer; set once, never cleared — a broken mirror stays broken. */
  private failure: string | undefined
  /** Warnings already printed, so a per-turn import cannot spam the console. */
  private readonly warned = new Set<string>()

  constructor(opts: MemoryIndexOptions) {
    this.dbPath = opts.dbPath ?? memoryDbPath(opts.agentHome)
    this.eventsFile = opts.eventsFile
    this.warn = opts.warn ?? ((message) => process.stderr.write(`${message}\n`))
    try {
      this.db = openMemoryDb(this.dbPath)
    } catch (error) {
      this.degrade(`memory index disabled (${this.dbPath}): ${errorMessage(error)}`)
    }
  }

  /** False when the database could not be opened or the last import failed. */
  get available(): boolean {
    return this.db !== undefined && this.failure === undefined
  }

  /** The reason search is degraded, for a log line or a tool answer. */
  get error(): string | undefined {
    return this.failure
  }

  /**
   * Mirror whatever is new in events.jsonl (task M1 §3).
   *
   * Idempotent: a seq that is already stored byte for byte is not written
   * again, so calling this after every turn costs one file read and no writes.
   * Seqs that come back *changed* (a repaired log renumbers events by index)
   * are re-mirrored; FTS5 contentless tables are cleaned up with the special
   * `'delete'` command, which needs the old body — hence the read-then-replace.
   *
   * `last_indexed_seq` only ever moves forward, and to the highest seq actually
   * seen, so a gap in the log cannot stall the mirror.
   */
  importEvents(): ImportResult | undefined {
    const db = this.db
    if (db === undefined || this.failure !== undefined) return undefined

    const result: ImportResult = { scanned: 0, added: 0, updated: 0, unchanged: 0, skipped: 0, lastSeq: -1 }
    try {
      const records = readEventsFile(this.eventsFile)
      result.scanned = records.scanned
      result.skipped = records.skipped

      const select = db.prepare("SELECT ts, type, data FROM events WHERE seq = ?")
      const upsert = db.prepare("INSERT OR REPLACE INTO events(seq, ts, type, data) VALUES (?, ?, ?, ?)")
      const indexRow = db.prepare("INSERT INTO events_fts(rowid, body) VALUES (?, ?)")
      // Contentless FTS5: a delete must be told the text that was indexed.
      const unindex = db.prepare("INSERT INTO events_fts(events_fts, rowid, body) VALUES ('delete', ?, ?)")

      db.exec("BEGIN")
      const previous = lastIndexedSeq(db)
      let maxSeq = previous
      try {
        for (const event of records.events) {
          const data = JSON.stringify(event.data)
          const existing = select.get(event.seq)
          if (
            existing !== undefined &&
            asString(existing.ts) === event.ts &&
            asString(existing.type) === event.type &&
            asString(existing.data) === data
          ) {
            result.unchanged += 1
            if (event.seq > maxSeq) maxSeq = event.seq
            continue
          }

          if (existing !== undefined) {
            const oldBody = eventBody(asString(existing.type) ?? "", parseJson(asString(existing.data)))
            if (oldBody !== undefined) unindex.run(event.seq, oldBody)
            result.updated += 1
          } else {
            result.added += 1
          }

          upsert.run(event.seq, event.ts, event.type, data)
          const body = eventBody(event.type, event.data)
          if (body !== undefined) indexRow.run(event.seq, body)
          if (event.seq > maxSeq) maxSeq = event.seq
        }
        // Only a moved watermark is worth a write; a turn that appended nothing
        // leaves the file untouched.
        if (maxSeq !== previous) writeMeta(db, META_LAST_INDEXED_SEQ, String(maxSeq))
        db.exec("COMMIT")
      } catch (error) {
        try {
          db.exec("ROLLBACK")
        } catch {
          // A failed rollback leaves the transaction to close with the handle.
        }
        throw error
      }

      result.lastSeq = maxSeq
      return result
    } catch (error) {
      this.degrade(`memory import failed (${this.eventsFile}): ${errorMessage(error)}`)
      return undefined
    }
  }

  /**
   * Search the mirror (task M1 §4).
   *
   * Empty query → no hits, never an error. `beforeSeq` pages backwards through
   * whichever regime answered.
   */
  search(query: string, opts: SearchOptions = {}): MemoryHit[] {
    const q = query.trim()
    if (q === "") return []
    // A degraded index answers with nothing; the reason was already written to
    // stderr once by `degrade()`, so searching stays quiet (task M1 §8).
    if (!this.available) return []
    const db = this.db
    if (db === undefined) return []
    const limit = clampLimit(opts.limit)
    const before = normaliseBefore(opts.beforeSeq)
    try {
      return codePointLength(q) >= TRIGRAM_MIN_CHARS
        ? this.searchFts(db, q, limit, before)
        : this.searchSubstring(db, q, limit, before)
    } catch (error) {
      // A query FTS5 refuses must not be an error the model has to interpret.
      this.warnOnce(`search:${q}`, `memory search fell back to substring for ${JSON.stringify(q)}: ${errorMessage(error)}`)
      try {
        return this.searchSubstring(db, q, limit, before)
      } catch (fallbackError) {
        this.warnOnce("search:fallback", `memory search failed: ${errorMessage(fallbackError)}`)
        return []
      }
    }
  }

  /** Row counts, for tests and a future /api/health line. */
  stats(): { available: boolean; events: number; indexed: number; lastSeq: number; error?: string } {
    const db = this.db
    const reason = this.failure !== undefined ? { error: this.failure } : {}
    if (db === undefined) return { available: false, events: 0, indexed: 0, lastSeq: -1, ...reason }
    try {
      const events = asInteger(db.prepare("SELECT count(*) AS n FROM events").get()?.n) ?? 0
      const indexed = asInteger(db.prepare("SELECT count(*) AS n FROM events_fts").get()?.n) ?? 0
      return { available: this.available, events, indexed, lastSeq: lastIndexedSeq(db), ...reason }
    } catch (error) {
      return { available: false, events: 0, indexed: 0, lastSeq: -1, error: errorMessage(error) }
    }
  }

  /**
   * The scratchpad's write path. The index owns the open handle, and a caller
   * that needs the memories/focus/dream tables (M2–M4) goes through here instead
   * of opening a second connection to the same file — one writer, one WAL.
   * Undefined when the database could not be opened; callers degrade.
   */
  handle(): DatabaseSync | undefined {
    return this.db
  }

  close(): void {
    const db = this.db
    this.db = undefined
    if (db === undefined) return
    try {
      db.close()
    } catch {
      // Closing a mirror that failed halfway is not worth an exception.
    }
  }

  // -- internals ------------------------------------------------------------

  private searchFts(db: DatabaseSync, query: string, limit: number, before: number | undefined): MemoryHit[] {
    // Quoted, with internal quotes doubled: `hw-` and `AND` are content, not
    // FTS5 syntax (MEMORY.md §4).
    const match = `"${query.replace(/"/g, '""')}"`
    const rows =
      before === undefined
        ? db
            .prepare(
              "SELECT rowid AS seq, bm25(events_fts) AS score FROM events_fts " +
                "WHERE events_fts MATCH ? ORDER BY score ASC, seq DESC LIMIT ?",
            )
            .all(match, limit)
        : db
            .prepare(
              "SELECT rowid AS seq, bm25(events_fts) AS score FROM events_fts " +
                "WHERE events_fts MATCH ? AND rowid < ? ORDER BY score ASC, seq DESC LIMIT ?",
            )
            .all(match, before, limit)
    const ranked = rows
      .map((row) => ({ seq: asInteger(row.seq), score: asNumber(row.score) ?? 0 }))
      .filter((row): row is { seq: number; score: number } => row.seq !== undefined)
    return this.hydrate(db, ranked, query)
  }

  private searchSubstring(db: DatabaseSync, query: string, limit: number, before: number | undefined): MemoryHit[] {
    const needle = query.toLowerCase()
    const hits: MemoryHit[] = []
    let cursor = before
    let scanned = 0
    for (;;) {
      const rows =
        cursor === undefined
          ? db
              .prepare("SELECT seq, ts, type, data FROM events ORDER BY seq DESC LIMIT ?")
              .all(SUBSTRING_CHUNK)
          : db
              .prepare("SELECT seq, ts, type, data FROM events WHERE seq < ? ORDER BY seq DESC LIMIT ?")
              .all(cursor, SUBSTRING_CHUNK)
      if (rows.length === 0) return hits
      for (const row of rows) {
        scanned += 1
        const seq = asInteger(row.seq)
        if (seq === undefined) continue
        const type = asString(row.type) ?? ""
        const body = eventBody(type, parseJson(asString(row.data)))
        cursor = seq
        if (body === undefined) continue
        if (!body.toLowerCase().includes(needle)) continue
        hits.push({ seq, ts: asString(row.ts) ?? "", type, body: snippet(body, query), score: 0 })
        if (hits.length >= limit) return hits
      }
      if (scanned >= SUBSTRING_MAX_SCAN) return hits
    }
  }

  /** Turn ranked seqs into hits by reading the mirrored event back. */
  private hydrate(db: DatabaseSync, ranked: Array<{ seq: number; score: number }>, query: string): MemoryHit[] {
    if (ranked.length === 0) return []
    const placeholders = ranked.map(() => "?").join(", ")
    const rows = db
      .prepare(`SELECT seq, ts, type, data FROM events WHERE seq IN (${placeholders})`)
      .all(...ranked.map((row) => row.seq))
    const bySeq = new Map<number, Record<string, SQLValue>>()
    for (const row of rows as Array<Record<string, SQLValue>>) {
      const seq = asInteger(row.seq)
      if (seq !== undefined) bySeq.set(seq, row)
    }
    const hits: MemoryHit[] = []
    for (const { seq, score } of ranked) {
      const row = bySeq.get(seq)
      if (row === undefined) continue
      const type = asString(row.type) ?? ""
      const body = eventBody(type, parseJson(asString(row.data)))
      // An FTS posting without a body means the mirror was rebuilt under it;
      // the next import repairs the index, and the hit is not worth showing.
      if (body === undefined) continue
      hits.push({ seq, ts: asString(row.ts) ?? "", type, body: snippet(body, query), score })
    }
    return hits
  }

  /** Mark the layer unusable and say so exactly once per reason. */
  private degrade(reason: string): void {
    this.failure = reason
    this.warnOnce(`degrade:${reason}`, reason)
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return
    this.warned.add(key)
    this.warn(message)
  }
}

export function createMemoryIndex(opts: MemoryIndexOptions): MemoryIndex {
  return new MemoryIndex(opts)
}

/** One page of a substring scan; a 2-char query must not load the whole log. */
const SUBSTRING_CHUNK = 500
/** Hard stop for a substring scan on a log nobody expected to get this big. */
const SUBSTRING_MAX_SCAN = 50_000

// ---------------------------------------------------------------------------
// reading events.jsonl
// ---------------------------------------------------------------------------

interface ReadEvents {
  events: RawEvent[]
  scanned: number
  skipped: number
}

/**
 * Parse the log without touching it: this layer is a reader, and `jsonl.ts`'s
 * repair path belongs to the engine that owns the file. A torn tail or a
 * foreign line is simply skipped until the next import.
 *
 * `seq` comes from the record when it has one (pi-durable writes it), otherwise
 * from the line's position, counting every non-empty line so a corrupt line
 * still occupies its slot — the same rule the engine uses.
 */
function readEventsFile(file: string): ReadEvents {
  let raw: string
  try {
    raw = readFileSync(file, "utf8")
  } catch {
    // No log yet: an empty mirror is the honest answer, not an error.
    return { events: [], scanned: 0, skipped: 0 }
  }
  const events: RawEvent[] = []
  let scanned = 0
  let skipped = 0
  let slot = 0
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue
    scanned += 1
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      skipped += 1
      slot += 1
      continue
    }
    const record = isRecord(parsed) ? parsed : undefined
    const type = record !== undefined && typeof record.type === "string" ? record.type : undefined
    const data = record !== undefined && isRecord(record.data) ? record.data : undefined
    const explicit = record !== undefined ? asInteger(record.seq) : undefined
    const seq = explicit !== undefined && explicit >= 0 ? explicit : slot
    slot += 1
    if (type === undefined || data === undefined) {
      skipped += 1
      continue
    }
    events.push({ seq, ts: typeof record?.ts === "string" ? record.ts : "", type, data })
  }
  return { events, scanned, skipped }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

type SQLValue = null | number | bigint | string | Uint8Array | undefined

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "bigint") return Number(value)
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value)) return Number(value)
  return undefined
}

/**
 * Integer columns only. Scores must never come through here: a bm25 value is a
 * tiny fraction, and truncating it turns every hit into 0.
 */
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseJson(text: string | undefined): unknown {
  if (text === undefined) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ""
  } catch {
    return String(value)
  }
}

/** `Array.from` so CJK and emoji count as one character each. */
function codePointLength(text: string): number {
  return Array.from(text).length
}

function clipChars(text: string, max: number): string {
  const points = Array.from(text)
  return points.length <= max ? text : points.slice(0, max).join("")
}

export function clampLimit(value: unknown): number {
  const parsed = asNumber(value)
  if (parsed === undefined) return DEFAULT_SEARCH_LIMIT
  return Math.max(1, Math.min(Math.trunc(parsed), MAX_SEARCH_LIMIT))
}

function normaliseBefore(value: unknown): number | undefined {
  const parsed = asNumber(value)
  return parsed !== undefined && parsed >= 0 ? Math.trunc(parsed) : undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
