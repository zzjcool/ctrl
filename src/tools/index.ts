import { buildTools } from "../engine/durable.ts"
import type { ToolSpec } from "../engine/durable.ts"
import { createJobTools } from "../jobs/tools.ts"
import type { JobRunner } from "../jobs/runner.ts"
import type { ImageAttachments } from "../media/attachments.ts"
import { createViewImageTool } from "../media/tool.ts"
import type { MemoryIndex } from "../memory/index.ts"
import { createFocusSetTool, createSearchContextTool } from "../memory/tools.ts"
import type { SelfEditGate } from "../selfedit/gate.ts"
import { createSelfEditTool } from "../selfedit/tool.ts"

export interface CreateToolsOptions {

  agentHome: string
  runner: JobRunner

  memory: MemoryIndex

  selfEdit?: SelfEditGate

  sessionId: string

  attachments: ImageAttachments
}

export function memoryTools(): ToolSpec[] {
  return buildTools().filter((tool) => tool.name === "remember" || tool.name === "recall")
}

export function createTools(opts: CreateToolsOptions): ToolSpec[] {
  return [
    ...createJobTools({ agentHome: opts.agentHome, runner: opts.runner }),
    ...(opts.selfEdit !== undefined ? createSelfEditTool({ gate: opts.selfEdit }) : []),

    createSearchContextTool({ index: opts.memory, db: opts.memory.handle() }),
    createFocusSetTool({ db: opts.memory.handle() }),
    ...memoryTools(),
    createViewImageTool({
      agentHome: opts.agentHome,
      sessionId: opts.sessionId,
      attachments: opts.attachments,
    }),
  ]
}
