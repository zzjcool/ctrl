import type { DatabaseSync } from "node:sqlite"
import type { JsonSchema, ToolResult, ToolSpec } from "../engine/durable.ts"
import { errorMessage } from "./events.ts"
import { FOCUS_STATES, isFocusState, upsertFocus, type FocusItem } from "./focus.ts"
import { DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT, type MemoryHit, type MemoryIndex } from "./index.ts"
import { searchMemories, type MemoryRow } from "./memories.ts"

export function formatEventTime(ts: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/.exec(ts)
  return match === null ? ts : `${match[1]} ${match[2]}`
}

export function eventKind(type: string): string {
  if (type === "user_message") return "user"
  if (type === "assistant_message") return "assistant"
  return type
}

export function renderHit(hit: MemoryHit): string {
  const body = hit.body.replace(/\s+/g, " ").trim()
  return `[${formatEventTime(hit.ts)} seq ${hit.seq} ${eventKind(hit.type)}] ${body}`
}

export function pagingHint(oldestSeq: number): string {
  return `(older: search_context with before=${oldestSeq})`
}

export function renderMemoryHit(row: MemoryRow): string {
  const at = formatEventTime(row.updatedAt !== "" ? row.updatedAt : row.createdAt)
  return `[${at} memory ${row.id}] ${row.text.replace(/\s+/g, " ").trim()}`
}

export const MEMORY_RESULT_LIMIT = 3

export interface SearchContextOptions {
  index: MemoryIndex

  db?: DatabaseSync

  defaultLimit?: number

  memoryLimit?: number
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
      "Search your entire history — every past user message, reply, tool call and tool result — and your memories, " +
      "by substring, newest/most-relevant first. Use it when the user refers to something that is not in the recent " +
      "context ('what did we decide about X last week', 'the file you mentioned earlier'). " +
      "Each hit is one line: [timestamp seq N kind] snippet, or [timestamp memory id] for a memory. " +
      `Page older results with before=<the smallest seq returned>.`,
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

        return { ok: true, output: `search_context is unavailable: ${index.error ?? "the memory index is not open"}` }
      }

      index.importEvents()

      const requested = integerArg(args.limit)
      const limit = requested === undefined ? defaultLimit : Math.max(1, Math.min(requested, MAX_SEARCH_LIMIT))
      const before = integerArg(args.before)
      const hits = index.search(query, {
        limit,
        ...(before !== undefined && before >= 0 ? { beforeSeq: before } : {}),
      })

      const memories =
        opts.db === undefined || (before !== undefined && before >= 0)
          ? []
          : searchMemories(opts.db, query, { limit: Math.max(1, opts.memoryLimit ?? MEMORY_RESULT_LIMIT) })
      if (hits.length === 0 && memories.length === 0) return { ok: true, output: `no matches for "${query}"` }

      const lines = [...memories.map(renderMemoryHit), ...hits.map(renderHit)]

      if (hits.length >= limit) lines.push(pagingHint(Math.min(...hits.map((hit) => hit.seq))))
      return { ok: true, output: lines.join("\n") }
    },
  }
}

export function renderFocus(item: FocusItem): string {
  const seq = item.seq !== undefined ? ` seq ${item.seq}` : ""
  return `[${item.state}] ${item.id}${seq} ${item.text.replace(/\s+/g, " ").trim()}`
}

export interface FocusToolOptions {

  db: DatabaseSync | undefined
}

export function createFocusSetTool(opts: FocusToolOptions): ToolSpec {
  return {
    name: "focus_set",
    description:
      "Keep your own focus list — what you are working on right now (at most a few items). " +
      "Call it with `text` to add an item (state open), or with `id` (and optional `text`/`state`) to move an " +
      "existing one. States: open, doing (working on it now), blocked, done (finished). " +
      "It answers with the item it wrote, including its id.",
    parameters: schema(
      {
        text: { type: "string", description: "The item's text. Required when creating a new item." },
        id: { type: "string", description: "Id of an existing item to update (its id was returned when it was created)." },
        state: {
          type: "string",
          enum: [...FOCUS_STATES],
          description: "open | doing | blocked | done. Defaults to open when creating.",
        },
      },
      [],
    ),
    async execute(args): Promise<ToolResult> {
      const db = opts.db
      if (db === undefined) {

        return { ok: true, output: "focus_set is unavailable: the memory database is not open" }
      }
      const text = typeof args.text === "string" ? args.text.trim() : undefined
      const id = typeof args.id === "string" ? args.id.trim() : undefined
      if ((text === undefined || text === "") && (id === undefined || id === "")) {
        return { ok: true, output: "focus_set needs text (to add) or id (to update)" }
      }
      const rawState = typeof args.state === "string" ? args.state.trim() : undefined
      if (rawState !== undefined && rawState !== "" && !isFocusState(rawState)) {
        return { ok: true, output: `unknown state "${rawState}": use one of ${FOCUS_STATES.join(", ")}` }
      }
      try {
        const item = upsertFocus(db, {
          ...(id !== undefined && id !== "" ? { id } : {}),
          ...(text !== undefined && text !== "" ? { text } : {}),
          ...(rawState !== undefined && rawState !== "" ? { state: rawState } : {}),
          source: "agent",
        })
        return { ok: true, output: renderFocus(item) }
      } catch (error) {
        return { ok: true, output: `focus_set failed: ${errorMessage(error)}` }
      }
    },
  }
}
