import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { resolvePaths } from "../engine/durable.ts"

export interface SessionSidecar {

  cwd: string
  createdAt: string
}

export const SIDECAR_FILENAME = "ctrl.json"

export function sidecarPath(home: string | undefined, sessionId: string): string {
  if (!isSessionId(sessionId)) throw new Error(`invalid session id: ${sessionId}`)
  return path.join(resolvePaths(home).sessionDir(sessionId), SIDECAR_FILENAME)
}

export function writeSidecar(
  home: string | undefined,
  sessionId: string,
  value: SessionSidecar,
): SessionSidecar {
  const file = sidecarPath(home, sessionId)
  const record: SessionSidecar = { cwd: value.cwd, createdAt: value.createdAt }
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, "utf8")
  return record
}

export function readSidecar(home: string | undefined, sessionId: string): SessionSidecar | undefined {
  let file: string
  try {
    file = sidecarPath(home, sessionId)
  } catch {
    return undefined
  }
  let raw: string
  try {
    raw = readFileSync(file, "utf8")
  } catch {
    return undefined
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined
    const candidate = parsed as Partial<SessionSidecar> & { remoteCwd?: unknown }

    const cwd = typeof candidate.cwd === "string" && candidate.cwd !== ""
      ? candidate.cwd
      : typeof candidate.remoteCwd === "string"
        ? candidate.remoteCwd
        : undefined
    if (cwd === undefined || cwd === "") return undefined
    return {
      cwd,
      createdAt: typeof candidate.createdAt === "string" ? candidate.createdAt : new Date(0).toISOString(),
    }
  } catch {
    return undefined
  }
}

export function isSessionId(value: string): boolean {
  return /^[a-zA-Z0-9_-]{1,80}$/.test(value)
}
