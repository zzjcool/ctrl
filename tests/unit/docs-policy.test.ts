import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

const policy = "文档会过时，用测试和代码表达。"

const allowed = new Set(["README.md"])

const skippedDirs = new Set(["node_modules", ".git", ".pi", ".pi-subagents", "dist"])

const skippedSegments = new Set(["fixtures"])

export function collectMarkdown(root: string): string[] {
  const found: string[] = []
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      const relative = path.relative(root, full)
      const segments = relative.split(path.sep)
      if (segments.some((segment) => skippedSegments.has(segment))) continue
      if (entry.isDirectory()) {
        if (skippedDirs.has(entry.name)) continue
        walk(full)
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue
      found.push(segments.join("/"))
    }
  }
  walk(root)
  return found.sort()
}

function report(violations: string[]): string {
  return [policy, ...violations].join("\n")
}

test("only the readme is allowed at the repository root and elsewhere", () => {
  const violations = collectMarkdown(repoRoot).filter((file) => !allowed.has(file))
  assert.deepEqual(violations, [], report(violations))
})

test("design and interface docs are not allowed because they go stale", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctrl-docs-policy-"))
  try {
    fs.mkdirSync(path.join(tmp, "docs"))
    fs.writeFileSync(path.join(tmp, "docs", "architecture.md"), "# 架构\n")
    fs.writeFileSync(path.join(tmp, "NOTES.md"), "# 笔记\n")
    fs.mkdirSync(path.join(tmp, "tests", "fixtures"), { recursive: true })
    fs.writeFileSync(path.join(tmp, "tests", "fixtures", "decoy.md"), "# 假文档\n")
    const found = collectMarkdown(tmp)
    assert.deepEqual(found, ["NOTES.md", "docs/architecture.md"])
    const violations = found.filter((file) => !allowed.has(file))
    assert.deepEqual(violations, ["NOTES.md", "docs/architecture.md"], report(violations))
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
