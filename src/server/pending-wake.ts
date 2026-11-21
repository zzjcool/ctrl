import type { DatabaseSync } from "node:sqlite"
import { META_PENDING_WAKE, readMeta } from "../memory/db.ts"

export interface PendingWakeDeps {
  db: () => DatabaseSync | undefined
  inject: (text: string) => void
  warn?: (message: string) => void
}

export function flushPendingWake(deps: PendingWakeDeps): boolean {
  const warn = deps.warn ?? ((message: string) => process.stderr.write(`ctrl: ${message}\n`))
  const db = deps.db()
  if (db === undefined) return false

  let text: string | undefined
  try {
    text = readMeta(db, META_PENDING_WAKE)
  } catch (error) {
    warn(`could not read the pending wake: ${errorMessage(error)}`)
    return false
  }
  const body = text === undefined ? "" : text.trim()
  if (body === "") return false

  try {
    deps.inject(body)
  } catch (error) {
    warn(`the pending wake could not be delivered, keeping it for the next boot: ${errorMessage(error)}`)
    return false
  }

  try {
    db.prepare("DELETE FROM meta WHERE key = ?").run(META_PENDING_WAKE)
  } catch (error) {
    warn(`the pending wake was delivered but not cleared: ${errorMessage(error)}`)
  }
  return true
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
