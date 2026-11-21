import type { ServerResponse } from "node:http"
import { DEFAULT_LIST_LIMIT, listJobs, readJobLogRaw } from "../jobs/store.ts"
import { renderStream } from "../jobs/stream.ts"
import type { JobView } from "../jobs/store.ts"
import { sendJson } from "./http.ts"
import { methodNotAllowed } from "./routes.ts"
import type { AppContext } from "./routes.ts"

const SUMMARY_MAX_LINES = 15
const SUMMARY_MAX_CHARS = 3_000
const TRUNCATION_MARK = "…"

export function handleJobsRoute(response: ServerResponse, ctx: AppContext, method: string): void {
  if (method !== "GET") {
    methodNotAllowed(response, method)
    return
  }
  sendJson(response, 200, {
    jobs: listJobs(ctx.agentHome, { limit: DEFAULT_LIST_LIMIT }).map((job) => jobSummary(job, ctx.agentHome)),
  })
}

export function jobSummary(job: JobView, agentHome?: string): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    id: job.id,
    state: job.state,
    task: job.task,
    startedAt: job.startedAt,
    elapsedMs: job.elapsedMs,
    ...(typeof job.code === "number" ? { code: job.code } : {}),
  }

  if (agentHome !== undefined) {
    const full = renderStream(readJobLogRaw(agentHome, job.id, 64 * 1024), { maxLines: 0 }).trimEnd()
    if (full !== "") {
      const lines = full.split("\n")
      const byLines = lines.length > SUMMARY_MAX_LINES ? lines.slice(-SUMMARY_MAX_LINES).join("\n") : full
      const byChars = byLines.length > SUMMARY_MAX_CHARS ? byLines.slice(-SUMMARY_MAX_CHARS) : byLines
      const truncated = lines.length > SUMMARY_MAX_LINES || byChars.length < byLines.length
      summary.output = truncated && !byChars.startsWith(TRUNCATION_MARK) ? `${TRUNCATION_MARK}${byChars}` : byChars
    }
  }
  return summary
}
