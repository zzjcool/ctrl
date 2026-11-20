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
  upsertFocus(db, { text: "把记忆层收尾", state: "doing" })
  upsertFocus(db, { text: "写 README", state: "open" })
  upsertFocus(db, { text: "已经做完的事", state: "done" })
  db.close()

  const prompt = buildSystemPrompt({ name: "scout", cwd: "/tmp/work", agentHome: home, db: openMemoryDb(path.join(home, "memory.db")) })
  assert.match(prompt, /You are scout, a persistent agent/)
  assert.match(prompt, /Your workspace is \/tmp\/work/)
  assert.match(prompt, /# What you know about this person/)
  assert.match(prompt, /只说中文/)
  assert.match(prompt, /# Focus/)
  assert.match(prompt, /\[doing\] 把记忆层收尾/)
  assert.match(prompt, /\[open\] 写 README/)
  assert.doesNotMatch(prompt, /已经做完的事/, "done items stay out of the prompt")
})

test("a missing profile and an unavailable db leave just the identity", async () => {
  const home = await agentHome()
  const prompt = buildSystemPrompt({ name: "scout", cwd: "/tmp", agentHome: home })
  assert.match(prompt, /You are scout/)
  assert.doesNotMatch(prompt, /# What you know about this person/)
  assert.doesNotMatch(prompt, /# Focus/)
})
