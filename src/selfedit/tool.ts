import type { JsonSchema, ToolResult, ToolSpec } from "../engine/durable.ts"
import { errorMessage } from "./git.ts"
import type { SelfEditGate } from "./gate.ts"

export interface SelfEditToolOptions {
  gate: SelfEditGate
}

function schema(properties: Record<string, unknown>, required: string[] = []): JsonSchema {
  return { type: "object", properties, required, additionalProperties: false }
}

export function createSelfEditTool(opts: SelfEditToolOptions): ToolSpec[] {
  const { gate } = opts
  return [
    {
      name: "self_edit",
      description:
        "Change your own source code: create branch self/<stamp>, hand the task to a pi worker on it, " +
        "and return at once. When the worker exits ctrl runs the full verification suite and records a " +
        "proposal (never a direct commit to main) that a human can apply or discard. " +
        "The workspace has to be clean and no other self-edit may be running.",
      parameters: schema(
        {
          task: {
            type: "string",
            description: "What to change, in full sentences. The worker sees only this text, so name files, commands and expected results.",
          },
        },
        ["task"],
      ),
      async execute(args): Promise<ToolResult> {
        try {
          const result = await gate.start(typeof args.task === "string" ? args.task : "")
          return result.ok ? { ok: true, output: result.output } : { ok: false, output: result.output }
        } catch (error) {
          return { ok: false, output: errorMessage(error) }
        }
      },
    },
  ]
}
