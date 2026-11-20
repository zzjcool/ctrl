// `search_context` — the agent's one way back into its own history (MEMORY.md §6).
//
// The window only holds the recent turns; everything older is still in the log
// and searchable here. The output is deliberately boring to read and cheap to
// parse: one line per hit, timestamp + seq + kind, then the snippet. The seq is
// in the line because it is the paging token — `before=<seq>` walks backwards.
//
// Tool discipline (same as src/jobs/tools.ts): it never throws. A broken index
// is a sentence the model can act on, not a stack trace in the transcript.

import type { JsonSchema, ToolResult, ToolSpec } from "../engine/durable.ts"
import { DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT, type MemoryHit, type MemoryIndex } from "./index.ts"

/** `2026-11-20T07:52:56.123Z` → `2026-11-20 07:52:56`; anything else is left alone. */
export function formatEventTime(ts: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/.exec(ts)
  return match === null ? ts : `${match[1]} ${match[2]}`
}

/** `user` / `assistant` read better than the wire names; the rest are already plain. */
export function eventKind(type: string): string {
  if (type === "user_message") return "user"
  if (type === "assistant_message") return "assistant"
  return type
}

/** One hit as one line: a long tool log must not become a paragraph. */
export function renderHit(hit: MemoryHit): string {
  const body = hit.body.replace(/\s+/g, " ").trim()
  return `[${formatEventTime(hit.ts)} seq ${hit.seq} ${eventKind(hit.type)}] ${body}`
}

/** The exact hint the model needs to page backwards (task M1 §5). */
export function pagingHint(oldestSeq: number): string {
  return `(older: search_context with before=${oldestSeq})`
}

export interface SearchContextOptions {
  index: MemoryIndex
  /** Override the default page size (tests). */
  defaultLimit?: number
}

function schema(properties: Record<string, unknown>, required: string[] = []): JsonSchema {
  return { type: "object", properties, required, additionalProperties: false }
}

function integerArg(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number.parseInt(value.trim(), 10)
  return undefined
}

export function createSearchContextTool(opts: SearchContextOptions): ToolSpec {
  const { index } = opts
  const defaultLimit = Math.max(1, Math.min(opts.defaultLimit ?? DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT))

  return {
    name: "search_context",
    description:
      "Search your entire history — every past user message, reply, tool call and tool result — by substring, " +
      "newest/most-relevant first. Use it when the user refers to something that is not in the recent context " +
      "('what did we decide about X last week', 'the file you mentioned earlier'). " +
      `Each hit is one line: [timestamp seq N kind] snippet. Page older results with before=<the smallest seq returned>.`,
    parameters: schema(
      {
        query: {
          type: "string",
          description: "Text to look for. Three or more characters uses a full-text index; shorter queries are substring scans.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: MAX_SEARCH_LIMIT,
          description: `How many hits to return. Default ${defaultLimit}, at most ${MAX_SEARCH_LIMIT}.`,
        },
        before: {
          type: "integer",
          minimum: 0,
          description: "Paging token from a previous call: only hits older than this seq are returned.",
        },
      },
      ["query"],
    ),
    async execute(args): Promise<ToolResult> {
      const query = typeof args.query === "string" ? args.query.trim() : ""
      if (query === "") return { ok: true, output: "search_context needs a non-empty query" }
      if (!index.available) {
        // Degraded on purpose (task M1 §8): the turn goes on without history.
        return { ok: true, output: `search_context is unavailable: ${index.error ?? "the memory index is not open"}` }
      }
      // The mirror is only a cache of events.jsonl, so catch it up first: a turn
      // in progress has already written events (the user's message, this tool
      // call), and the model should be able to find them. A no-op when nothing
      // is new, and it never throws.
      index.importEvents()

      const requested = integerArg(args.limit)
      const limit = requested === undefined ? defaultLimit : Math.max(1, Math.min(requested, MAX_SEARCH_LIMIT))
      const before = integerArg(args.before)
      const hits = index.search(query, {
        limit,
        ...(before !== undefined && before >= 0 ? { beforeSeq: before } : {}),
      })
      if (hits.length === 0) return { ok: true, output: `no matches for "${query}"` }

      const lines = hits.map(renderHit)
      // Only when the page is full: a hint nobody can act on is noise. bm25
      // ordering means the oldest hit is not the last one — take the minimum.
      if (hits.length >= limit) lines.push(pagingHint(Math.min(...hits.map((hit) => hit.seq))))
      return { ok: true, output: lines.join("\n") }
    },
  }
}
