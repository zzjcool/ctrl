import type { ServerResponse } from "node:http"
import { DEFAULT_LIST_LIMIT, listJobs, readJobLog } from "../jobs/store.ts"
import { renderStream } from "../jobs/stream.ts"
import type { JobView } from "../jobs/store.ts"
import { sendJson } from "./http.ts"
import { methodNotAllowed } from "./routes.ts"
import type { AppContext } from "./routes.ts"

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
    const log = readJobLog(agentHome, job.id, { full: true })
    const text = renderStream(log.text, { maxLines: 15 }).trimEnd()
    if (text !== "") summary.output = text.length > 3_000 ? `…${text.slice(-3_000)}` : text
  }
  return summary
}
