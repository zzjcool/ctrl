import { spawn } from "node:child_process"
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import path from "node:path"
import type {
  LlmToolSpec,
  MemoryHit,
  MemoryKind,
  MemoryQuery,
  ToolContext,
  ToolResult,
  ToolSpec,
} from "./types.ts"

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_MAX_OUTPUT_CHARS = 8_000
const READ_FILE_MAX_CHARS = 20_000

export interface BuildToolsOptions {
  allowBash?: boolean
}

function schema(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false }
}

const tools: ToolSpec[] = [
  {
    name: "remember",
    description: "Write a fact, preference, event, or skill to long-term memory.",
    parameters: schema({
      kind: { type: "string", enum: ["fact", "preference", "event", "skill"] },
      text: { type: "string" },
      tags: { type: "array", items: { type: "string" } },
      salience: {
        type: "number",
        description:
          "How much this matters long-term, 0 to 1. 0.9-1.0 for identity, " +
          "hard constraints and standing preferences the user expects you to " +
          "always honour; 0.6-0.8 for durable project context; 0.3-0.5 for " +
          "useful-but-routine facts; 0.1-0.2 for transient or one-off details. " +
          "Higher salience ranks higher when memories compete for attention.",
      },
    }, ["kind", "text"]),
    async execute(args, ctx) {
      if (!ctx.remember) return { ok: false, output: "memory unavailable" }
      const kind = args.kind as MemoryKind
      const text = args.text
      if (!isMemoryKind(kind) || typeof text !== "string") {
        return { ok: false, output: "remember requires a valid kind and text" }
      }
      const tags = stringArray(args.tags)

      const rawSalience = typeof args.salience === "number" && Number.isFinite(args.salience) ? args.salience : undefined
      const salience = rawSalience === undefined ? undefined : Math.min(1, Math.max(0, rawSalience))
      const entry = ctx.remember({
        kind,
        text,
        ...(tags ? { tags } : {}),
        ...(salience !== undefined ? { salience } : {}),
      })
      return { ok: true, output: JSON.stringify(entry) }
    },
  },
  {
    name: "recall",
    description: "Search long-term memory for relevant entries.",
    parameters: schema({
      text: { type: "string" },
      limit: { type: "integer", minimum: 1 },
      kinds: { type: "array", items: { type: "string", enum: ["fact", "preference", "event", "skill"] } },
    }, ["text"]),
    async execute(args, ctx) {
      if (!ctx.recall) return { ok: false, output: "memory unavailable" }
      if (typeof args.text !== "string") return { ok: false, output: "recall requires text" }
      const query: MemoryQuery = { text: args.text }
      if (typeof args.limit === "number" && Number.isInteger(args.limit)) query.limit = args.limit
      if (Array.isArray(args.kinds) && args.kinds.every(isMemoryKind)) query.kinds = args.kinds
      const hits: MemoryHit[] = ctx.recall(query)
      return { ok: true, output: JSON.stringify(hits) }
    },
  },
  {
    name: "read_file",
    description: "Read a UTF-8 text file (at most 20000 characters).",
    parameters: schema({ path: { type: "string" } }, ["path"]),
    async execute(args, ctx) {
      if (typeof args.path !== "string") return { ok: false, output: "read_file requires a path" }
      const content = await readFile(resolvePath(args.path, ctx.cwd), "utf8")
      return { ok: true, output: content.slice(0, READ_FILE_MAX_CHARS) }
    },
  },
  {
    name: "write_file",
    description: "Write UTF-8 text to a file, creating parent directories as needed.",
    parameters: schema({ path: { type: "string" }, content: { type: "string" } }, ["path", "content"]),
    async execute(args, ctx) {
      if (typeof args.path !== "string" || typeof args.content !== "string") {
        return { ok: false, output: "write_file requires path and content strings" }
      }
      const target = resolvePath(args.path, ctx.cwd)
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, args.content, "utf8")
      return { ok: true, output: `Wrote ${args.content.length} characters to ${target}` }
    },
  },
  {
    name: "list_dir",
    description: "List entries in a directory (one level only).",
    parameters: schema({ path: { type: "string" } }, ["path"]),
    async execute(args, ctx) {
      if (typeof args.path !== "string") return { ok: false, output: "list_dir requires a path" }
      const target = resolvePath(args.path, ctx.cwd)
      const entries = await readdir(target, { withFileTypes: true })
      const lines = entries.map((entry) => `${entry.isDirectory() ? "[dir] " : "[file] "}${entry.name}`)
      return { ok: true, output: lines.join("\n") }
    },
  },
  {
    name: "bash",
    description: "Run a shell command in the session working directory.",
    parameters: schema({ command: { type: "string" } }, ["command"]),
    hidden: true,
    async execute(args, ctx) {
      if (!ctx.allowBash) return { ok: false, output: "bash is disabled" }
      if (typeof args.command !== "string") return { ok: false, output: "bash requires a command string" }
      return runBash(args.command, ctx.cwd, ctx.timeoutMs, ctx)
    },
  },
]

