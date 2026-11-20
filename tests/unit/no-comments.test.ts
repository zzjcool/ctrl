import assert from "node:assert/strict"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { findComments, scanTree } from "../../src/tools/no-comments.ts"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

const commented = [
  "export function sample(a, b) {",
  "  const ratio = a / b",
  '  const url = "http://127.0.0.1/x"',
  "  // leading line comment",
  "  const value = ratio // trailing line comment",
  "  const one = 1 /* inline block */ + value",
  "  /**",
  "   * doc line",
  "   */",
  "  return one",
  "}",
].join("\n")

const decoys = [
  'const quoted = "a // b"',
  'const url = "http://127.0.0.1/x"',
  "const templated = `${a} // ${b}`",
  'const escaped = "a \\" // still a string"',
  "const pattern = /\\/\\*[\\s\\S]*?\\*\\//g",
  "const klass = /[/*]/",
  "const divided = total / count",
  "const nested = `${`${inner}`} // ${/x\\/y/.source}`",
  'const origin = new URL(request.url ?? "/", "http://127.0.0.1")',
].join("\n")

const cssDecoys = [
  "a {",
  "  background: url(https://x.dev/a.png);",
  "}",
  "b { color: red }",
].join("\n")

test("real line and block comments are reported with file and line", () => {
  const hits = findComments(commented, "sample.js")
  assert.deepEqual(
    hits.map((hit) => [hit.line, hit.column, hit.kind]),
    [
      [4, 3, "line"],
      [5, 23, "line"],
      [6, 17, "block"],
      [7, 3, "block"],
    ],
  )
  assert.equal(hits[0].text, "leading line comment")
  assert.equal(hits[1].text, "trailing line comment")
  assert.equal(hits[2].text, "inline block")
  assert.match(hits[3].text, /doc line/)
  assert.ok(hits.every((hit) => hit.file === "sample.js"))
})

test("comment-looking text inside strings, urls, templates, regexes and css url() is left alone", () => {
  assert.deepEqual(findComments(decoys, "sample.js"), [])
  assert.deepEqual(findComments(cssDecoys, "sample.css"), [])
  assert.deepEqual(findComments("#!/usr/bin/env node\nconst a = 1\n", "bin.js"), [])
})

test("src and tests contain no comments", () => {
  const hits = scanTree([path.join(repoRoot, "src"), path.join(repoRoot, "tests")])
  const report = hits.map((hit) => `${hit.file}:${hit.line} ${hit.text.replace(/\s+/g, " ")}`).join("\n")
  assert.deepEqual(hits, [], report)
})

test("css only treats block comments as comments", () => {
  const css = [
    "a { color: red }",
    "b { // not a comment in css",
    "  background: url(https://x.dev/a.png);",
    "}",
    "/* real block */",
    "c { /* inline block */ color: blue }",
  ].join("\n")
  const hits = findComments(css, "styles.css")
  assert.deepEqual(
    hits.map((hit) => [hit.line, hit.column, hit.kind, hit.text]),
    [
      [5, 1, "block", "real block"],
      [6, 5, "block", "inline block"],
    ],
  )
})
