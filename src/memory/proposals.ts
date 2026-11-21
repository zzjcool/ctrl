import type { DatabaseSync } from "node:sqlite"

export const DEFAULT_PROPOSAL_LIMIT = 20

export const MAX_PROPOSAL_LIMIT = 100

export const PROPOSAL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

export type ProposalStatus = "open" | "failed" | "applied" | "discarded"

export const NO_CHANGES_ERROR = "the worker produced no changes"

export const VERIFICATION_FAILED_ERROR = "verification did not pass"

export interface ProposalTestResult {
  ok: boolean
  output?: string
}

export type ProposalTests = Record<string, ProposalTestResult>

export interface Proposal {
  id: string
  branch: string
  base: string
  task: string
  status: ProposalStatus
  createdAt: string
  jobId?: string
  summary?: string
  diffstat?: string
  endedAt?: string
  appliedAt?: string
  mergedCommit?: string
  tests?: ProposalTests
  error?: string
}

export interface ProposalDraft {
  id: string
  branch: string
  base: string
  task: string
  createdAt?: string
  jobId?: string
  summary?: string
  diffstat?: string
  status?: ProposalStatus
  tests?: ProposalTests
  error?: string
}

export interface ProposalPatch {
  status?: ProposalStatus
  jobId?: string
  summary?: string
  diffstat?: string
  endedAt?: string
  appliedAt?: string
  mergedCommit?: string
  tests?: ProposalTests
  error?: string
}

export function createProposal(db: DatabaseSync, draft: ProposalDraft): Proposal {
  const createdAt = draft.createdAt ?? new Date().toISOString()
  const status = draft.status ?? "open"
  db.prepare(
    "INSERT INTO proposals(id, branch, base, task, summary, diffstat, status, created_at, ended_at, tests, error, applied_at, merged_commit, job_id) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    draft.id,
    draft.branch,
    draft.base,
    draft.task,
    draft.summary ?? null,
    draft.diffstat ?? null,
    status,
    createdAt,
    null,
    draft.tests === undefined ? null : JSON.stringify(draft.tests),
    draft.error ?? null,
    null,
    null,
    draft.jobId ?? null,
  )
  const stored = getProposal(db, draft.id)
  if (stored !== undefined) return stored
  return {
    id: draft.id,
    branch: draft.branch,
    base: draft.base,
    task: draft.task,
    status,
    createdAt,
    ...(draft.jobId !== undefined ? { jobId: draft.jobId } : {}),
    ...(draft.summary !== undefined ? { summary: draft.summary } : {}),
    ...(draft.diffstat !== undefined ? { diffstat: draft.diffstat } : {}),
    ...(draft.tests !== undefined ? { tests: draft.tests } : {}),
    ...(draft.error !== undefined ? { error: draft.error } : {}),
  }
}

export function updateProposal(db: DatabaseSync, id: string, patch: ProposalPatch): Proposal | undefined {
  const current = getProposal(db, id)
  if (current === undefined) return undefined
  db.prepare(
    "UPDATE proposals SET status = ?, summary = ?, diffstat = ?, ended_at = ?, tests = ?, error = ?, applied_at = ?, merged_commit = ?, job_id = ? WHERE id = ?",
  ).run(
    patch.status ?? current.status,
    patch.summary ?? current.summary ?? null,
    patch.diffstat ?? current.diffstat ?? null,
    patch.endedAt ?? current.endedAt ?? null,
    patch.tests === undefined ? (current.tests === undefined ? null : JSON.stringify(current.tests)) : JSON.stringify(patch.tests),
    patch.error ?? current.error ?? null,
    patch.appliedAt ?? current.appliedAt ?? null,
    patch.mergedCommit ?? current.mergedCommit ?? null,
    patch.jobId ?? current.jobId ?? null,
    id,
  )
  return getProposal(db, id)
}