export function buildTools(opts: BuildToolsOptions = {}): ToolSpec[] {
  return tools
    .filter((tool) => tool.name !== "bash" || opts.allowBash === true)
    .map((tool) => ({ ...tool, hidden: false }))
}

export function toLlmTools(toolSpecs: ToolSpec[]): LlmToolSpec[] {
  return toolSpecs.filter((tool) => !tool.hidden).map(({ name, description, parameters }) => ({
    name,
    description,
    parameters,
  }))
}

export async function executeTool(
  spec: ToolSpec,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const timeoutMs = positiveInteger(ctx.timeoutMs, DEFAULT_TIMEOUT_MS)
  const maxOutputChars = positiveInteger(ctx.maxOutputChars, DEFAULT_MAX_OUTPUT_CHARS)
  let timer: ReturnType<typeof setTimeout> | undefined

  let cleanup: (() => void) | undefined
  const registration = { setCleanup: (fn: () => void) => { cleanup = fn } }
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        cleanup?.()
        reject(new Error(`tool timed out after ${timeoutMs}ms`))
      }, timeoutMs)
    })
    const result = await Promise.race([spec.execute(args, { ...ctx, ...registration }), timeout])
    return { ok: result.ok, output: truncate(result.output, maxOutputChars) }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, output: truncate(message, maxOutputChars) }
  } finally {
    if (timer) clearTimeout(timer)
    cleanup?.()
  }
}

function runBash(command: string, cwd: string, timeoutMs: number, ctx?: ToolContext): Promise<ToolResult> {
  return new Promise((resolve) => {

    const child = spawn("bash", ["-lc", command], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] })
    let output = ""
    let settled = false

    let exited = false
    const killTree = () => {
      if (exited) return
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL")
      } catch {
        try {
          child.kill("SIGKILL")
        } catch {

        }
      }
    }

    ctx?.setCleanup?.(killTree)
    const timer = setTimeout(() => {
      killTree()
      finish({ ok: false, output: `bash timed out after ${timeoutMs}ms${output ? `\n${output}` : ""}` })
    }, timeoutMs)
    const append = (chunk: Buffer) => { output += chunk.toString("utf8") }
    child.stdout.on("data", append)
    child.stderr.on("data", append)
    child.on("error", (error) => { exited = true; finish({ ok: false, output: error.message }) })
    child.on("close", (code) => {
      exited = true
      finish({ ok: code === 0, output: output || (code === 0 ? "" : `bash exited with code ${code}`) })
    })

    function finish(result: ToolResult) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
  })
}

function resolvePath(filePath: string, cwd: string): string {
  return path.resolve(cwd, filePath)
}

function truncate(output: string, maxChars: number): string {
  if (output.length <= maxChars) return output
  const removed = output.length - maxChars
  return `${output.slice(0, maxChars)}... [truncated ${removed} chars]`
}

function positiveInteger(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

function isMemoryKind(value: unknown): value is MemoryKind {
  return value === "fact" || value === "preference" || value === "event" || value === "skill"
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined
}
