// The execution tools (CONTRACT §6). Names, descriptions and schemas for
// read_file / write_file / list_dir / bash are copied from pi-durable so the
// model cannot tell which backend it got — that transparency is the point.
//
// Everything returns `{ ok, output }`. A tool never throws: pi-durable would
// catch it anyway, but the model would then be reading a stack trace.

import type { JsonSchema, ToolResult, ToolSpec } from "../engine/durable.ts"
import type { ExecResult, Executor } from "../exec/types.ts"

const READ_FILE_MAX_CHARS = 20_000

export interface ExecutionToolOptions {
  /** `bash` is hidden unless the operator asked for it (CONTRACT §6). */
  allowBash?: boolean
}

function schema(properties: Record<string, unknown>, required: string[]): JsonSchema {
  return { type: "object", properties, required, additionalProperties: false }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function guard(run: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await run()
  } catch (error) {
    return { ok: false, output: errorMessage(error) }
  }
}

/** One readable block for stdout+stderr; mirrors pi-durable's merged output. */
function renderExec(result: ExecResult): { ok: boolean; output: string } {
  const body = [result.stdout, result.stderr].filter((part) => part.length > 0).join("\n")
  if (result.timedOut) {
    return { ok: false, output: `command timed out after ${Math.round(result.ms / 1000)}s${body ? `\n${body}` : ""}` }
  }
  if (result.code === 0) return { ok: true, output: body }
  if (body) return { ok: false, output: body }
  return { ok: false, output: `command exited with code ${result.code ?? "signal"}` }
}

export function createExecutionTools(executor: Executor, opts: ExecutionToolOptions = {}): ToolSpec[] {
  const allowBash = opts.allowBash === true
  return [
    {
      name: "read_file",
      description: "Read a UTF-8 text file (at most 20000 characters).",
      parameters: schema({ path: { type: "string" } }, ["path"]),
      async execute(args, ctx) {
        return await guard(async () => {
          if (typeof args.path !== "string") return { ok: false, output: "read_file requires a path" }
          const content = await executor.read(args.path, { cwd: ctx.cwd })
          return { ok: true, output: content.slice(0, READ_FILE_MAX_CHARS) }
        })
      },
    },
    {
      name: "write_file",
      description: "Write UTF-8 text to a file, creating parent directories as needed.",
      parameters: schema({ path: { type: "string" }, content: { type: "string" } }, ["path", "content"]),
      async execute(args, ctx) {
        return await guard(async () => {
          if (typeof args.path !== "string" || typeof args.content !== "string") {
            return { ok: false, output: "write_file requires path and content strings" }
          }
          await executor.write(args.path, args.content, { cwd: ctx.cwd })
          return { ok: true, output: `Wrote ${args.content.length} characters to ${args.path}` }
        })
      },
    },
    {
      name: "list_dir",
      description: "List entries in a directory (one level only).",
      parameters: schema({ path: { type: "string" } }, ["path"]),
      async execute(args, ctx) {
        return await guard(async () => {
          if (typeof args.path !== "string") return { ok: false, output: "list_dir requires a path" }
          const entries = await executor.list(args.path, { cwd: ctx.cwd })
          const lines = entries.map((entry) => (entry.endsWith("/") ? `[dir] ${entry.slice(0, -1)}` : `[file] ${entry}`))
          return { ok: true, output: lines.join("\n") }
        })
      },
    },
    {
      name: "bash",
      description: "Run a shell command in the session working directory.",
      parameters: schema({ command: { type: "string" } }, ["command"]),
      hidden: !allowBash,
      async execute(args, ctx) {
        return await guard(async () => {
          if (!ctx.allowBash && !allowBash) return { ok: false, output: "bash is disabled" }
          if (typeof args.command !== "string") return { ok: false, output: "bash requires a command string" }
          // The hard 10 s cap is applied by pi-durable's executeTool; do not
          // add a second one here. Long work belongs in run_task.
          const result = await executor.exec(["sh", "-c", args.command], {
            cwd: ctx.cwd,
            timeoutMs: ctx.timeoutMs,
          })
          return renderExec(result)
        })
      },
    },
    {
      name: "run_task",
      description:
        "Start a long-running shell command in the background and return immediately with an address. " +
        "Each tool call is capped at about 10 seconds, so builds, installs and test suites must be started " +
        "here and polled with task_output.",
      parameters: schema({
        command: { type: "string", description: "The shell command line to run in the background." },
      }, ["command"]),
      async execute(args, ctx) {
        return await guard(async () => {
          if (typeof args.command !== "string" || args.command.trim() === "") {
            return { ok: false, output: "run_task requires a command string" }
          }
          const { address } = await executor.spawn(["sh", "-c", args.command], { cwd: ctx.cwd })
          return { ok: true, output: `started ${address} — poll with task_output` }
        })
      },
    },
    {
      name: "task_output",
      description:
        "Read the tail of a background task started with run_task, or stop it. " +
        "A finished task ends with `[exit N]`.",
      parameters: schema({
        address: { type: "string", description: "The address returned by run_task." },
        lines: { type: "integer", minimum: 1, description: "How many trailing lines to return. Default 40." },
        kill: { type: "boolean", description: "Stop the task instead of reading it." },
      }, ["address"]),
      async execute(args) {
        return await guard(async () => {
          if (typeof args.address !== "string") return { ok: false, output: "task_output requires an address" }
          if (args.kill === true) {
            await executor.stopTask(args.address)
            return { ok: true, output: `stopped ${args.address}` }
          }
          const lines = typeof args.lines === "number" && Number.isFinite(args.lines) ? Math.floor(args.lines) : undefined
          const output = await executor.readTask(args.address, lines !== undefined ? { lines } : {})
          return { ok: true, output: output.length > 0 ? output : "(no output yet)" }
        })
      },
    },
  ]
}
