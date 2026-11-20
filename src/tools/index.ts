// The frozen tool set of v3 plus the memory layer's one tool (CONTRACT §5,
// MEMORY.md §6): three job tools, `search_context`, and the engine's own
// remember/recall.
//
// There is nothing else. ctrl does not read files, write files, list
// directories, run bash or reach a machine — everything that touches the world
// happens inside a pi worker started by `delegate`. `remember`/`recall` are
// pulled straight out of pi-durable so memory semantics never fork, and
// `search_context` reads only the derived mirror (src/memory).

import { buildTools } from "../engine/durable.ts"
import type { ToolSpec } from "../engine/durable.ts"
import { createJobTools } from "../jobs/tools.ts"
import type { JobRunner } from "../jobs/runner.ts"
import type { MemoryIndex } from "../memory/index.ts"
import { createSearchContextTool } from "../memory/tools.ts"

export interface CreateToolsOptions {
  /** `<root>/agents/<name>` — the directory the jobs live under. */
  agentHome: string
  runner: JobRunner
  /** The SQLite mirror of the log; `search_context` reads it and nothing else. */
  memory: MemoryIndex
}

/** remember/recall, exactly as the engine defines them. */
export function memoryTools(): ToolSpec[] {
  return buildTools().filter((tool) => tool.name === "remember" || tool.name === "recall")
}

/** The six tools of M1: delegate, job_status, job_stop, search_context, remember, recall. */
export function createTools(opts: CreateToolsOptions): ToolSpec[] {
  return [
    ...createJobTools({ agentHome: opts.agentHome, runner: opts.runner }),
    createSearchContextTool({ index: opts.memory }),
    ...memoryTools(),
  ]
}
