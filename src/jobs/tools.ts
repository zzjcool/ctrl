// The three tools ctrl has instead of hands (CONTRACT §5).
//
//   delegate    start a pi worker, return immediately
//   job_status  read a job from disk (or list the recent ones)
//   job_stop    SIGTERM the worker's process group
//
// Everything returns `{ ok, output }` and nothing throws: a tool error is a
// sentence the model can act on, not a stack trace in the transcript.

import type { JsonSchema, ToolResult, ToolSpec } from "../engine/durable.ts"
import type { JobRunner } from "./runner.ts"
import {
  DEFAULT_STATUS_LIST,
  DEFAULT_TAIL_LINES,
  MAX_OUTPUT_CHARS,
  listJobs,
  readJob,
  readJobLog,
} from "./store.ts"
import type { JobState, JobView } from "./store.ts"

export interface JobToolsOptions {
  runner: JobRunner
  /** `<root>/agents/<name>` — where the jobs live. */
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

/** `3.2s`, `1m 05s`, `2h 03m` — short enough for a status line. */
export function formatElapsed(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : 0
  if (total < 60_000) return `${(total / 1000).toFixed(1)}s`
  const seconds = Math.floor(total / 1000)
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`
  const minutes = Math.floor(seconds / 60)
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`
}

/** `exit: 0` for a code, `exit: signal SIGTERM` for a signal, nothing if unknown. */
export function formatExit(job: JobView): string | undefined {
  if (typeof job.code === "number") return `exit: ${job.code}`
  if (typeof job.signal === "string" && job.signal !== "") return `exit: signal ${job.signal}`
  if (job.state === "killed") return "exit: signal"
  return undefined
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

const STATE_HINTS: Partial<Record<JobState, string>> = {
  lost: "the worker process is gone and never recorded an exit — ctrl restarted while it ran",
  running: "still working; poll again with job_status",
  killed: "the worker was stopped",
}

/** One job: what it is, how it ended, and the tail of what it said. */
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

  const log = readJobLog(agentHome, job.id, { lines: opts.lines, full: opts.full })
  const body = log.text.trimEnd() === "" ? "(no output yet)" : log.text.trimEnd()
  const truncation = log.truncated
    ? `\n(truncated to the last ${MAX_OUTPUT_CHARS} characters — ask for lines=N to page the tail)`
    : ""
  return `${header.join("\n")}\n\n${body}${truncation}`
}

export function createJobTools(opts: JobToolsOptions): ToolSpec[] {
  const { runner, agentHome } = opts

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
        return await guard(() =>
          runner.delegate(
            {
              task: typeof args.task === "string" ? args.task : "",
              ...(typeof args.cwd === "string" ? { cwd: args.cwd } : {}),
              ...(typeof args.model === "string" ? { model: args.model } : {}),
              ...(typeof args.thinking === "string" ? { thinking: args.thinking } : {}),
            },
            ctx.cwd,
          ),
        )
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
      }),
      async execute(args) {
        return await guard(() => {
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
          const job = readJob(agentHome, id)
          if (job === undefined) return { ok: false, output: `no such job: ${id}` }
          return { ok: true, output: renderJobStatus(agentHome, job, { ...(lines !== undefined ? { lines } : {}), full }) }
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
