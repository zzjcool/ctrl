import { buildTools } from "../engine/durable.ts"
import type { ToolSpec } from "../engine/durable.ts"
import { createJobTools } from "../jobs/tools.ts"
import type { JobRunner } from "../jobs/runner.ts"
import type { MemoryIndex } from "../memory/index.ts"
import { createFocusSetTool, createSearchContextTool } from "../memory/tools.ts"

export interface CreateToolsOptions {

  agentHome: string
  runner: JobRunner

  memory: MemoryIndex
}

export function memoryTools(): ToolSpec[] {
  return buildTools().filter((tool) => tool.name === "remember" || tool.name === "recall")
}

export function createTools(opts: CreateToolsOptions): ToolSpec[] {
  return [
    ...createJobTools({ agentHome: opts.agentHome, runner: opts.runner }),

    createSearchContextTool({ index: opts.memory, db: opts.memory.handle() }),
    createFocusSetTool({ db: opts.memory.handle() }),
    ...memoryTools(),
  ]
}
