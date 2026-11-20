import type { JsonSchema, ToolResult, ToolSpec } from "../engine/durable.ts"
import type { SelfEditGate } from "./gate.ts"
import { errorMessage } from "./git.ts"

export const PACKAGE_JSON = "package.json"

export const PROTECTED_DIRS = ["src/selfedit/", ".pi/"]

export const TESTS_PREFIX = "tests/"

export interface DiffEntry {
  status: string
  from: string
  to: string
}

export function parseNameStatus(text: string): DiffEntry[] {
  const entries: DiffEntry[] = []
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "")
    if (line.trim() === "") continue
    const fields = line.split("\t")
    const status = fields[0]?.trim() ?? ""
    if (status === "") continue
    if (status.startsWith("R") || status.startsWith("C")) {
      const from = fields[1] ?? ""
      const to = fields[2] ?? from
      if (from === "" || to === "") continue
      entries.push({ status, from, to })
      continue
    }
    const file = fields[1] ?? ""
    if (file === "") continue
    entries.push({ status, from: file, to: file })
  }
  return entries
}

export function touchesPackageJson(entries: DiffEntry[]): boolean {
  return entries.some((entry) => entry.from === PACKAGE_JSON || entry.to === PACKAGE_JSON)
}

export function protectedViolations(entries: DiffEntry[]): string[] {
  const reasons: string[] = []
  const seen = new Set<string>()
  const add = (reason: string): void => {
    if (seen.has(reason)) return
    seen.add(reason)
    reasons.push(reason)
  }
  for (const entry of entries) {
    for (const file of [entry.from, entry.to]) {
      for (const dir of PROTECTED_DIRS) {
        if (file.startsWith(dir)) add(`touches ${dir}** (${file})`)
      }
    }
    if (entry.status.startsWith("D") && entry.from.startsWith(TESTS_PREFIX)) {
      add(`deletes ${entry.from} under tests/**`)
    }
    if (entry.status.startsWith("R") && entry.from.startsWith(TESTS_PREFIX) && !entry.to.startsWith(TESTS_PREFIX)) {
      add(`moves ${entry.from} out of tests/**`)
    }
  }
  return reasons
}

export function scriptsField(text: string | undefined): string {
  if (text === undefined || text.trim() === "") return ""
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return text
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return text
  const scripts = (parsed as Record<string, unknown>).scripts
  return scripts === undefined ? "" : JSON.stringify(scripts)
}

export function scriptsChanged(before: string | undefined, after: string | undefined): boolean {
  return scriptsField(before) !== scriptsField(after)
}

export function protectedReason(entries: DiffEntry[], before: string | undefined, after: string | undefined): string | undefined {
  const reasons = protectedViolations(entries)
  if (touchesPackageJson(entries) && scriptsChanged(before, after)) reasons.push("changes the package.json scripts field")
  return reasons.length === 0 ? undefined : reasons.join("; ")
}

export const APPLY_PROPOSAL_TOOL = "apply_proposal"

export interface ApplyProposalToolOptions {
  gate: SelfEditGate
}

function schema(properties: Record<string, unknown>, required: string[] = []): JsonSchema {
  return { type: "object", properties, required, additionalProperties: false }
}

export function createApplyProposalTool(opts: ApplyProposalToolOptions): ToolSpec {
  const { gate } = opts
  return {
    name: APPLY_PROPOSAL_TOOL,
    description:
      "Apply one of your own self-edit proposals: merge its branch into the base branch with a merge commit and " +
      "restart ctrl, so the change becomes the running code. It only merges a proposal that is still open, whose " +
      "typecheck/unit/e2e/contract results are all green and whose diff stays out of the protected paths " +
      "(src/selfedit/**, .pi/**, the package.json scripts field and deletions under tests/**) on a clean workspace. " +
      "Anything else is refused with the reason. Proposals come from self_edit.",
    parameters: schema(
      {
        id: {
          type: "string",
          description: "Id of the proposal to apply, as listed by the console or answered by self_edit.",
        },
      },
      ["id"],
    ),
    async execute(args): Promise<ToolResult> {
      const id = typeof args.id === "string" ? args.id.trim() : ""
      if (id === "") return { ok: false, output: "apply_proposal requires a non-empty proposal id" }
      try {
        const proposal = await gate.apply(id)
        gate.scheduleRestart()
        return { ok: true, output: `applied ${proposal.id} — restarting` }
      } catch (error) {
        return { ok: false, output: errorMessage(error) }
      }
    },
  }
}
