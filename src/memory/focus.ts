// focus — what the agent thinks it is doing right now (MEMORY.md §4 §8).
//
// This is not a todo app. It holds at most a handful of items, written by the
// agent itself (`focus_set`), tidied by dreaming, and closed by a click on the
// page (DELETE /api/focus/:id). The interesting column is `state`, because it
// is what the panel sorts by: doing → open → blocked → done.
//
// `done` is terminal but not destructive: the row stays, so the dreaming pass
// can see that something finished instead of meeting it again as new.

import type { DatabaseSync } from "node:sqlite"
import { isRecord } from "./events.ts"

/** MEMORY.md §10.1: open|doing|blocked|done. */
export const FOCUS_STATES = ["open", "doing", "blocked", "done"] as const
export type FocusState = (typeof FOCUS_STATES)[number]
export const DEFAULT_FOCUS_STATE: FocusState = "open"
/** Sort order for the panel: what is being done now comes first (MEMORY.md §10 §11 M4). */
export const FOCUS_ORDER: Record<FocusState, number> = { doing: 0, open: 1, blocked: 2, done: 3 }
export const MAX_FOCUS_TEXT = 500
/** The panel shows at most 10 (MEMORY.md §8); the API defaults to the same. */
export const DEFAULT_FOCUS_LIMIT = 10
export const MAX_FOCUS_LIMIT = 50

export interface FocusItem {
  id: string
  text: string
  state: FocusState
  updatedAt: string
  /** The event seq that introduced the item, when there is one. */
  seq?: number
  /** agent | dream | user — who wrote it last. */
  source?: string
}

export interface ListFocusOptions {
  includeDone?: boolean
  limit?: number
}

export interface UpsertFocusInput {
  id?: string
  text?: string
  state?: string
  /** Who is writing: `agent` (tool), `dream`, `user` (page). */
  source?: string
  seq?: number
  /** Only used when a new row is created; production ids are generated. */
  now?: Date
}

export function isFocusState(value: unknown): value is FocusState {
  return typeof value === "string" && (FOCUS_STATES as readonly string[]).includes(value)
}

export function normalizeFocusText(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[\s.。!！,，;；:：、]+$/u, "")
    .trim()
}

export function newFocusId(now: Date = new Date()): string {
  const stamp = Math.max(0, now.getTime()).toString(36)
  const random = Math.floor(Math.random() * 36 ** 4)
    .toString(36)
    .padStart(4, "0")
  return `foc-${stamp}-${random}`
}

/** The items the panel shows, ordered doing → open → blocked → done. */
export function listFocus(db: DatabaseSync, opts: ListFocusOptions = {}): FocusItem[] {
  const includeDone = opts.includeDone === true
  const limit = clampLimit(opts.limit)
  const rows = (
    includeDone
      ? db.prepare("SELECT * FROM focus").all()
      : db.prepare("SELECT * FROM focus WHERE state IS NULL OR state <> 'done'").all()
  ) as unknown[]
  return rows
    .map(mapRow)
    .sort(
      (a, b) =>
        FOCUS_ORDER[a.state] - FOCUS_ORDER[b.state] ||
        b.updatedAt.localeCompare(a.updatedAt) ||
        a.id.localeCompare(b.id),
    )
    .slice(0, limit)
}

export function getFocus(db: DatabaseSync, id: string): FocusItem | undefined {
  const row = db.prepare("SELECT * FROM focus WHERE id = ?").get(id)
  return row === undefined ? undefined : mapRow(row)
}

/** How many items are still active — the number `GET /api/agent` reports. */
export function openFocusCount(db: DatabaseSync): number {
  const row = db
    .prepare("SELECT count(*) AS n FROM focus WHERE state IS NULL OR state <> 'done'")
    .get()
  const value = row?.n
  return typeof value === "bigint" ? Number(value) : typeof value === "number" ? value : 0
}

