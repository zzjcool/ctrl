import { randomBytes } from "node:crypto"
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { createRequire } from "node:module"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type {
  EventEnvelope,
  EventOf,
  MemoryEntry,
  SessionEvent,
  SessionEventType,
  SessionMeta,
  ToolCall,
} from "./types.ts"

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz"

export function newId(size = 12): string {
  const limit = 256 - (256 % ALPHABET.length)
  let out = ""
  while (out.length < size) {
    const bytes = randomBytes(size * 2)
    for (const b of bytes) {
      if (b >= limit) continue
      out += ALPHABET[b % ALPHABET.length]
      if (out.length >= size) break
    }
  }
  return out
}

export function newSessionId(now: Date = new Date()): string {
  const ts = [
    now.getUTCFullYear(),
    pad(now.getUTCMonth() + 1),
    pad(now.getUTCDate()),
  ].join("")
  const hms = [pad(now.getUTCHours()), pad(now.getUTCMinutes()), pad(now.getUTCSeconds())].join("")
  return `${ts}T${hms}Z-${newId(8)}`
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

export interface DurablePaths {

  home: string

  sessions: string

  sessionDir: (sessionId: string) => string

  eventsFile: (sessionId: string) => string

  metaFile: (sessionId: string) => string

  memory: string

  memoryLog: string

  memoryMeta: string
}

export function resolvePaths(home?: string): DurablePaths {
  const root = home ?? process.env.PI_DURABLE_HOME ?? join(homedir(), ".ctrl")
  const sessions = join(root, "sessions")
  const memory = join(root, "memory")

  return {
    home: root,
    sessions,
    sessionDir: (sessionId) => join(sessions, sessionId),
    eventsFile: (sessionId) => join(sessions, sessionId, "events.jsonl"),
    metaFile: (sessionId) => join(sessions, sessionId, "meta.json"),
    memory,
    memoryLog: join(memory, "index.jsonl"),
    memoryMeta: join(memory, "index.meta.json"),
  }
}

export function defaultHome(): string {
  return resolvePaths().home
}

export interface ReadResult<T> {
  records: T[]

  repaired: boolean

  skipped: number

  bytes: number
}

export function appendRecord(file: string, record: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  const line = `${JSON.stringify(record)}\n`
  appendFileSync(file, line, { flag: "a" })
  fsyncFile(file)
}

export function fsyncFile(file: string): void {
  if (!existsSync(file)) return
  try {
    const fd = openSync(file, "r")
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  } catch {

  }
}

export function readRecordsWithStats<T = unknown>(file: string): ReadResult<T> {
  if (!existsSync(file)) {
    return { records: [], repaired: false, skipped: 0, bytes: 0 }
  }

  const raw = readFileSync(file, "utf8")
  const lines = raw.split("\n")

  let lastContent = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.trim() !== "") {
      lastContent = i
      break
    }
  }

  let lastGood = -1
  for (let i = lastContent; i >= 0; i--) {
    const line = lines[i]!
    if (line.trim() === "") continue
    try {
      JSON.parse(line)
      lastGood = i
      break
    } catch {
      continue
    }
  }

  const records: T[] = []
  let skipped = 0
  let repaired = false

  for (let i = 0; i <= lastContent; i++) {
    const line = lines[i]!
    if (line.trim() === "") continue

    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      if (i > lastGood) {

        repaired = true
        rewritePrefix(file, lines, lastGood + 1)
        break
      }
      skipped++
      continue
    }
    records.push(parsed as T)
  }

  return { records, repaired, skipped, bytes: Buffer.byteLength(raw, "utf8") }
}

export function readRecords<T = unknown>(file: string): T[] {
  return readRecordsWithStats<T>(file).records
}

function rewritePrefix(file: string, lines: string[], untilExclusive: number): void {
  const kept = lines.slice(0, untilExclusive).filter((l) => l.trim() !== "")
  const body = kept.length === 0 ? "" : `${kept.join("\n")}\n`
  const tmp = `${file}.repair-${process.pid}-${Date.now()}`
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(tmp, body)
    fsyncFile(tmp)
    renameSync(tmp, file)
  } catch {

    try {
      if (existsSync(tmp)) renameSync(tmp, `${tmp}.dead`)
    } catch {

    }
  }
}

