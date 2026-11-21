import type { DatabaseSync } from "node:sqlite"
import { isRecord } from "./events.ts"

export const FOCUS_STATES = ["open", "doing", "blocked", "review", "done", "dropped"] as const
export type FocusState = (typeof FOCUS_STATES)[number]
export const DEFAULT_FOCUS_STATE: FocusState = "open"

export const TERMINAL_FOCUS_STATES = ["done", "dropped"] as const
export type TerminalFocusState = (typeof TERMINAL_FOCUS_STATES)[number]

export const FOCUS_ORDER: Record<FocusState, number> = {
  doing: 0,
  open: 1,
  blocked: 2,
  review: 3,
  done: 4,
  dropped: 5,
}
export const MAX_FOCUS_TEXT = 500

export const DEFAULT_FOCUS_LIMIT = 10
export const MAX_FOCUS_LIMIT = 50

export const STALE_MS = 3 * 24 * 60 * 60 * 1000

const DAY_MS = 24 * 60 * 60 * 1000

export const DEFAULT_PROMPT_FOCUS_LIMIT = 20

export const FOCUS_EVIDENCE_MAX_CHARS = 40

export const FOCUS_TRANSITIONS: Record<FocusState, FocusState[]> = {
  open: ["doing", "blocked", "dropped"],
  doing: ["review", "blocked", "open", "dropped"],
  blocked: ["doing", "dropped"],
  review: ["done", "open"],
  done: ["open"],
  dropped: ["open"],
}

export type FocusRequiredField = "evidence" | "accept" | "why" | "reason"

export const FOCUS_REQUIREMENTS: Record<FocusState, FocusRequiredField[]> = {
  open: ["accept"],
  doing: ["evidence"],
  blocked: ["why"],
  review: [],
  done: ["evidence"],
  dropped: ["reason"],
}

export type FocusErrorCode = "missing-field" | "illegal-transition"

export class FocusError extends Error {
  readonly code: FocusErrorCode
  readonly field: string | undefined

  constructor(code: FocusErrorCode, message: string, field?: string) {
    super(message)
    this.name = "FocusError"
    this.code = code
    this.field = field
  }
}

export interface FocusItem {
  id: string
  text: string
  state: FocusState
  updatedAt: string

  evidence?: string[]

  seq?: number

  source?: string
  accept?: string
  why?: string
  reason?: string
}

export interface ListFocusOptions {
  includeDone?: boolean
  limit?: number
}

export interface ListFocusForPromptOptions {
  limit?: number
  now?: Date
}

export interface UpsertFocusInput {
  id?: string
  text?: string
  state?: string
  evidence?: string[]
  accept?: string
  why?: string
  reason?: string

  source?: string
  seq?: number

  now?: Date
}

export function isFocusState(value: unknown): value is FocusState {
  return typeof value === "string" && (FOCUS_STATES as readonly string[]).includes(value)
}

