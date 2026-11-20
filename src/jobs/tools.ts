import type { JsonSchema, ToolResult, ToolSpec } from "../engine/durable.ts"
import type { JobRunner } from "./runner.ts"
import {
  DEFAULT_STATUS_LIST,
  DEFAULT_TAIL_LINES,
  MAX_OUTPUT_CHARS,
  listJobs,
  readJob,
  readJobLog,
  waitForJob,
} from "./store.ts"
import { renderStream } from "./stream.ts"

export const DEFAULT_WAIT_MS = 8_000
import type { JobState, JobView } from "./store.ts"

export interface JobToolsOptions {
  runner: JobRunner

  agentHome: string
}

function schema(properties: Record<string, unknown>, required: string[] = []): JsonSchema {
  return { type: "object", properties, required, additionalProperties: false }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function guard(run: () => Promise<ToolResult> | ToolResult): Promise<ToolResult> {
  try {
    return await run()
  } catch (error) {
    return { ok: false, output: errorMessage(error) }
  }
}

export function formatElapsed(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : 0
  if (total < 60_000) return `${(total / 1000).toFixed(1)}s`
  const seconds = Math.floor(total / 1000)
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`
  const minutes = Math.floor(seconds / 60)
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`
}

export function formatExit(job: JobView): string | undefined {
  if (typeof job.code === "number") return `exit: ${job.code}`
  if (typeof job.signal === "string" && job.signal !== "") return `exit: signal ${job.signal}`
  if (job.state === "killed") return "exit: signal"
  return undefined
}

function waitMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_WAIT_MS
  return Math.max(0, Math.min(8_500, Math.floor(value)))
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function clipChars(text: string, max: number): string {
  return text.length <= max ? text : text.slice(text.length - max)
}

const STATE_HINTS: Partial<Record<JobState, string>> = {
  lost: "the worker process is gone and never recorded an exit — ctrl restarted while it ran",
  running: "still working; poll again with job_status",
  killed: "the worker was stopped",
}

export function renderJobStatus(
  agentHome: string,
  job: JobView,
  opts: { lines?: number; full?: boolean } = {},
): string {
  const exit = formatExit(job)
  const header = [
    `job ${job.id}`,
    `state: ${job.state}${exit !== undefined ? `  ${exit}` : ""}  elapsed: ${formatElapsed(job.elapsedMs)}`,
    `cwd: ${job.cwd}  model: ${job.model}  thinking: ${job.thinking}`,
    `task: ${oneLine(job.task, 200)}`,
  ]
  const hint = STATE_HINTS[job.state]
  if (hint !== undefined) header.push(`note: ${hint}`)

  const log = readJobLog(agentHome, job.id, { lines: 0 })
  const full = opts.full === true
  const rendered = renderStream(log.text, { maxLines: full ? 0 : (opts.lines ?? DEFAULT_TAIL_LINES) }).trimEnd()
  const clipped = full ? clipChars(rendered, MAX_OUTPUT_CHARS) : rendered
  const body = clipped === "" ? "(no output yet)" : clipped
  const truncation = full && clipped.length < rendered.length
    ? `\n(truncated to the last ${MAX_OUTPUT_CHARS} characters — ask for lines=N to page the tail)`
    : ""
  return `${header.join("\n")}\n\n${body}${truncation}`
}

export const POLL_LIMIT = 3

export function createJobTools(opts: JobToolsOptions): ToolSpec[] {
  const { runner, agentHome } = opts
  const polls = new Map<string, { count: number; at: number }>()

  return [
    {
      name: "delegate",
      description:
        "Hand a task to a background pi worker and return immediately with a job id. " +
        "You cannot edit files or run commands yourself: reading, searching, running tests and " +
        "editing all happen in the worker. Poll the result with job_status. " +
        "At most 3 workers run at once.",
      parameters: schema(
        {
          task: {
            type: "string",
            description: "The task, in full sentences. The worker sees only this text, so name files, commands and expected results.",
          },
          cwd: { type: "string", description: "Working directory for the worker. Default: the agent's workspace." },
          model: { type: "string", description: "Model for the worker. Default: this agent's model." },
          thinking: { type: "string", description: "Thinking budget for the worker: off|low|medium|high|max." },
        },
        ["task"],
      ),
      async execute(args, ctx) {
        return await guard(async () => {
          const reply = runner.delegate(
            {
              task: typeof args.task === "string" ? args.task : "",
              ...(typeof args.cwd === "string" ? { cwd: args.cwd } : {}),
              ...(typeof args.model === "string" ? { model: args.model } : {}),
              ...(typeof args.thinking === "string" ? { thinking: args.thinking } : {}),
            },
            ctx.cwd,
          )
          if (!reply.ok || reply.id === undefined) return reply

          const wait = waitMs(args.wait)
          const job = await waitForJob(agentHome, reply.id, wait)
          if (job === undefined || job.state === "running") {
            return { ok: true, output: `started job ${reply.id} — poll with job_status` }
          }
          return { ok: true, output: renderJobStatus(agentHome, job) }
        })
      },
    },
    {
      name: "job_status",
      description:
        "Read a worker job: its state (running/exited/failed/killed/lost), elapsed time, exit code " +
        "and the tail of its output. Without an id it lists the recent jobs. " +
        "Poll until the state is no longer running, then summarise it for the user — do not paste the whole log.",
      parameters: schema({
        id: { type: "string", description: "The job id from delegate. Omit to list the recent jobs." },
        lines: {
          type: "integer",
          minimum: 1,
          description: `How many trailing output lines to return. Default ${DEFAULT_TAIL_LINES}.`,
        },
        full: { type: "boolean", description: `Return the whole log instead of the tail (capped at ${MAX_OUTPUT_CHARS} characters).` },
        wait: {
          type: "integer",
          minimum: 0,
          maximum: 8500,
          description: `Wait this many milliseconds for a running job to finish before returning. Default ${DEFAULT_WAIT_MS}.`,
        },
      }),
      async execute(args) {
        return await guard(async () => {
          const lines =
            typeof args.lines === "number" && Number.isFinite(args.lines) ? Math.floor(args.lines) : undefined
          const full = args.full === true
          const id = typeof args.id === "string" ? args.id.trim() : ""
          if (id === "") {
            const jobs = listJobs(agentHome, { limit: DEFAULT_STATUS_LIST })
            if (jobs.length === 0) return { ok: true, output: "no jobs yet — start one with delegate" }
            return {
              ok: true,
              output: jobs
                .map((job) => `${job.id}  ${job.state.padEnd(7)}  ${formatElapsed(job.elapsedMs).padStart(8)}  ${oneLine(job.task, 60)}`)
                .join("\n"),
            }
          }
          const job = await waitForJob(agentHome, id, waitMs(args.wait))
          if (job === undefined) return { ok: false, output: `no such job: ${id}` }
          const text = renderJobStatus(agentHome, job, { ...(lines !== undefined ? { lines } : {}), full })
          if (job.state !== "running") {
            polls.delete(id)
            return { ok: true, output: text }
          }
          const now = Date.now()
          const seen = polls.get(id)
          const count = seen !== undefined && now - seen.at < 120_000 ? seen.count + 1 : 1
          polls.set(id, { count, at: now })
          if (count < POLL_LIMIT) return { ok: true, output: text }
          return {
            ok: true,
            output:
              `${text}\n\nYou have checked this job ${count} times and it is still running. ` +
              "Stop polling: end your turn and tell the user it is still running, or call job_stop.",
          }
        })
      },
    },
    {
      name: "job_stop",
      description: "Stop a running worker with SIGTERM. Returns once the process is gone.",
      parameters: schema({ id: { type: "string", description: "The job id from delegate." } }, ["id"]),
      async execute(args) {
        return await guard(async () => {
          const id = typeof args.id === "string" ? args.id.trim() : ""
          if (id === "") return { ok: false, output: "job_stop requires an id" }
          return await runner.stop(id)
        })
      },
    },
  ]
}
