// The ONE file in ctrl allowed to import pi-durable (CONTRACT §3).
//
// Everything else imports from here, so swapping the engine (a package, a
// different checkout) stays a one-file change. pi-durable is never modified.
//
// Note for `node --experimental-strip-types`: types MUST go through
// `export type` — a value re-export of a type-only name is a runtime error
// under type stripping, where the `export { … } from` statement survives.

// --- agent loop -------------------------------------------------------------
export { asAgentMemory, runAgent } from "../../../pi-durable/src/core/agent.ts"
export type {
  AgentMemory,
  DurableAgentRunOptions,
  SessionSink,
} from "../../../pi-durable/src/core/agent.ts"

// --- sessions ---------------------------------------------------------------
export {
  continueRecentSession,
  createSession,
  listSessions,
  openSession,
  Session,
} from "../../../pi-durable/src/core/session.ts"
export type {
  CompactOptions,
  CreateSessionOptions,
  SessionOptions,
} from "../../../pi-durable/src/core/session.ts"

// --- memory -----------------------------------------------------------------
export { createMemoryStore } from "../../../pi-durable/src/core/memory.ts"
export type { MemoryInput, MemoryStore } from "../../../pi-durable/src/core/memory.ts"

// --- paths ------------------------------------------------------------------
export { defaultHome, resolvePaths } from "../../../pi-durable/src/core/paths.ts"
export type { DurablePaths } from "../../../pi-durable/src/core/paths.ts"

// --- llm --------------------------------------------------------------------
export { createChatCompletionsClient, DEFAULT_LLM_MODEL } from "../../../pi-durable/src/core/llm.ts"
export type { ChatCompletionsClientOptions } from "../../../pi-durable/src/core/llm.ts"

// --- recovery ---------------------------------------------------------------
export { detectResumePoint, needsResume, repairSession } from "../../../pi-durable/src/core/resume.ts"
export type { ResumePoint } from "../../../pi-durable/src/core/resume.ts"

// --- tools ------------------------------------------------------------------
export { buildTools, executeTool, toLlmTools } from "../../../pi-durable/src/core/tools.ts"
export type { BuildToolsOptions } from "../../../pi-durable/src/core/tools.ts"

// --- log --------------------------------------------------------------------
export { appendRecord, readRecords } from "../../../pi-durable/src/core/jsonl.ts"

// --- wire types -------------------------------------------------------------
export type {
  EventOf,
  JsonSchema,
  LlmClient,
  LlmCompleteRequest,
  LlmMessage,
  LlmResponse,
  LlmToolCall,
  LlmToolSpec,
  LlmUsage,
  MemoryEntry,
  MemoryHit,
  MemoryKind,
  MemoryQuery,
  SessionEvent,
  SessionEventType,
  SessionMeta,
  ToolCall,
  ToolContext,
  ToolResult,
  ToolSpec,
} from "../../../pi-durable/src/core/types.ts"
