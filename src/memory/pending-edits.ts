import type { DatabaseSync } from "node:sqlite"

export interface PendingEditRow {
  proposalId: string
  jobId: string
  branch: string
  base: string
  task: string
  createdAt: string
}

export function claimPendingEdit(db: DatabaseSync, row: PendingEditRow): void {
  db.prepare(
    "INSERT OR REPLACE INTO self_edit_pending(job_id, proposal_id, branch, base, task, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(row.jobId, row.proposalId, row.branch, row.base, row.task, row.createdAt)
}

export function getPendingEdit(db: DatabaseSync, jobId: string): PendingEditRow | undefined {
  const key = jobId.trim()
  if (key === "") return undefined
  return toRow(db.prepare("SELECT * FROM self_edit_pending WHERE job_id = ?").get(key))
}

export function releasePendingEdit(db: DatabaseSync, jobId: string): void {
  const key = jobId.trim()
  if (key === "") return
  db.prepare("DELETE FROM self_edit_pending WHERE job_id = ?").run(key)
}

export function listPendingEdits(db: DatabaseSync): PendingEditRow[] {
  const rows = db.prepare("SELECT * FROM self_edit_pending ORDER BY created_at ASC, job_id ASC").all()
  return rows.map(toRow).filter((row): row is PendingEditRow => row !== undefined)
}

function toRow(raw: unknown): PendingEditRow | undefined {
  if (typeof raw !== "object" || raw === null) return undefined
  const row = raw as Record<string, unknown>
  const jobId = text(row.job_id)
  const proposalId = text(row.proposal_id)
  const branch = text(row.branch)
  const base = text(row.base)
  const createdAt = text(row.created_at)
  if (jobId === undefined || proposalId === undefined || branch === undefined) return undefined
  if (base === undefined || createdAt === undefined) return undefined
  return {
    proposalId,
    jobId,
    branch,
    base,
    task: typeof row.task === "string" ? row.task : "",
    createdAt,
  }
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined
}
