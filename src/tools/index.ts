import type { DatabaseSync } from "node:sqlite"
import { buildTools } from "../engine/durable.ts"
import type { ToolSpec } from "../engine/durable.ts"
import { createJobTools } from "../jobs/tools.ts"
import type { JobRunner } from "../jobs/runner.ts"
import type { ImageAttachments } from "../media/attachments.ts"
import { createViewImageTool } from "../media/tool.ts"
import { errorMessage } from "../memory/events.ts"
import type { MemoryIndex } from "../memory/index.ts"
import { syncFocusOnApplied } from "../memory/proposal-focus.ts"
import { createFocusSetTool, createSearchContextTool } from "../memory/tools.ts"
import { createApplyProposalTool } from "../selfedit/apply.ts"
import type { SelfEditGate } from "../selfedit/gate.ts"
import { createSelfEditTool } from "../selfedit/tool.ts"

const LONG_TOOL_TIMEOUT_MS = 180_000

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

export function withFocusSync(tool: ToolSpec, db: DatabaseSync | undefined): ToolSpec {
  return {
    ...tool,
    async execute(args, ctx) {
      const result = await tool.execute(args, ctx)
      if (result.ok !== true) return result
      const id = typeof args.id === "string" ? args.id.trim() : ""
      try {
        syncFocusOnApplied(db, id)
      } catch (error) {
        console.error(`could not sync focus for applied proposal ${id}: ${errorMessage(error)}`)
      }
      return result
    },
  }
}

export function createTools(opts: CreateToolsOptions): ToolSpec[] {
  return [
    ...createJobTools({ agentHome: opts.agentHome, runner: opts.runner }),
    ...(opts.selfEdit !== undefined
      ? [
          ...createSelfEditTool({ gate: opts.selfEdit }),
          withFocusSync(createApplyProposalTool({ gate: opts.selfEdit }), opts.memory.handle()),
        ]
      : []),

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
