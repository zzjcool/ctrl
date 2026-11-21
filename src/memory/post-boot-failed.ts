import { existsSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import type { DatabaseSync } from "node:sqlite"
import { getProposal, updateProposal } from "./proposals.ts"
import { errorMessage } from "../selfedit/git.ts"

export const POST_BOOT_MARKER = "post-boot-failed"

export const POST_BOOT_REASONS = ["post_boot_failed", "experience_failed"] as const

export type PostBootReason = (typeof POST_BOOT_REASONS)[number]

export const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/

export interface PostBootMarker {
  sha: string
  reason: PostBootReason
  note: string
}

export interface PostBootFailure extends PostBootMarker {
  path: string
  proposalId?: string
}

export interface PostBootFailureOptions {
  db?: DatabaseSync
  agentHome?: string
  root?: string
  warn?: (message: string) => void
}

export function postBootMarkerPaths(opts: { agentHome?: string; root?: string }): string[] {
  const paths: string[] = []
  for (const dir of [opts.agentHome, opts.root]) {
    if (dir === undefined || dir.trim() === "") continue
    const path = join(dir, POST_BOOT_MARKER)
    if (!paths.includes(path)) paths.push(path)
  }
  return paths
}

export function parsePostBootMarker(text: string): PostBootMarker | undefined {
  const fields = text.trim().split(/\s+/).filter((field) => field !== "")
  const first = fields[0] ?? ""
  const prefix = POST_BOOT_REASONS.find((reason) => reason === first)
  const sha = (prefix === undefined ? first : fields[1] ?? "").toLowerCase()
  if (!COMMIT_SHA_PATTERN.test(sha)) return undefined
  const rest = prefix === undefined ? fields.slice(1) : fields.slice(2)
  return { sha, reason: prefix ?? "post_boot_failed", note: rest.join(" ") }
}

export function consumePostBootFailure(opts: PostBootFailureOptions): PostBootFailure[] {
  const warn = opts.warn ?? ((message: string) => process.stderr.write(`ctrl: ${message}\n`))
  const consumed: PostBootFailure[] = []
  for (const path of postBootMarkerPaths(opts)) {
    if (!existsSync(path)) continue
    let text: string | undefined
    try {
      text = readFileSync(path, "utf8")
    } catch (error) {
      warn(`could not read the post-boot failure marker ${path}: ${errorMessage(error)}`)
    }
    removeMarker(path, warn)
    if (text === undefined) continue
    const marker = parsePostBootMarker(text)
    if (marker === undefined) {
      warn(`ignoring the post-boot failure marker ${path}: "${oneLine(text, 120)}" has no 40-hex commit`)
      continue
    }
    const proposalId = markFailed(opts.db, marker, warn)
    consumed.push({ path, ...marker, ...(proposalId !== undefined ? { proposalId } : {}) })
  }
  return consumed
}

function markFailed(db: DatabaseSync | undefined, marker: PostBootMarker, warn: (message: string) => void): string | undefined {
  if (db === undefined) {
    warn(`no memory database — the post-boot failure of ${marker.sha} was not recorded`)
    return undefined
  }
  let id: string | undefined
  try {
    const row = db
      .prepare(
        "SELECT id FROM proposals WHERE merged_commit = ? AND status = 'applied' ORDER BY applied_at DESC, created_at DESC LIMIT 1",
      )
      .get(marker.sha)
    const value = typeof row === "object" && row !== null ? (row as Record<string, unknown>).id : undefined
    id = typeof value === "string" && value !== "" ? value : undefined
  } catch (error) {
    warn(`could not look up the applied proposal for ${marker.sha}: ${errorMessage(error)}`)
    return undefined
  }
  if (id === undefined) {
    warn(`the post-boot failure names ${marker.sha}, but no applied proposal has that merged commit`)
    return undefined
  }
  try {
    const current = getProposal(db, id)
    const error = [current?.error, marker.note].filter((part): part is string => part !== undefined && part.trim() !== "").join("; ")
    updateProposal(db, id, {
      status: "failed",
      reason: marker.reason,
      ...(error !== "" ? { error } : {}),
    })
    warn(`proposal ${id} failed the post-boot check (${marker.reason}) — marked failed`)
    return id
  } catch (caught) {
    warn(`could not mark proposal ${id} as failed after the post-boot check: ${errorMessage(caught)}`)
    return undefined
  }
}

function removeMarker(path: string, warn: (message: string) => void): void {
  try {
    rmSync(path, { force: true })
  } catch (error) {
    warn(`could not remove the post-boot failure marker ${path}: ${errorMessage(error)}`)
  }
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > max ? flat.slice(0, max) : flat
}
