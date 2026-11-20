// The frozen tool set: eight tools (CONTRACT §6).
//
// Six execution tools (ctrl) + remember/recall (pi-durable, imported unchanged
// so memory semantics never fork). `bash` is hidden unless --allow-bash.

import { buildTools } from "../engine/durable.ts"
import type { ToolSpec } from "../engine/durable.ts"
import type { Executor } from "../exec/types.ts"
import { createExecutionTools } from "./execution.ts"

export interface CreateToolsOptions {
  allowBash?: boolean
}

/** pull remember/recall straight out of the engine's own tool table. */
export function memoryTools(): ToolSpec[] {
  return buildTools().filter((tool) => tool.name === "remember" || tool.name === "recall")
}

export function createTools(executor: Executor, opts: CreateToolsOptions = {}): ToolSpec[] {
  return [...createExecutionTools(executor, opts), ...memoryTools()]
}
