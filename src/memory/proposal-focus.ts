import type { DatabaseSync } from "node:sqlite"
import { getFocus, upsertFocus } from "../memory/focus.ts"
import type { FocusItem } from "../memory/focus.ts"

export const MERGED_COMMIT_CHARS = 12

export const FOCUS_EVIDENCE_SUMMARY_CHARS = 40

export function syncFocusOnApplied(
  db: DatabaseSync | undefined,
  proposalId: string,
  mergedCommit?: string,
): void {
  if (db === undefined) return
  const note = appliedNote(proposalId, mergedCommit)
  for (const item of focusItemsFor(db, proposalId)) {
    upsertFocus(db, { id: item.id, state: "review", evidence: appendEvidence(item, note) })
  }
}

export function syncFocusOnClosed(
  db: DatabaseSync | undefined,
  proposalId: string,
  state: "failed" | "discarded",
  summary: string,
): void {
  if (db === undefined) return
  const note = closedNote(state, summary)
  for (const item of focusItemsFor(db, proposalId)) {
    upsertFocus(db, { id: item.id, state: "open", evidence: appendEvidence(item, note) })
  }
}

function appliedNote(proposalId: string, mergedCommit: string | undefined): string {
  const sha = typeof mergedCommit === "string" ? mergedCommit.trim() : ""
  if (sha === "") return `applied:${proposalId.trim()}`
  return `applied:${[...sha].slice(0, MERGED_COMMIT_CHARS).join("")}`
}

function closedNote(state: "failed" | "discarded", summary: string): string {
  const text = clipSummary(typeof summary === "string" ? summary : "")
  if (text === "") return state
  return `${state}:${text}`
}

function clipSummary(text: string): string {
  const chars = [...text.replace(/\s+/gu, " ").trim()]
  return chars.length > FOCUS_EVIDENCE_SUMMARY_CHARS
    ? chars.slice(0, FOCUS_EVIDENCE_SUMMARY_CHARS).join("")
    : chars.join("")
}

function appendEvidence(item: FocusItem, note: string): string[] {
  const next = [...(item.evidence ?? [])]
  if (!next.includes(note)) next.push(note)
  return next
}

function focusItemsFor(db: DatabaseSync, proposalId: string): FocusItem[] {
  const id = typeof proposalId === "string" ? proposalId.trim() : ""
  if (id === "") return []
  const rows = db.prepare("SELECT id FROM focus WHERE evidence LIKE ? ESCAPE '\\'").all(`%${escapeLike(id)}%`)
  const items: FocusItem[] = []
  for (const row of rows) {
    const value = (row as Record<string, unknown> | undefined)?.id
    if (typeof value !== "string") continue
    const item = getFocus(db, value)
    if (item === undefined) continue
    if (!(item.evidence ?? []).some((entry) => entry.includes(id))) continue
    items.push(item)
  }
  return items
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, (char) => `\\${char}`)
}