export type EventDraft<T extends SessionEventType = SessionEventType> = {
  [K in T]: Omit<EventOf<K>, keyof EventEnvelope>
}[T]

function draft<T extends SessionEventType>(type: T, data: EventOf<T>["data"]): EventDraft<T> {

  return {
    id: newId(),
    ts: new Date().toISOString(),
    type,
    data,
  } as unknown as EventDraft<T>
}

export function makeSessionCreated(input: { cwd: string; model: string }): EventDraft<"session_created"> {
  return draft("session_created", input)
}

export function makeUserMessage(text: string): EventDraft<"user_message"> {
  return draft("user_message", { text })
}

export function makeAssistantMessage(input: { text: string; toolCalls?: ToolCall[] }): EventDraft<"assistant_message"> {
  return draft("assistant_message", input)
}

export function makeToolCall(input: { callId: string; name: string; args: unknown }): EventDraft<"tool_call"> {
  return draft("tool_call", input)
}

export function makeToolResult(input: {
  callId: string
  name: string
  ok: boolean
  output: string
}): EventDraft<"tool_result"> {
  return draft("tool_result", input)
}

export function makeMemoryWrite(input: {
  memoryId: string
  kind: string
  text: string
}): EventDraft<"memory_write"> {
  return draft("memory_write", input)
}

export function makeMemoryRecall(input: {
  memoryIds: string[]
  query: string
}): EventDraft<"memory_recall"> {
  return draft("memory_recall", input)
}

export function makeCompaction(input: {
  summary: string
  firstKeptSeq: number
}): EventDraft<"compaction"> {
  return draft("compaction", input)
}

export function makeError(input: { message: string; fatal: boolean }): EventDraft<"error"> {
  return draft("error", input)
}

function allEventTypes(): ReadonlySet<string> {
  const probe: Record<SessionEventType, true> = {
    session_created: true,
    user_message: true,
    assistant_message: true,
    assistant_pending: true,
    tool_call: true,
    tool_result: true,
    memory_write: true,
    memory_recall: true,
    compaction: true,
    error: true,
  }
  return new Set(Object.keys(probe))
}

const EVENT_TYPES: ReadonlySet<string> = allEventTypes()

export function isSessionEvent(value: unknown): value is SessionEvent {
  if (value === null || typeof value !== "object") return false
  const candidate = value as Record<string, unknown>
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.seq !== "number" ||
    !Number.isFinite(candidate.seq) ||
    typeof candidate.ts !== "string" ||
    !EVENT_TYPES.has(String(candidate.type)) ||
    candidate.data === null ||
    typeof candidate.data !== "object"
  ) return false

  const data = candidate.data as Record<string, unknown>
  switch (candidate.type) {
    case "session_created":
      return typeof data.cwd === "string" && typeof data.model === "string"
    case "user_message":
      return typeof data.text === "string"
    case "assistant_message":
      return typeof data.text === "string" && (data.toolCalls === undefined || Array.isArray(data.toolCalls))
    case "assistant_pending":
      return typeof data.model === "string" && typeof data.step === "number" && Number.isFinite(data.step)
    case "tool_call":
      return typeof data.callId === "string" && typeof data.name === "string" && "args" in data
    case "tool_result":
      return typeof data.callId === "string" && typeof data.name === "string" &&
        typeof data.ok === "boolean" && typeof data.output === "string"
    case "memory_write":
      return typeof data.memoryId === "string" && typeof data.kind === "string" && typeof data.text === "string"
    case "memory_recall":
      return Array.isArray(data.memoryIds) && data.memoryIds.every((id) => typeof id === "string") &&
        typeof data.query === "string"
    case "compaction":
      return typeof data.summary === "string" && typeof data.firstKeptSeq === "number" &&
        Number.isFinite(data.firstKeptSeq)
    case "error":
      return typeof data.message === "string" && typeof data.fatal === "boolean"
    default:
      return false
  }
}

