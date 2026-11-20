// The frozen tool set of v3 (CONTRACT §5): three job tools plus the engine's
// own remember/recall.
//
// There is nothing else. ctrl does not read files, write files, list
// directories, run bash or reach a machine — everything that touches the world
// happens inside a pi worker started by `delegate`. `remember`/`recall` are
// pulled straight out of pi-durable so memory semantics never fork.

import { buildTools } from "../engine/durable.ts"
import type { ToolSpec } from "../engine/durable.ts"
import { createJobTools } from "../jobs/tools.ts"
import type { JobRunner } from "../jobs/runner.ts"

export interface CreateToolsOptions {
  /** `<root>/agents/<name>` — the directory the jobs live under. */
  agentHome: string
  runner: JobRunner
}

/** remember/recall, exactly as the engine defines them. */
export function memoryTools(): ToolSpec[] {
  return buildTools().filter((tool) => tool.name === "remember" || tool.name === "recall")
}

export function createTools(opts: CreateToolsOptions): ToolSpec[] {
  return [...createJobTools({ agentHome: opts.agentHome, runner: opts.runner }), ...memoryTools()]
}
