import { readFileSync } from "node:fs"
import type { DatabaseSync } from "node:sqlite"
import {
  META_LAST_INDEXED_SEQ,
  lastIndexedSeq,
  memoryDbPath,
  openMemoryDb,
  writeMeta,
} from "./db.ts"

export const DEFAULT_SEARCH_LIMIT = 8

export const MAX_SEARCH_LIMIT = 20

export const INDEX_BODY_LIMIT = 2_000

export const SNIPPET_LIMIT = 400
export const SNIPPET_LEAD = 120

export const TRIGRAM_MIN_CHARS = 3

export interface MemoryHit {
  seq: number
  ts: string
  type: string

  body: string

  score: number
}

export interface SearchOptions {

  limit?: number

  beforeSeq?: number
}

export interface ImportResult {

  scanned: number

  added: number

  updated: number

  unchanged: number

  skipped: number

  lastSeq: number
}

export interface MemoryIndexOptions {

  agentHome: string

  eventsFile: string

  dbPath?: string

  warn?: (message: string) => void
}

interface RawEvent {
  seq: number
  ts: string
  type: string
  data: Record<string, unknown>
}

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

      body = text(record.text)
      break
    case "compaction":

      body = text(record.summary)
      break
    default:
      body = undefined
  }
  if (body === undefined) return undefined
  const clipped = clipChars(body, INDEX_BODY_LIMIT).trim()
  return clipped === "" ? undefined : clipped
}

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

  const room = Math.max(0, limit - head.length - tail.length)
  const slice = points.slice(from, Math.min(to, from + room)).join("")
  return `${head}${slice}${tail}`
}

export class MemoryIndex {
  readonly dbPath: string
  readonly eventsFile: string
  private readonly warn: (message: string) => void
  private db: DatabaseSync | undefined

  private failure: string | undefined

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

  get available(): boolean {
    return this.db !== undefined && this.failure === undefined
  }

  get error(): string | undefined {
    return this.failure
  }

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

        if (maxSeq !== previous) writeMeta(db, META_LAST_INDEXED_SEQ, String(maxSeq))
        db.exec("COMMIT")
      } catch (error) {
        try {
          db.exec("ROLLBACK")
        } catch {

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

  search(query: string, opts: SearchOptions = {}): MemoryHit[] {
    const q = query.trim()
    if (q === "") return []

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

      this.warnOnce(`search:${q}`, `memory search fell back to substring for ${JSON.stringify(q)}: ${errorMessage(error)}`)
      try {
        return this.searchSubstring(db, q, limit, before)
      } catch (fallbackError) {
        this.warnOnce("search:fallback", `memory search failed: ${errorMessage(fallbackError)}`)
        return []
      }
    }
  }

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

    }
  }

  private searchFts(db: DatabaseSync, query: string, limit: number, before: number | undefined): MemoryHit[] {

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

      if (body === undefined) continue
      hits.push({ seq, ts: asString(row.ts) ?? "", type, body: snippet(body, query), score })
    }
    return hits
  }

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

const SUBSTRING_CHUNK = 500

const SUBSTRING_MAX_SCAN = 50_000

interface ReadEvents {
  events: RawEvent[]
  scanned: number
  skipped: number
}

function readEventsFile(file: string): ReadEvents {
  let raw: string
  try {
    raw = readFileSync(file, "utf8")
  } catch {

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

type SQLValue = null | number | bigint | string | Uint8Array | undefined

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