export function getProposal(db: DatabaseSync, id: string): Proposal | undefined {
  return toProposal(db.prepare("SELECT * FROM proposals WHERE id = ?").get(id))
}

export function getProposalByJob(db: DatabaseSync, jobId: string): Proposal | undefined {
  const key = jobId.trim()
  if (key === "") return undefined
  return toProposal(
    db.prepare("SELECT * FROM proposals WHERE job_id = ? ORDER BY created_at DESC, id DESC LIMIT 1").get(key),
  )
}

export function proposalStatusFor(tests: ProposalTests | undefined): ProposalStatus {
  return testsGreen(tests) ? "open" : "failed"
}

export function listProposals(
  db: DatabaseSync,
  opts: { limit?: number; status?: ProposalStatus } = {},
): Proposal[] {
  const limit = clampLimit(opts.limit)
  const rows =
    opts.status === undefined
      ? db.prepare("SELECT * FROM proposals ORDER BY created_at DESC, id DESC LIMIT ?").all(limit)
      : db.prepare("SELECT * FROM proposals WHERE status = ? ORDER BY created_at DESC, id DESC LIMIT ?").all(opts.status, limit)
  return rows.map(toProposal).filter((proposal): proposal is Proposal => proposal !== undefined)
}

export function testsGreen(tests: ProposalTests | undefined): boolean {
  if (tests === undefined) return false
  const results = Object.values(tests)
  return results.length > 0 && results.every((result) => result.ok === true)
}

export function failingTests(tests: ProposalTests | undefined): string[] {
  if (tests === undefined) return []
  return Object.entries(tests)
    .filter(([, result]) => result.ok !== true)
    .map(([name]) => name)
}

export function parseProposalTests(raw: unknown): ProposalTests | undefined {
  const text = typeof raw === "string" ? raw : undefined
  if (text === undefined || text.trim() === "") return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined
  const tests: ProposalTests = {}
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue
    const record = value as Record<string, unknown>
    if (typeof record.ok !== "boolean") continue
    tests[name] = {
      ok: record.ok,
      ...(typeof record.output === "string" ? { output: record.output } : {}),
    }
  }
  return Object.keys(tests).length > 0 ? tests : undefined
}

function clampLimit(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) return DEFAULT_PROPOSAL_LIMIT
  return Math.min(Math.floor(requested), MAX_PROPOSAL_LIMIT)
}

function toProposal(raw: unknown): Proposal | undefined {
  if (typeof raw !== "object" || raw === null) return undefined
  const row = raw as Record<string, unknown>
  const id = text(row.id)
  const branch = text(row.branch)
  const base = text(row.base)
  const task = text(row.task)
  const status = proposalStatus(row.status)
  const createdAt = text(row.created_at)
  if (id === undefined || branch === undefined || base === undefined || task === undefined) return undefined
  if (status === undefined || createdAt === undefined) return undefined
  const jobId = text(row.job_id)
  const summary = text(row.summary)
  const diffstat = text(row.diffstat)
  const endedAt = text(row.ended_at)
  const appliedAt = text(row.applied_at)
  const mergedCommit = text(row.merged_commit)
  const error = text(row.error)
  const tests = parseProposalTests(row.tests)
  return {
    id,
    branch,
    base,
    task,
    status,
    createdAt,
    ...(jobId !== undefined ? { jobId } : {}),
    ...(summary !== undefined ? { summary } : {}),
    ...(diffstat !== undefined ? { diffstat } : {}),
    ...(endedAt !== undefined ? { endedAt } : {}),
    ...(appliedAt !== undefined ? { appliedAt } : {}),
    ...(mergedCommit !== undefined ? { mergedCommit } : {}),
    ...(error !== undefined ? { error } : {}),
    ...(tests !== undefined ? { tests } : {}),
  }
}

function proposalStatus(value: unknown): ProposalStatus | undefined {
  return value === "open" || value === "failed" || value === "applied" || value === "discarded"
    ? value
    : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined
}
