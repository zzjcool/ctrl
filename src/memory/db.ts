import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { VERIFICATION_FAILED_ERROR, parseProposalTests, testsGreen } from "./proposals.ts"

export const SCHEMA_VERSION = 6
export const MEMORY_DB_FILENAME = "memory.db"

export function memoryDbPath(agentHome: string): string {
  return join(agentHome, MEMORY_DB_FILENAME)
}

const DDL = `
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY,
  ts TEXT,
  type TEXT,
  data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS turns (
  id INTEGER PRIMARY KEY,
  started_at TEXT,
  ended_at TEXT,
  user_text TEXT,
  assistant_text TEXT
);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  kind TEXT,
  text TEXT NOT NULL,
  tags TEXT,
  importance REAL DEFAULT 0.5,
  confidence REAL DEFAULT 0.8,
  created_at TEXT,
  updated_at TEXT,
  superseded_by TEXT,
  source_from INTEGER,
  source_to INTEGER
);

CREATE TABLE IF NOT EXISTS memory_edges (
  from_id TEXT,
  to_id TEXT,
  kind TEXT
);

CREATE TABLE IF NOT EXISTS summaries (
  id TEXT PRIMARY KEY,
  level TEXT,
  from_seq INTEGER,
  to_seq INTEGER,
  text TEXT,
  created_at TEXT,
  supersedes TEXT
);

CREATE TABLE IF NOT EXISTS focus (
  id TEXT PRIMARY KEY,
  text TEXT,
  state TEXT,
  updated_at TEXT,
  source TEXT,
  seq INTEGER
);

CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(body, tokenize='trigram', content='');
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(text, tokenize='trigram', content='');

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS dream_runs (
  id TEXT PRIMARY KEY,
  started_at TEXT,
  ended_at TEXT,
  from_seq INTEGER,
  to_seq INTEGER,
  added INTEGER,
  merged INTEGER,
  superseded INTEGER,
  lessons INTEGER,
  summary_id TEXT,
  error TEXT
);

CREATE INDEX IF NOT EXISTS events_type ON events(type);
CREATE INDEX IF NOT EXISTS focus_state ON focus(state);
CREATE INDEX IF NOT EXISTS memories_superseded ON memories(superseded_by);
`

const PROPOSALS_DDL = `
CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  branch TEXT NOT NULL,
  base TEXT NOT NULL,
  task TEXT NOT NULL,
  summary TEXT,
  diffstat TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  ended_at TEXT,
  tests TEXT,
  error TEXT,
  applied_at TEXT,
  merged_commit TEXT,
  job_id TEXT
);

CREATE INDEX IF NOT EXISTS proposals_created ON proposals(created_at);
`

const USAGE_DDL = `
CREATE TABLE IF NOT EXISTS usage (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  model TEXT,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  ms INTEGER NOT NULL DEFAULT 0,
  ok INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS usage_ts ON usage(ts);
`

export const META_SCHEMA_VERSION = "schema_version"

export const META_LAST_INDEXED_SEQ = "last_indexed_seq"

export const META_PENDING_WAKE = "pending_wake"

export function openMemoryDb(file: string): DatabaseSync {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  try {

    db.exec("PRAGMA journal_mode = WAL")
    db.exec("PRAGMA foreign_keys = ON")
    db.exec("PRAGMA busy_timeout = 4000")
    db.exec(DDL)
    migrate(db)
    return db
  } catch (error) {
    try {
      db.close()
    } catch {

    }
    throw error
  }
}

function migrate(db: DatabaseSync): void {
  ensureProposalsTable(db)
  migrateProposalsColumns(db)
  migrateProposalStatuses(db)
  ensureUsageTable(db)
  ensureDreamLessonsColumn(db)
  const stored = readMeta(db, META_SCHEMA_VERSION)
  if (stored === undefined) {
    writeMeta(db, META_SCHEMA_VERSION, String(SCHEMA_VERSION))
    return
  }
  const version = Number.parseInt(stored, 10)
  if (!Number.isFinite(version)) {
    writeMeta(db, META_SCHEMA_VERSION, String(SCHEMA_VERSION))
    return
  }

  if (version < SCHEMA_VERSION) writeMeta(db, META_SCHEMA_VERSION, String(SCHEMA_VERSION))
}

export function ensureProposalsTable(db: DatabaseSync): void {
  db.exec(PROPOSALS_DDL)
}

export function migrateProposalsColumns(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(proposals)").all() as Array<Record<string, unknown>>
  const existing = new Set(columns.map((row) => String(row.name ?? "")))
  if (!existing.has("applied_at")) db.exec("ALTER TABLE proposals ADD COLUMN applied_at TEXT")
  if (!existing.has("merged_commit")) db.exec("ALTER TABLE proposals ADD COLUMN merged_commit TEXT")
  if (!existing.has("job_id")) db.exec("ALTER TABLE proposals ADD COLUMN job_id TEXT")
}

export function migrateProposalStatuses(db: DatabaseSync): void {
  const rows = db.prepare("SELECT id, tests FROM proposals WHERE status = 'open'").all() as Array<Record<string, unknown>>
  const stale = rows.filter((row) => !testsGreen(parseProposalTests(row.tests)))
  if (stale.length === 0) return
  const update = db.prepare(
    "UPDATE proposals SET status = 'failed', error = CASE WHEN error IS NULL OR trim(error) = '' THEN ? ELSE error END WHERE id = ? AND status = 'open'",
  )
  for (const row of stale) update.run(VERIFICATION_FAILED_ERROR, String(row.id ?? ""))
}

export function ensureUsageTable(db: DatabaseSync): void {
  db.exec(USAGE_DDL)
}

export function ensureDreamLessonsColumn(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(dream_runs)").all() as Array<Record<string, unknown>>
  if (columns.some((row) => String(row.name ?? "") === "lessons")) return
  db.exec("ALTER TABLE dream_runs ADD COLUMN lessons INTEGER")
}

export function readMeta(db: DatabaseSync, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key)
  if (row === undefined) return undefined
  const value = row.value
  return typeof value === "string" ? value : value === null ? undefined : String(value)
}

export function writeMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)").run(key, value)
}

export function schemaVersion(db: DatabaseSync): number {
  const raw = readMeta(db, META_SCHEMA_VERSION)
  if (raw === undefined) return 0
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : 0
}

export function lastIndexedSeq(db: DatabaseSync): number {
  const raw = readMeta(db, META_LAST_INDEXED_SEQ)
  if (raw === undefined) return -1
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : -1
}