export function isTerminalFocusState(value: unknown): value is TerminalFocusState {
  return typeof value === "string" && (TERMINAL_FOCUS_STATES as readonly string[]).includes(value)
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

export function isStale(item: FocusItem, now: Date = new Date()): boolean {
  if (item.state !== "open" && item.state !== "doing" && item.state !== "blocked") return false
  const updated = Date.parse(item.updatedAt)
  if (!Number.isFinite(updated)) return false
  return now.getTime() - updated > STALE_MS
}

export function listFocus(db: DatabaseSync, opts: ListFocusOptions = {}): FocusItem[] {
  const includeDone = opts.includeDone === true
  const limit = clampLimit(opts.limit)
  const rows = (
    includeDone
      ? db.prepare("SELECT * FROM focus").all()
      : db.prepare("SELECT * FROM focus WHERE state IS NULL OR (state <> 'done' AND state <> 'dropped')").all()
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

export function openFocusCount(db: DatabaseSync): number {
  const row = db
    .prepare("SELECT count(*) AS n FROM focus WHERE state IS NULL OR (state <> 'done' AND state <> 'dropped')")
    .get()
  const value = row?.n
  return typeof value === "bigint" ? Number(value) : typeof value === "number" ? value : 0
}

export function upsertFocus(db: DatabaseSync, input: UpsertFocusInput): FocusItem {
  const now = input.now ?? new Date()
  const stamp = now.toISOString()
  const text = input.text === undefined ? undefined : input.text.trim().slice(0, MAX_FOCUS_TEXT)
  const state = isFocusState(input.state) ? input.state : undefined
  const id = typeof input.id === "string" && input.id.trim() !== "" ? input.id.trim() : undefined
  const evidence = input.evidence === undefined ? undefined : normalizeEvidence(input.evidence)
  const accept = cleanFocusField(input.accept)
  const why = cleanFocusField(input.why)
  const reason = cleanFocusField(input.reason)

  if (id !== undefined) {
    const existing = getFocus(db, id)
    if (existing !== undefined) {
      db.prepare(
        "UPDATE focus SET text = ?, state = ?, updated_at = ?, source = ?, seq = ?, evidence = ?, accept = ?, why = ?, reason = ? WHERE id = ?",
      ).run(
        text !== undefined && text !== "" ? text : existing.text,
        state ?? existing.state,
        stamp,
        input.source ?? existing.source ?? "agent",
        input.seq ?? existing.seq ?? null,
        evidence === undefined ? evidenceJson(existing.evidence ?? []) : evidenceJson(evidence),
        mergeFocusField(accept, existing.accept),
        mergeFocusField(why, existing.why),
        mergeFocusField(reason, existing.reason),
        id,
      )
      return getFocus(db, id) as FocusItem
    }
    if (text === undefined || text === "") throw new Error("focus needs text when the id is new")
    const twin = findFocusTwin(db, text)
    if (twin !== undefined) {
      return reuseFocus(db, twin, { text, state, stamp, evidence, accept, why, reason, input })
    }
    db.prepare(
      "INSERT INTO focus(id, text, state, updated_at, source, seq, evidence, accept, why, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      id,
      text,
      state ?? DEFAULT_FOCUS_STATE,
      stamp,
      input.source ?? "agent",
      input.seq ?? null,
      evidenceJson(evidence ?? []),
      accept ?? null,
      why ?? null,
      reason ?? null,
    )
    return getFocus(db, id) as FocusItem
  }

  if (text === undefined || text === "") throw new Error("focus needs text or an id")

  const twin = findFocusTwin(db, text)
  if (twin !== undefined) {
    return reuseFocus(db, twin, { text, state, stamp, evidence, accept, why, reason, input })
  }

  const fresh = newFocusId(now)
  db.prepare(
    "INSERT INTO focus(id, text, state, updated_at, source, seq, evidence, accept, why, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    fresh,
    text,
    state ?? DEFAULT_FOCUS_STATE,
    stamp,
    input.source ?? "agent",
    input.seq ?? null,
    evidenceJson(evidence ?? []),
    accept ?? null,
    why ?? null,
    reason ?? null,
  )
  return getFocus(db, fresh) as FocusItem
}

export function upsertFocusStrict(db: DatabaseSync, input: UpsertFocusInput): FocusItem {
  const id = typeof input.id === "string" && input.id.trim() !== "" ? input.id.trim() : undefined
  const existing = id === undefined ? undefined : getFocus(db, id)
  const state = isFocusState(input.state) ? input.state : existing?.state ?? DEFAULT_FOCUS_STATE
  const label = id ?? "new"

  if (existing !== undefined && existing.state !== state) {
    const allowed = FOCUS_TRANSITIONS[existing.state]
    if (!allowed.includes(state)) {
      throw new FocusError(
        "illegal-transition",
        `cannot move focus ${label} from ${existing.state} to ${state} (allowed: ${allowed.join(", ")})`,
        "state",
      )
    }
  }

  const validatesRequirements = existing === undefined || existing.state !== state
  if (validatesRequirements) {
    for (const field of FOCUS_REQUIREMENTS[state]) {
      if (!hasFocusField(input, existing, field)) {
        throw new FocusError(
          "missing-field",
          `moving focus ${label} to ${state} requires ${field}`,
          field,
        )
      }
    }
  }

  return upsertFocus(db, { ...input, ...(id !== undefined ? { id } : {}), state })
}

export function completeFocus(db: DatabaseSync, id: string, now: Date = new Date()): FocusItem | undefined {
  const existing = getFocus(db, id)
  if (existing === undefined) return undefined
  db.prepare("UPDATE focus SET state = 'done', updated_at = ? WHERE id = ?").run(now.toISOString(), id)
  return getFocus(db, id)
}

export function focusAgeDays(updatedAt: string, now: Date = new Date()): number {
  const at = Date.parse(updatedAt)
  if (!Number.isFinite(at)) return 0
  return Math.max(0, Math.floor((now.getTime() - at) / DAY_MS))
}

export function listFocusForPrompt(db: DatabaseSync, opts: ListFocusForPromptOptions = {}): FocusItem[] {
  const now = opts.now ?? new Date()
  const limit =
    typeof opts.limit === "number" && Number.isFinite(opts.limit)
      ? Math.max(1, Math.trunc(opts.limit))
      : DEFAULT_PROMPT_FOCUS_LIMIT
  const rows = db
    .prepare("SELECT * FROM focus WHERE state IS NULL OR (state <> 'done' AND state <> 'dropped')")
    .all() as unknown[]
  return rows
    .map(mapRow)
    .sort(
      (a, b) =>
        Number(isStale(b, now)) - Number(isStale(a, now)) ||
        FOCUS_ORDER[a.state] - FOCUS_ORDER[b.state] ||
        a.updatedAt.localeCompare(b.updatedAt) ||
        a.id.localeCompare(b.id),
    )
    .slice(0, limit)
}

export function formatFocusLine(item: FocusItem, now: Date = new Date()): string {
  const days = focusAgeDays(item.updatedAt, now)
  const head = isStale(item, now) ? `- [stale ${days}d] ${item.state} ${item.id}` : `- [${item.state}] ${item.id}`
  const evidence =
    item.evidence === undefined || item.evidence.length === 0
      ? "no evidence"
      : `evidence: ${item.evidence.map(clipFocusEvidence).join(", ")}`
  return `${head} ${oneLineText(item.text)}（${days}d, ${evidence}）`
}

function oneLineText(text: string): string {
  return text.replace(/\s+/gu, " ").trim()
}

function clipFocusEvidence(value: string): string {
  const text = oneLineText(value)
  return text.length > FOCUS_EVIDENCE_MAX_CHARS ? `${text.slice(0, FOCUS_EVIDENCE_MAX_CHARS)}…` : text
}

function findFocusTwin(db: DatabaseSync, text: string): FocusItem | undefined {
  const wanted = normalizeFocusText(text)
  const rows = db
    .prepare("SELECT * FROM focus WHERE state IS NULL OR (state <> 'done' AND state <> 'dropped')")
    .all() as unknown[]
  return rows
    .map(mapRow)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
    .find((item) => normalizeFocusText(item.text) === wanted)
}

function mergeEvidence(existing: string[] | undefined, incoming: string[]): string[] {
  return normalizeEvidence([...(existing ?? []), ...incoming])
}

function reuseFocus(
  db: DatabaseSync,
  twin: FocusItem,
  next: {
    text: string
    state: FocusState | undefined
    stamp: string
    evidence: string[] | undefined
    accept: string | undefined
    why: string | undefined
    reason: string | undefined
    input: UpsertFocusInput
  },
): FocusItem {
  const evidence =
    next.evidence === undefined ? evidenceJson(twin.evidence ?? []) : evidenceJson(mergeEvidence(twin.evidence, next.evidence))
  db.prepare(
    "UPDATE focus SET text = ?, state = ?, updated_at = ?, source = ?, seq = ?, evidence = ?, accept = ?, why = ?, reason = ? WHERE id = ?",
  ).run(
    next.text,
    next.state ?? twin.state,
    next.stamp,
    next.input.source ?? "agent",
    next.input.seq ?? twin.seq ?? null,
    evidence,
    mergeFocusField(next.accept, twin.accept),
    mergeFocusField(next.why, twin.why),
    mergeFocusField(next.reason, twin.reason),
    twin.id,
  )
  return getFocus(db, twin.id) as FocusItem
}

function parseFocusEvidence(raw: unknown): string[] {
  if (typeof raw !== "string") return []
  const trimmed = raw.trim()
  if (trimmed === "") return []
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return normalizeEvidence(parsed)
}

function normalizeEvidence(values: unknown[]): string[] {
  const out: string[] = []
  for (const value of values) {
    if (typeof value !== "string") continue
    const trimmed = value.trim()
    if (trimmed === "" || out.includes(trimmed)) continue
    out.push(trimmed)
  }
  return out
}

function evidenceJson(evidence: string[]): string | null {
  return evidence.length === 0 ? null : JSON.stringify(evidence)
}

function cleanFocusField(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed === "" ? undefined : trimmed
}

function mergeFocusField(incoming: string | undefined, existing: string | undefined): string | null {
  return incoming ?? cleanFocusField(existing) ?? null
}

function hasFocusField(
  input: UpsertFocusInput,
  existing: FocusItem | undefined,
  field: FocusRequiredField,
): boolean {
  if (field === "evidence") {
    if (input.evidence !== undefined) return normalizeEvidence(input.evidence).length > 0
    return (existing?.evidence?.length ?? 0) > 0
  }
  if (cleanFocusField(input[field]) !== undefined) return true
  return cleanFocusField(existing?.[field]) !== undefined
}

function mapRow(raw: unknown): FocusItem {
  const row = isRecord(raw) ? raw : {}
  const state = isFocusState(row.state) ? row.state : DEFAULT_FOCUS_STATE
  const seq = typeof row.seq === "number" ? row.seq : typeof row.seq === "bigint" ? Number(row.seq) : undefined
  const accept = typeof row.accept === "string" ? row.accept : undefined
  const why = typeof row.why === "string" ? row.why : undefined
  const reason = typeof row.reason === "string" ? row.reason : undefined
  return {
    id: typeof row.id === "string" ? row.id : "",
    text: typeof row.text === "string" ? row.text : "",
    state,
    updatedAt: typeof row.updated_at === "string" ? row.updated_at : "",
    evidence: parseFocusEvidence(row.evidence),
    ...(seq !== undefined ? { seq } : {}),
    ...(typeof row.source === "string" ? { source: row.source } : {}),
    ...(accept !== undefined ? { accept } : {}),
    ...(why !== undefined ? { why } : {}),
    ...(reason !== undefined ? { reason } : {}),
  }
}

function clampLimit(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(1, Math.min(Math.trunc(value), MAX_FOCUS_LIMIT))
  }
  return DEFAULT_FOCUS_LIMIT
}