export function makeAssistantPending(input: { model: string; step: number }): EventDraft<"assistant_pending"> {
  return draft("assistant_pending", input)
}

type SqlValue = string | number | null
interface SqlStatement {
  run(...values: SqlValue[]): void
  get(...values: SqlValue[]): Record<string, unknown> | undefined
  all(...values: SqlValue[]): Record<string, unknown>[]
}
interface SqlDatabase {
  exec(sql: string): void
  prepare(sql: string): SqlStatement
  close(): void
}
type DatabaseSyncConstructor = new (path: string) => SqlDatabase
interface SqliteModule { DatabaseSync?: DatabaseSyncConstructor }

const require = createRequire(import.meta.url)
let sqliteModule: SqliteModule | undefined
try {
  sqliteModule = require("node:sqlite") as SqliteModule
} catch {

  sqliteModule = undefined
}

interface StoreHandle {
  db: SqlDatabase
  file: string
}

const handles = new Map<string, StoreHandle>()

export function openStore(paths: DurablePaths, module: SqliteModule | null = sqliteModule ?? null): StoreHandle | undefined {
  const DatabaseSync = module?.DatabaseSync
  if (!DatabaseSync) return undefined
  const file = join(paths.home, "store.sqlite")
  const current = handles.get(file)
  if (current && existsSync(file)) {
    try {
      ensureFresh(paths, current)
      return current
    } catch {
      closeStore(paths)
      return undefined
    }
  }
  if (current) {
    try { current.db.close() } catch {  }
    handles.delete(file)
  }
  try {
    mkdirSync(paths.home, { recursive: true })
    const handle: StoreHandle = { db: new DatabaseSync(file), file }
    initialize(handle.db)
    handles.set(file, handle)
    ensureFresh(paths, handle)
    return handle
  } catch {

    return undefined
  }
}

export function closeStore(paths?: DurablePaths): void {
  const selected = paths ? [[join(paths.home, "store.sqlite"), handles.get(join(paths.home, "store.sqlite"))] as const] : [...handles.entries()]
  for (const [file, handle] of selected) {
    if (!handle) continue
    try { handle.db.close() } catch {  }
    handles.delete(file)
  }
}

export function readSessionEvents(paths: DurablePaths, sessionId: string): SessionEvent[] | undefined {
  const handle = openStore(paths)
  if (!handle) return undefined
  try {
    const rows = handle.db.prepare(
      "SELECT id, seq, ts, type, data_json FROM events WHERE session_id = ? ORDER BY seq",
    ).all(sessionId)
    return rows.map((row, seq) => ({
      id: String(row.id),
      seq,
      ts: String(row.ts),
      type: String(row.type),
      data: JSON.parse(String(row.data_json)) as Record<string, unknown>,
    } as SessionEvent))
  } catch {
    return undefined
  }
}

export function readMemories(paths: DurablePaths): MemoryEntry[] | undefined {
  const handle = openStore(paths)
  if (!handle) return undefined
  try {
    return handle.db.prepare(
      "SELECT id, seq, ts, kind, text, tags_json, salience, superseded_by FROM memories ORDER BY seq, id",
    ).all().map((row) => ({
      id: String(row.id),
      seq: Number(row.seq),
      ts: String(row.ts),
      kind: String(row.kind) as MemoryEntry["kind"],
      text: String(row.text),
      tags: JSON.parse(String(row.tags_json)) as string[],
      salience: Number(row.salience),
      ...(row.superseded_by === null ? {} : { supersededBy: String(row.superseded_by) }),
    }))
  } catch {
    return undefined
  }
}

export function syncEvent(paths: DurablePaths, sessionId: string, event: SessionEvent): void {
  const handle = openForSync(paths)
  if (!handle) return
  try {
    writeEvent(handle.db, sessionId, event)
    saveManifest(handle.db, paths)
  } catch {

  }
}