/**
 * Create or update one item (MEMORY.md §10.1 `focus_set`, `POST /api/focus`).
 *
 *   id given, row exists     update text/state
 *   id given, row missing    create it with that id (a dream may address an id
 *                            it saw in the same prompt)
 *   no id, same text exists  update that row instead of adding a twin
 *   otherwise                create a new `open` item
 */
export function upsertFocus(db: DatabaseSync, input: UpsertFocusInput): FocusItem {
  const now = input.now ?? new Date()
  const stamp = now.toISOString()
  const text = input.text === undefined ? undefined : input.text.trim().slice(0, MAX_FOCUS_TEXT)
  const state = isFocusState(input.state) ? input.state : undefined
  const id = typeof input.id === "string" && input.id.trim() !== "" ? input.id.trim() : undefined

  if (id !== undefined) {
    const existing = getFocus(db, id)
    if (existing !== undefined) {
      db.prepare("UPDATE focus SET text = ?, state = ?, updated_at = ?, source = ?, seq = ? WHERE id = ?").run(
        text !== undefined && text !== "" ? text : existing.text,
        state ?? existing.state,
        stamp,
        input.source ?? existing.source ?? "agent",
        input.seq ?? existing.seq ?? null,
        id,
      )
      return getFocus(db, id) as FocusItem
    }
    if (text === undefined || text === "") throw new Error("focus needs text when the id is new")
    db.prepare("INSERT INTO focus(id, text, state, updated_at, source, seq) VALUES (?, ?, ?, ?, ?, ?)").run(
      id,
      text,
      state ?? DEFAULT_FOCUS_STATE,
      stamp,
      input.source ?? "agent",
      input.seq ?? null,
    )
    return getFocus(db, id) as FocusItem
  }

  if (text === undefined || text === "") throw new Error("focus needs text or an id")

  const wanted = normalizeFocusText(text)
  const twin = listFocus(db, { includeDone: false, limit: MAX_FOCUS_LIMIT }).find(
    (item) => normalizeFocusText(item.text) === wanted,
  )
  if (twin !== undefined) {
    db.prepare("UPDATE focus SET state = ?, updated_at = ?, source = ?, seq = ? WHERE id = ?").run(
      state ?? twin.state,
      stamp,
      input.source ?? "agent",
      input.seq ?? twin.seq ?? null,
      twin.id,
    )
    return getFocus(db, twin.id) as FocusItem
  }

  const fresh = newFocusId(now)
  db.prepare("INSERT INTO focus(id, text, state, updated_at, source, seq) VALUES (?, ?, ?, ?, ?, ?)").run(
    fresh,
    text,
    state ?? DEFAULT_FOCUS_STATE,
    stamp,
    input.source ?? "agent",
    input.seq ?? null,
  )
  return getFocus(db, fresh) as FocusItem
}

/** `DELETE /api/focus/:id` — soft: the row becomes `done`. */
export function completeFocus(db: DatabaseSync, id: string, now: Date = new Date()): FocusItem | undefined {
  const existing = getFocus(db, id)
  if (existing === undefined) return undefined
  db.prepare("UPDATE focus SET state = 'done', updated_at = ? WHERE id = ?").run(now.toISOString(), id)
  return getFocus(db, id)
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

function mapRow(raw: unknown): FocusItem {
  const row = isRecord(raw) ? raw : {}
  const state = isFocusState(row.state) ? row.state : DEFAULT_FOCUS_STATE
  const seq = typeof row.seq === "number" ? row.seq : typeof row.seq === "bigint" ? Number(row.seq) : undefined
  return {
    id: typeof row.id === "string" ? row.id : "",
    text: typeof row.text === "string" ? row.text : "",
    state,
    updatedAt: typeof row.updated_at === "string" ? row.updated_at : "",
    ...(seq !== undefined ? { seq } : {}),
    ...(typeof row.source === "string" ? { source: row.source } : {}),
  }
}

function clampLimit(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(1, Math.min(Math.trunc(value), MAX_FOCUS_LIMIT))
  }
  return DEFAULT_FOCUS_LIMIT
}
