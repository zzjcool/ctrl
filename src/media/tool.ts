import type { JsonSchema, ToolResult, ToolSpec } from "../engine/durable.ts"
import type { ImageAttachments } from "./attachments.ts"
import { viewableImage } from "./images.ts"

export const VIEW_IMAGE_TOOL = "view_image"

export interface ViewImageOptions {
  agentHome: string
  sessionId: string
  attachments: ImageAttachments
}

function schema(properties: Record<string, unknown>, required: string[] = []): JsonSchema {
  return { type: "object", properties, required, additionalProperties: false }
}

export function createViewImageTool(opts: ViewImageOptions): ToolSpec {
  return {
    name: VIEW_IMAGE_TOOL,
    description:
      "Look at an image yourself — a screenshot the user sent, or a picture a worker produced. " +
      "Give an absolute path to a PNG, JPEG or WebP file of at most 5 MB, under your agent home or /tmp. " +
      "The image is attached to your own log, so you will see it on the next step. " +
      "Images inside a user message are already attached; do not re-attach those.",
    parameters: schema(
      {
        path: {
          type: "string",
          description: "Absolute path to the image file (PNG, JPEG or WebP, at most 5 MB).",
        },
      },
      ["path"],
    ),
    async execute(args): Promise<ToolResult> {
      const raw = typeof args.path === "string" ? args.path.trim() : ""
      const checked = viewableImage(raw, opts.agentHome)
      if ("error" in checked) return { ok: false, output: checked.error }
      opts.attachments.queue(opts.sessionId, checked.path)
      return { ok: true, output: `attached ${checked.path} — you will see it on the next step` }
    },
  }
}