export function syncMemories(paths: DurablePaths, entries: MemoryEntry[]): void {
  const handle = openForSync(paths)
  if (!handle) return
  try {
    const statement = handle.db.prepare(
      "INSERT INTO memories(id, seq, ts, kind, text, tags_json, salience, superseded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET seq=excluded.seq, ts=excluded.ts, kind=excluded.kind, text=excluded.text, " +
      "tags_json=excluded.tags_json, salience=excluded.salience, superseded_by=excluded.superseded_by",
    )
    handle.db.exec("BEGIN IMMEDIATE")
    handle.db.exec("DELETE FROM memories")
    for (const entry of entries) {
      statement.run(entry.id, entry.seq, entry.ts, entry.kind, entry.text, JSON.stringify(entry.tags), entry.salience, entry.supersededBy ?? null)
    }
    handle.db.exec("COMMIT")
    saveManifest(handle.db, paths)
  } catch {
    try { handle.db.exec("ROLLBACK") } catch {  }
  }
}

function initialize(db: SqlDatabase): void {
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      cwd TEXT NOT NULL, model TEXT NOT NULL, event_count INTEGER NOT NULL, last_seq INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      session_id TEXT NOT NULL, seq INTEGER NOT NULL, id TEXT NOT NULL, ts TEXT NOT NULL,
      type TEXT NOT NULL, data_json TEXT NOT NULL, PRIMARY KEY(session_id, seq)
    );
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY, seq INTEGER NOT NULL, ts TEXT NOT NULL, kind TEXT NOT NULL,
      text TEXT NOT NULL, tags_json TEXT NOT NULL, salience REAL NOT NULL, superseded_by TEXT
    );
    CREATE TABLE IF NOT EXISTS store_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `)
}

function openWithoutRefresh(paths: DurablePaths): StoreHandle | undefined {
  const DatabaseSync = sqliteModule?.DatabaseSync
  if (!DatabaseSync) return undefined
  const file = join(paths.home, "store.sqlite")
  const existing = handles.get(file)
  if (existing && existsSync(file)) return existing
  if (existing) {
    try { existing.db.close() } catch {  }
    handles.delete(file)
  }
  try {
    mkdirSync(paths.home, { recursive: true })
    const handle: StoreHandle = { db: new DatabaseSync(file), file }
    initialize(handle.db)
    handles.set(file, handle)
    return handle
  } catch { return undefined }
}

function ensureFresh(paths: DurablePaths, handle: StoreHandle): void {
  const current = handle.db.prepare("SELECT value FROM store_state WHERE key = 'manifest'").get()
  if (current?.value !== sourceManifest(paths)) rebuild(paths, handle)
}

function openForSync(paths: DurablePaths): StoreHandle | undefined {
  const handle = openWithoutRefresh(paths)
  if (!handle) return undefined
  try {
    const current = handle.db.prepare("SELECT value FROM store_state WHERE key = 'manifest'").get()
    if (current === undefined) rebuild(paths, handle)
    return handle
  } catch {
    return undefined
  }
}

function rebuild(paths: DurablePaths, handle: StoreHandle): { sessions: number; events: number; memories: number } {
  const source = readSource(paths)
  const db = handle.db
  db.exec("BEGIN IMMEDIATE")
  try {
    db.exec("DELETE FROM events; DELETE FROM sessions; DELETE FROM memories;")
    for (const session of source.sessions) {
      for (const event of session.events) writeEvent(db, session.sessionId, event)
      writeSessionMeta(db, session.sessionId, session.events)
    }
    const statement = db.prepare(
      "INSERT INTO memories(id, seq, ts, kind, text, tags_json, salience, superseded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    for (const entry of source.memoryEntries) {
      statement.run(entry.id, entry.seq, entry.ts, entry.kind, entry.text, JSON.stringify(entry.tags), entry.salience, entry.supersededBy ?? null)
    }
    db.exec("COMMIT")
    saveManifest(db, paths)
  } catch (error) {
    try { db.exec("ROLLBACK") } catch {  }
    throw error
  }
  return { sessions: source.sessions.length, events: source.events, memories: source.memoryEntries.length }
}

function readSource(paths: DurablePaths): {
  sessions: { sessionId: string; events: SessionEvent[] }[]
  events: number
  memories: MemoryEntry[]
  memoryEntries: MemoryEntry[]
} {
  const sessions: { sessionId: string; events: SessionEvent[] }[] = []
  let eventCount = 0
  let sessionDirs: string[] = []
  try {
    sessionDirs = readdirSync(paths.sessions, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch {  }
  for (const sessionId of sessionDirs) {
    const raw = readRecordsWithStats<unknown>(paths.eventsFile(sessionId)).records
    const events = raw.filter(isSessionEvent).map((event, seq) => ({ ...event, seq }))
    if (events.length === 0) continue
    sessions.push({ sessionId, events })
    eventCount += events.length
  }
  const latestById = new Map<string, MemoryEntry>()
  for (const value of readRecordsWithStats<unknown>(paths.memoryLog).records) {
    if (isMemoryEntry(value)) latestById.set(value.id, value)
  }
  const memories = [...latestById.values()]
    .sort((left, right) => left.seq - right.seq || left.id.localeCompare(right.id))
    .map((entry, seq) => ({ ...entry, seq }))
  return { sessions, events: eventCount, memories, memoryEntries: memories }
}

export function isMemoryEntry(value: unknown): value is MemoryEntry {
  if (value === null || typeof value !== "object") return false
  const entry = value as Partial<MemoryEntry>
  return typeof entry.id === "string" && typeof entry.seq === "number" && typeof entry.ts === "string" &&
    (entry.kind === "fact" || entry.kind === "preference" || entry.kind === "event" || entry.kind === "skill" ||
      entry.kind === "lesson") &&
    typeof entry.text === "string" && Array.isArray(entry.tags) && entry.tags.every((tag) => typeof tag === "string") &&
    typeof entry.salience === "number" && (entry.supersededBy === undefined || typeof entry.supersededBy === "string")
}

function writeEvent(db: SqlDatabase, sessionId: string, event: SessionEvent): void {
  db.prepare(
    "INSERT INTO events(session_id, seq, id, ts, type, data_json) VALUES (?, ?, ?, ?, ?, ?) " +
    "ON CONFLICT(session_id, seq) DO UPDATE SET id=excluded.id, ts=excluded.ts, type=excluded.type, data_json=excluded.data_json",
  ).run(sessionId, event.seq, event.id, event.ts, event.type, JSON.stringify(event.data))
  const existing = db.prepare("SELECT created_at, cwd, model, event_count FROM sessions WHERE session_id = ?").get(sessionId)
  const created = event.type === "session_created" ? event : undefined
  const data = created?.data as { cwd?: string; model?: string } | undefined
  db.prepare(
    "INSERT INTO sessions(session_id, created_at, updated_at, cwd, model, event_count, last_seq) VALUES (?, ?, ?, ?, ?, ?, ?) " +
    "ON CONFLICT(session_id) DO UPDATE SET created_at=excluded.created_at, updated_at=excluded.updated_at, " +
    "cwd=excluded.cwd, model=excluded.model, event_count=excluded.event_count, last_seq=excluded.last_seq",
  ).run(
    sessionId,
    created?.ts ?? String(existing?.created_at ?? event.ts),
    event.ts,
    data?.cwd ?? String(existing?.cwd ?? process.cwd()),
    data?.model ?? String(existing?.model ?? process.env.PI_DURABLE_MODEL ?? "workbuddy/hy4-preview-ioa"),
    Math.max(Number(existing?.event_count ?? 0), event.seq + 1),
    event.seq,
  )
}

function writeSessionMeta(db: SqlDatabase, sessionId: string, events: SessionEvent[]): void {
  if (events.length === 0) return
  const created = events.find((event) => event.type === "session_created")
  const createdAt = created?.ts ?? events[0]!.ts
  const updatedAt = events.at(-1)!.ts
  const data = created?.data as { cwd?: string; model?: string } | undefined
  db.prepare(
    "INSERT INTO sessions(session_id, created_at, updated_at, cwd, model, event_count, last_seq) VALUES (?, ?, ?, ?, ?, ?, ?) " +
    "ON CONFLICT(session_id) DO UPDATE SET created_at=excluded.created_at, updated_at=excluded.updated_at, " +
    "cwd=excluded.cwd, model=excluded.model, event_count=excluded.event_count, last_seq=excluded.last_seq",
  ).run(sessionId, createdAt, updatedAt, data?.cwd ?? process.cwd(), data?.model ?? process.env.PI_DURABLE_MODEL ?? "workbuddy/hy4-preview-ioa", events.length, events.length - 1)
}

function sourceManifest(paths: DurablePaths): string {
  const files: { path: string; size: number; mtime: number }[] = []
  const add = (file: string) => {
    try {
      const info = statSync(file)
      files.push({ path: file, size: info.size, mtime: info.mtimeMs })
    } catch { files.push({ path: file, size: 0, mtime: 0 }) }
  }
  let sessionIds: string[] = []
  try {
    sessionIds = readdirSync(paths.sessions, { withFileTypes: true })
      .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
  } catch {  }
  for (const id of sessionIds) add(paths.eventsFile(id))
  add(paths.memoryLog)
  return JSON.stringify(files)
}

function saveManifest(db: SqlDatabase, paths: DurablePaths): void {
  db.prepare("INSERT INTO store_state(key, value) VALUES ('manifest', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(sourceManifest(paths))
}

export interface SessionOptions {
  cwd?: string
  model?: string
  home?: string
}

export interface CreateSessionOptions extends SessionOptions {
  sessionId?: string
}

export class Session {
  readonly sessionId: string
  readonly eventsFile: string
  readonly dir: string
  private readonly metaFile: string
  private readonly paths: ReturnType<typeof resolvePaths>

  constructor(sessionId: string, home?: string) {
    this.sessionId = sessionId
    const paths = resolvePaths(home)
    this.paths = paths
    this.eventsFile = paths.eventsFile(sessionId)
    this.metaFile = paths.metaFile(sessionId)
    this.dir = paths.sessionDir(sessionId)
  }

  append(event: EventDraft): SessionEvent {

    const seq = physicalLineCount(this.eventsFile)
    const record = { ...event, seq } as SessionEvent
    appendRecord(this.eventsFile, record)
    syncEvent(this.paths, this.sessionId, record)

    this.writeMeta(this.replay())
    return record
  }

  appendUserMessage(text: string): SessionEvent { return this.append(makeUserMessage(text)) }

  appendAssistantMessage(input: { text: string; toolCalls?: ToolCall[] }): SessionEvent {
    return this.append(makeAssistantMessage(input))
  }

  appendAssistantPending(input: { model: string; step: number }): SessionEvent {
    return this.append(makeAssistantPending(input))
  }

  appendToolCall(input: { callId: string; name: string; args: unknown }): SessionEvent {
    return this.append(makeToolCall(input))
  }

  appendToolResult(input: { callId: string; name: string; ok: boolean; output: string }): SessionEvent {
    return this.append(makeToolResult(input))
  }

  appendMemoryWrite(input: { memoryId: string; kind: string; text: string }): SessionEvent {
    return this.append(makeMemoryWrite(input))
  }

  appendMemoryRecall(input: { memoryIds: string[]; query: string }): SessionEvent {
    return this.append(makeMemoryRecall(input))
  }

  appendCompaction(input: { summary: string; firstKeptSeq: number }): SessionEvent {
    return this.append(makeCompaction(input))
  }

  appendError(input: { message: string; fatal: boolean }): SessionEvent {
    return this.append(makeError(input))
  }

  events(): SessionEvent[] { return this.replay() }

  replay(): SessionEvent[] {
    const indexed = readSessionEvents(this.paths, this.sessionId)
    if (indexed !== undefined) return indexed.filter(isSessionEvent).map((event, seq) => ({ ...event, seq }))
    const records = readRecordsWithStats<unknown>(this.eventsFile).records
    return records.filter(isSessionEvent).map((event, seq) => ({ ...event, seq }))
  }

  writeMeta(events: SessionEvent[]): SessionMeta {
    const created = events.find((event) => event.type === "session_created")
    const meta: SessionMeta = {
      sessionId: this.sessionId,
      createdAt: created?.ts ?? events[0]?.ts ?? new Date(0).toISOString(),
      updatedAt: events.at(-1)?.ts ?? created?.ts ?? new Date(0).toISOString(),
      cwd: created?.data.cwd ?? process.cwd(),
      model: created?.data.model ?? process.env.PI_DURABLE_MODEL ?? "workbuddy/hy4-preview-ioa",
      eventCount: events.length,
      lastSeq: events.length - 1,
    }
    try {
      mkdirSync(dirname(this.metaFile), { recursive: true })
      writeFileSync(this.metaFile, `${JSON.stringify(meta, null, 2)}\n`)
    } catch {

    }
    return meta
  }

  meta(): SessionMeta {
    return this.writeMeta(this.replay())
  }

}

export function createSession(opts: CreateSessionOptions = {}): Session {
  const sessionId = opts.sessionId ?? newSessionId()
  const session = new Session(sessionId, opts.home)
  mkdirSync(session.dir, { recursive: true })
  if (session.replay().length === 0) {
    session.append(makeSessionCreated({
      cwd: opts.cwd ?? process.cwd(),
      model: opts.model ?? process.env.PI_DURABLE_MODEL ?? "workbuddy/hy4-preview-ioa",
    }))
  }
  return session
}

export function openSession(sessionId: string, opts: SessionOptions = {}): Session {
  const session = new Session(sessionId, opts.home)
  if (!existsSync(session.eventsFile)) throw new Error(`Session not found: ${sessionId}`)
  session.meta()
  return session
}

export function listSessions(opts: SessionOptions = {}): SessionMeta[] {
  const paths = resolvePaths(opts.home)
  if (!existsSync(paths.sessions)) return []
  return readdirSync(paths.sessions, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const file = paths.eventsFile(entry.name)
      return existsSync(file) ? new Session(entry.name, opts.home).meta() : undefined
    })
    .filter((meta): meta is SessionMeta => meta !== undefined)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.sessionId.localeCompare(a.sessionId))
}

export function continueRecentSession(opts: SessionOptions = {}): Session {
  const recent = listSessions(opts)[0]
  return recent ? openSession(recent.sessionId, opts) : createSession(opts)
}

export function physicalLineCount(file: string): number {
  const stats = readRecordsWithStats<unknown>(file)
  return stats.records.length + stats.skipped
}

export type ResumePoint =
  | { kind: "clean" }
  | { kind: "dangling_tool_call"; toolCall: Extract<SessionEvent, { type: "tool_call" }> }

  | { kind: "interrupted_turn"; pending: Extract<SessionEvent, { type: "assistant_pending" }> }
  | { kind: "empty" }

export function detectResumePoint(events: SessionEvent[]): ResumePoint {
  if (events.length === 0) return { kind: "empty" }
  const openCalls = new Map<string, Extract<SessionEvent, { type: "tool_call" }>>()
  for (const event of events) {
    if (event.type === "tool_call") openCalls.set(event.data.callId, event)
    if (event.type === "tool_result") openCalls.delete(event.data.callId)
  }
  let dangling: Extract<SessionEvent, { type: "tool_call" }> | undefined
  for (const event of openCalls.values()) {
    if (!dangling || event.seq > dangling.seq) dangling = event
  }
  if (dangling) return { kind: "dangling_tool_call", toolCall: dangling }

  const lastPending = [...events].reverse().find(
    (event): event is Extract<SessionEvent, { type: "assistant_pending" }> => event.type === "assistant_pending",
  )
  if (lastPending) {
    const answered = events.some((event) => event.type === "assistant_message" && event.seq > lastPending.seq)
    if (!answered) return { kind: "interrupted_turn", pending: lastPending }
  }
  return { kind: "clean" }
}

export function needsResume(events: SessionEvent[]): boolean {
  const point = detectResumePoint(events)
  return point.kind === "dangling_tool_call" || point.kind === "interrupted_turn"
}

export function repairSession(
  sessionId: string,
  opts: SessionOptions = {},
): { repaired: boolean; skipped: number } {
  const file = resolvePaths(opts.home).eventsFile(sessionId)
  const result = readRecordsWithStats<unknown>(file)

  return { repaired: result.repaired, skipped: result.skipped }
}
