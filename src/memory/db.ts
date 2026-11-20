// The agent's memory database (MEMORY.md §4): one SQLite file next to the log.
//
//   <agentHome>/memory.db
//
// Nothing here knows what an event means — this file is DDL, pragmas and the
// tiny `meta` accessors. The mirror itself is built in ./index.ts, because
// "which events are searchable, and how" is a decision, not a schema.
//
// Two rules from MEMORY.md §3 shape the whole layer:
//   * events.jsonl is the truth; memory.db is derived and may be rebuilt;
//   * the tables the M-curve has not reached yet (memories, turns, summaries,
//     focus, dream_runs) exist from day one and stay empty — creating them now
//     is what keeps M2/M3 a write-path change instead of a migration.

import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"

/** Bumped when DDL below changes; stored in `meta.schema_version`. */
export const SCHEMA_VERSION = 1
export const MEMORY_DB_FILENAME = "memory.db"
/** `<agentHome>/memory.db` (MEMORY.md §4). */
export function memoryDbPath(agentHome: string): string {
  return join(agentHome, MEMORY_DB_FILENAME)
}

/**
 * The §4 data model, verbatim. `IF NOT EXISTS` everywhere so opening a live
 * database is idempotent; M2–M4 add columns through a version step, not by
 * editing what already exists on disk.
 *
 * `events_fts`/`memories_fts` are declared `content=''` on purpose: the body is
 * derived from `events.data` and must not be stored twice, and one row per
 * event means `rowid` *is* the event `seq` — the join key the whole layer uses.
 */
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
  summary_id TEXT,
  error TEXT
);

CREATE INDEX IF NOT EXISTS events_type ON events(type);
CREATE INDEX IF NOT EXISTS focus_state ON focus(state);
CREATE INDEX IF NOT EXISTS memories_superseded ON memories(superseded_by);
`

/** meta keys owned by this layer (M2/M3 add theirs). */
export const META_SCHEMA_VERSION = "schema_version"
/** Highest event seq mirrored into `events`; -1 means "nothing indexed yet". */
export const META_LAST_INDEXED_SEQ = "last_indexed_seq"

/**
 * Open (creating if needed) `<agentHome>/memory.db` and bring the schema up to
 * date. Throws when the file cannot be opened — callers that must survive a
 * broken database catch it and run degraded (see `createMemoryIndex`).
 */
export function openMemoryDb(file: string): DatabaseSync {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  try {
    // WAL: the mirror is written while the page reads it. foreign_keys is a
    // contract in the spec (MEMORY.md §4 needs the supersede chain sound).
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
      // The open error is the one worth reporting.
    }
    throw error
  }
}

/** Record the schema version and, later, step older files forward. */
function migrate(db: DatabaseSync): void {
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
  // M1 is the first version: everything above is a future step. Writing the
  // current number here would silently claim migrations that never ran, so a
  // newer file is left exactly as it is.
  if (version < SCHEMA_VERSION) writeMeta(db, META_SCHEMA_VERSION, String(SCHEMA_VERSION))
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

/** The schema version on disk, or 0 for a file that predates `meta`. */
export function schemaVersion(db: DatabaseSync): number {
  const raw = readMeta(db, META_SCHEMA_VERSION)
  if (raw === undefined) return 0
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : 0
}

/** The last mirrored seq, or -1 (so "everything from seq 0" is the first import). */
export function lastIndexedSeq(db: DatabaseSync): number {
  const raw = readMeta(db, META_LAST_INDEXED_SEQ)
  if (raw === undefined) return -1
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : -1
}
