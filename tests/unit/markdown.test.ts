import assert from "node:assert/strict"
import { test } from "node:test"
import { renderMarkdown } from "../../src/web/public/markdown.js"

test("html in the answer is escaped instead of executed", () => {
  const html = renderMarkdown('<img src=x onerror="alert(1)">\n\n<script>alert(1)</script>')
  assert.ok(!html.includes("<img"))
  assert.ok(!html.includes("<script"))
  assert.ok(html.includes("&lt;img"))
  assert.ok(html.includes("&lt;script"))
  assert.ok(html.includes("&quot;alert(1)&quot;"))
})

test("only http and https links become anchors", () => {
  const ok = renderMarkdown("[ok](https://a.dev)")
  assert.ok(ok.includes('<a href="https://a.dev" target="_blank" rel="noopener noreferrer">ok</a>'))
  assert.ok(renderMarkdown("[plain](HTTP://A.DEV)").includes('<a href="HTTP://A.DEV"'))

  const script = renderMarkdown("[bad](javascript:alert(1))")
  assert.ok(!script.includes("<a"))
  assert.ok(!script.includes('href="javascript:'))

  const data = renderMarkdown("[fine](data:text/html,x)")
  assert.ok(!data.includes("<a"))
})

test("fenced code blocks are not parsed as markdown", () => {
  const html = renderMarkdown("```js\n**bold**\n# heading\n<b>x</b>\n```")
  assert.ok(html.includes('class="fence"'))
  assert.ok(html.includes('class="fence-lang">js</div>'))
  assert.ok(html.includes('class="fence-code"'))
  assert.ok(html.includes("**bold**"))
  assert.ok(html.includes("# heading"))
  assert.ok(html.includes("&lt;b&gt;x&lt;/b&gt;"))
  assert.ok(!html.includes("<strong>"))
  assert.ok(!html.includes("<h1>"))
  assert.ok(html.startsWith('<div class="fence">'))
  assert.ok(html.endsWith("</code></pre></div>"))
})

test("asterisks inside inline code stay literal", () => {
  const html = renderMarkdown("`a * b * c`")
  assert.ok(html.includes("<code>a * b * c</code>"))
  assert.ok(!html.includes("<em>"))
})

test("nested lists keep their indentation as nesting", () => {
  const html = renderMarkdown("- a\n  - b\n    - c\n  - d")
  const opens = html.match(/<ul>/g) ?? []
  const closes = html.match(/<\/ul>/g) ?? []
  assert.ok(opens.length >= 2)
  assert.equal(opens.length, closes.length)
  assert.ok(html.lastIndexOf("<ul>") < html.indexOf("</ul>"))
  assert.ok(html.includes("<li>a<ul>"))
  assert.equal((html.match(/<li>/g) ?? []).length, 4)
})

test("headings bold italic quotes rules and paragraphs render", () => {
  const html = renderMarkdown("## t\n\n**b** and *i*\n\n> q\n\n---")
  assert.ok(html.includes("<h2>t</h2>"))
  assert.ok(html.includes("<strong>b</strong>"))
  assert.ok(html.includes("<em>i</em>"))
  assert.ok(html.includes("<blockquote>"))
  assert.ok(html.includes("<p class=\"prose\">q</p>"))
  assert.ok(html.includes("<hr>"))
  assert.ok(html.includes('<p class="prose"><strong>b</strong> and <em>i</em></p>'))
  assert.ok(renderMarkdown("one\ntwo").includes("one<br>two"))
  assert.ok(renderMarkdown("#nope").includes("#nope"))
})

test("empty input renders nothing", () => {
  assert.equal(renderMarkdown(""), "")
  assert.equal(renderMarkdown("   \n\n  "), "")
})

test("a pipe table with an alignment row renders a table", () => {
  const html = renderMarkdown("| a | b |\n|---|---|\n| 1 | 2 |")
  assert.equal(
    html,
    '<div class="table-wrap"><table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table></div>',
  )
})

test("a pipe row without an alignment row stays a paragraph", () => {
  const html = renderMarkdown("| a | b |")
  assert.equal(html, '<p class="prose">| a | b |</p>')
  assert.ok(!html.includes("<table"))
})

test("alignment markers map to per column text-align styles", () => {
  const html = renderMarkdown("| a | b | c | d |\n|:---|:---:|---:|---|\n| 1 | 2 | 3 | 4 |")
  assert.equal(
    html,
    '<div class="table-wrap"><table><thead><tr><th style="text-align:left">a</th><th style="text-align:center">b</th><th style="text-align:right">c</th><th>d</th></tr></thead><tbody><tr><td style="text-align:left">1</td><td style="text-align:center">2</td><td style="text-align:right">3</td><td>4</td></tr></tbody></table></div>',
  )
})

test("escaped pipes stay inside a single cell", () => {
  const html = renderMarkdown("| a \\| b | c |\n|---|---|")
  assert.equal(
    html,
    '<div class="table-wrap"><table><thead><tr><th>a | b</th><th>c</th></tr></thead><tbody></tbody></table></div>',
  )
  assert.equal((html.match(/<th[ >]/g) ?? []).length, 2)
})

test("inline markup inside table cells still renders", () => {
  const html = renderMarkdown("| **bold** | `code` |\n|---|---|")
  assert.equal(
    html,
    '<div class="table-wrap"><table><thead><tr><th><strong>bold</strong></th><th><code>code</code></th></tr></thead><tbody></tbody></table></div>',
  )
})

test("rows with too many cells are truncated to the header width", () => {
  const html = renderMarkdown("| a | b |\n|---|---|\n| 1 | 2 | 3 |")
  assert.equal(
    html,
    '<div class="table-wrap"><table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table></div>',
  )
  assert.equal((html.match(/<td>/g) ?? []).length, 2)
})
