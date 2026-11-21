import assert from "node:assert/strict"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, test } from "node:test"
import { buildSystemPrompt } from "../../src/server/routes.ts"
import { openMemoryDb } from "../../src/memory/db.ts"
import { upsertFocus } from "../../src/memory/focus.ts"

const homes: string[] = []
after(() => {

  homes.length = 0
})

async function agentHome(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "ctrl-prompt-"))
  homes.push(home)
  return home
}

test("the prompt carries the profile and the open focus items", async () => {
  const home = await agentHome()
  await writeFile(path.join(home, "profile.md"), "# 用户\n- 只说中文\n- 在做一个叫 ctrl 的 agent\n", "utf8")
  const db = openMemoryDb(path.join(home, "memory.db"))
  const shipping = upsertFocus(db, { text: "把记忆层收尾", state: "doing", evidence: ["tsc"] })
  const readme = upsertFocus(db, { text: "写 README", state: "open", accept: "段落齐全" })
  upsertFocus(db, { text: "已经做完的事", state: "done" })
  const long = "y".repeat(60)
  const opened = upsertFocus(db, { text: "补一条 contract", state: "open", evidence: [long] })
  db.close()

  const prompt = buildSystemPrompt({ name: "scout", cwd: "/tmp/work", agentHome: home, db: openMemoryDb(path.join(home, "memory.db")) })
  assert.match(prompt, /You are scout, a persistent agent/)
  assert.match(prompt, /Your workspace is \/tmp\/work/)
  assert.match(prompt, /# What you know about this person/)
  assert.match(prompt, /只说中文/)
  assert.match(prompt, /# Focus/)
  assert.ok(prompt.includes(`- [doing] ${shipping.id} 把记忆层收尾（0d, evidence: tsc）`), prompt)
  assert.ok(prompt.includes(`- [open] ${readme.id} 写 README（0d, no evidence）`), prompt)
  assert.ok(prompt.includes(`- [open] ${opened.id} 补一条 contract（0d, evidence: ${"y".repeat(40)}…）`), prompt)
  assert.doesNotMatch(prompt, /已经做完的事/, "done items stay out of the prompt")
})

test("a missing profile and an unavailable db leave just the identity", async () => {
  const home = await agentHome()
  const prompt = buildSystemPrompt({ name: "scout", cwd: "/tmp", agentHome: home })
  assert.match(prompt, /You are scout/)
  assert.doesNotMatch(prompt, /# What you know about this person/)
  assert.doesNotMatch(prompt, /# Focus/)
})
