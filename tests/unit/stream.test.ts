import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { MAX_FIELD_CHARS, renderStream } from "../../src/jobs/stream.ts"

const FIXTURE = readFileSync(new URL("./fixtures/pi-json-stream.jsonl", import.meta.url), "utf8")

function event(value: Record<string, unknown>): string {
  return JSON.stringify(value)
}

test("a real pi --mode json stream renders as a tool timeline and assistant text", () => {
  const rendered = renderStream(FIXTURE)
  const lines = rendered.split("\n")
  assert.deepEqual(lines, ["→ bash: echo hello-ctrl", "← hello-ctrl", "assistant: The command printed `hello-ctrl`."])
  assert.ok(!rendered.includes("coding assistant running inside pi"), "the system prompt is not progress")
  assert.ok(!rendered.includes("Run exactly this bash command"), "the task echo is not progress")
  assert.ok(!/usage|totalTokens|cost|toolcall_delta|text_delta/.test(rendered), rendered)
})

test("lines that are not JSON are kept verbatim, so old logs stay readable", () => {
  const raw = ["found 42 files", event({ type: "agent_settled", aborted: false }), "ctrl: no output for 4m — stopped"].join("\n")
  assert.equal(renderStream(raw), "found 42 files\nctrl: no output for 4m — stopped")

  const halfWritten = `${FIXTURE}{"type":"message_update","assistantMessageEvent":{"type":"text_de`
  const tail = renderStream(halfWritten, { maxLines: 3 }).split("\n")
  assert.equal(tail.at(-1), `{"type":"message_update","assistantMessageEvent":{"type":"text_de`)
})

test("empty and blank input render as nothing", () => {
  assert.equal(renderStream(""), "")
  assert.equal(renderStream("\n\n\n"), "")
})

test("maxLines keeps the last lines and defaults to 40", () => {
  const raw = Array.from({ length: 50 }, (_, index) => `plain line ${index}`).join("\n")
  const lines = renderStream(raw).split("\n")
  assert.equal(lines.length, 40)
  assert.equal(lines[0], "plain line 10")
  assert.equal(lines.at(-1), "plain line 49")

  assert.deepEqual(renderStream(raw, { maxLines: 2 }).split("\n"), ["plain line 48", "plain line 49"])
  assert.equal(renderStream(raw, { maxLines: 0 }).split("\n").length, 50, "0 keeps everything")
})

test("text deltas accumulate into one assistant line per message", () => {
  const raw = [
    event({ type: "message_start", message: { role: "assistant", content: [] } }),
    event({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "first " } }),
    event({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "part\nand " } }),
    event({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "second" } }),
    event({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0 } }),
    event({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "first part and second" }] } }),
  ].join("\n")
  assert.equal(renderStream(raw), "assistant: first part and second", "one line, the deltas joined once")
})

test("an assistant message without deltas still shows its text", () => {
  const raw = [
    event({ type: "message_start", message: { role: "assistant", content: [] } }),
    event({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "no streaming here" }] } }),
  ].join("\n")
  assert.equal(renderStream(raw), "assistant: no streaming here")
})

test("tool calls other than bash render their arguments, cut at 120 characters", () => {
  const long = `echo ${"x".repeat(400)}`
  const raw = [
    event({ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: { command: long } }),
    event({ type: "tool_execution_end", toolCallId: "call-1", toolName: "bash", result: { content: [{ type: "text", text: "y".repeat(400) }] } }),
    event({ type: "tool_execution_start", toolCallId: "call-2", toolName: "read", args: { path: "src/jobs/runner.ts" } }),
    event({ type: "tool_execution_end", toolCallId: "call-2", toolName: "read", result: { content: [] } }),
  ].join("\n")
  const lines = renderStream(raw).split("\n")
  assert.equal(lines[0]?.length, "→ bash: ".length + MAX_FIELD_CHARS)
  assert.ok(lines[0]?.endsWith("…"), lines[0])
  assert.equal(lines[1], `← ${"y".repeat(MAX_FIELD_CHARS - 1)}…`)
  assert.equal(lines[2], '→ read: {"path":"src/jobs/runner.ts"}')
  assert.equal(lines[3], "← (no output)")
})

test("a tool call that is announced twice is rendered once", () => {
  const raw = [
    event({ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: { command: "ls" } }),
    event({ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: { command: "ls" } }),
    event({ type: "tool_execution_end", toolCallId: "call-1", toolName: "bash", result: { content: [{ type: "text", text: "a.ts" }] } }),
  ].join("\n")
  assert.deepEqual(renderStream(raw).split("\n"), ["→ bash: ls", "← a.ts"])
})
