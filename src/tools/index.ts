// The frozen tool set of v3 plus the memory layer's tools (CONTRACT §5,
// MEMORY.md §6 §10.1): three job tools, `search_context`, `focus_set`, and the
// engine's own remember/recall — seven in total.
//
// There is nothing else. ctrl does not read files, write files, list
// directories, run bash or reach a machine — everything that touches the world
// happens inside a pi worker started by `delegate`. `remember`/`recall` are
// pulled straight out of pi-durable so memory semantics never fork, and
// `search_context`/`focus_set` read and write only the memory database
// (src/memory).

import { buildTools } from "../engine/durable.ts"
import type { ToolSpec } from "../engine/durable.ts"
import { createJobTools } from "../jobs/tools.ts"
import type { JobRunner } from "../jobs/runner.ts"
import type { MemoryIndex } from "../memory/index.ts"
import { createFocusSetTool, createSearchContextTool } from "../memory/tools.ts"

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

/**
 * The seven tools of M4: delegate, job_status, job_stop, search_context,
 * focus_set, remember, recall.
 *
 * The database handle is taken from the index here (one connection, one WAL);
 * when the database is degraded it is undefined and `focus_set` answers with
 * one sentence instead of failing the turn.
 */
export function createTools(opts: CreateToolsOptions): ToolSpec[] {
  return [
    ...createJobTools({ agentHome: opts.agentHome, runner: opts.runner }),
    // The same handle serves both halves of a search: the event mirror and the
    // memories table (MEMORY.md §6 — a hit says whether it is a memory or an event).
    createSearchContextTool({ index: opts.memory, db: opts.memory.handle() }),
    createFocusSetTool({ db: opts.memory.handle() }),
    ...memoryTools(),
  ]
}
