import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const styles = readFileSync(path.join(repoRoot, "src/web/public/styles.css"), "utf8")
const html = readFileSync(path.join(repoRoot, "src/web/public/index.html"), "utf8")
const appJs = readFileSync(path.join(repoRoot, "src/web/public/app.js"), "utf8")

type Block = { query: string; body: string }
type Rule = { selectors: string[]; declarations: string }

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "")
}

function normalize(selector: string): string {
  return selector.replace(/\s+/g, " ").trim()
}

function mediaBlocks(source: string): Block[] {
  const blocks: Block[] = []
  const opener = /@media\s*([^{]+)\{/g
  for (let match = opener.exec(source); match; match = opener.exec(source)) {
    let depth = 1
    let index = opener.lastIndex
    while (index < source.length && depth > 0) {
      if (source[index] === "{") depth += 1
      else if (source[index] === "}") depth -= 1
      index += 1
    }
    blocks.push({ query: match[1].trim(), body: source.slice(opener.lastIndex, index - 1) })
    opener.lastIndex = index
  }
  return blocks
}

function withoutMediaBlocks(source: string): string {
  let out = ""
  let cursor = 0
  const opener = /@media\s*[^{]+\{/g
  for (let match = opener.exec(source); match; match = opener.exec(source)) {
    const start = match.index
    let depth = 1
    let index = opener.lastIndex
    while (index < source.length && depth > 0) {
      if (source[index] === "{") depth += 1
      else if (source[index] === "}") depth -= 1
      index += 1
    }
    out += source.slice(cursor, start)
    cursor = index
    opener.lastIndex = index
  }
  return out + source.slice(cursor)
}

function narrowBlocks(source: string): Block[] {
  return mediaBlocks(stripComments(source)).filter((block) => {
    const width = /max-width\s*:\s*(\d+(?:\.\d+)?)px/.exec(block.query)
    return width !== null && Number(width[1]) <= 640
  })
}

function rules(body: string): Rule[] {
  const parsed: Rule[] = []
  const rule = /([^{}]+)\{([^{}]*)\}/g
  for (let match = rule.exec(body); match; match = rule.exec(body)) {
    const declarations = match[2]
    if (declarations === undefined) continue
    parsed.push({
      selectors: match[1].split(",").map(normalize).filter((selector) => selector.length > 0),
      declarations,
    })
  }
  return parsed
}

function declarationsFor(selector: string, body: string): string[] {
  const found: string[] = []
  for (const rule of rules(body)) {
    if (rule.selectors.includes(selector)) found.push(rule.declarations)
  }
  return found
}

function narrowDeclarationsFor(selector: string): string[] {
  return narrowBlocks(styles).flatMap((block) => declarationsFor(selector, block.body))
}

function baseDeclarationsFor(selector: string): string[] {
  return declarationsFor(selector, withoutMediaBlocks(stripComments(styles)))
}

function hasDeclaration(declarations: string[], property: string, value: string): boolean {
  const pattern = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*${value}(?:\\s*;|\\s*$)`)
  return declarations.some((declaration) => pattern.test(declaration.replace(/\s+/g, " ").trim()))
}

function firstPx(declarations: string[], property: string): number | undefined {
  for (const declaration of declarations) {
    const match = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`).exec(declaration)
    const px = match?.[1] === undefined ? null : /(\d+(?:\.\d+)?)px/.exec(match[1])
    if (px?.[1] !== undefined) return Number(px[1])
  }
  return undefined
}

function gapPair(declarations: string[]): [number, number] | undefined {
  for (const declaration of declarations) {
    const match = /(?:^|;)\s*gap\s*:\s*([^;]+)/.exec(declaration)
    if (match?.[1] === undefined) continue
    const numbers = [...match[1].matchAll(/(\d+(?:\.\d+)?)px/g)].map((entry) => Number(entry[1]))
    if (numbers.length >= 2) return [numbers[0], numbers[1]]
    if (numbers.length === 1) return [numbers[0], numbers[0]]
  }
  return undefined
}

function placeholderFor(className: string): string | undefined {
  const pattern = new RegExp(`class="${className}"[\\s\\S]*?placeholder="([^"]*)"`)
  return pattern.exec(html)?.[1]
}

test("tool argument lines stay on one line with an ellipsis on narrow screens", () => {
  const declarations = narrowDeclarationsFor(".tool-args")
  assert.ok(declarations.length > 0, ".tool-args has no narrow-screen override")

  assert.ok(
    hasDeclaration(declarations, "white-space", "nowrap"),
    `narrow .tool-args must not wrap, got: ${declarations.join(" | ")}`,
  )
  assert.ok(
    hasDeclaration(declarations, "overflow", "hidden"),
    `narrow .tool-args must clip overflow, got: ${declarations.join(" | ")}`,
  )
  assert.ok(
    hasDeclaration(declarations, "text-overflow", "ellipsis"),
    `narrow .tool-args must ellipsize, got: ${declarations.join(" | ")}`,
  )
})

test("desktop tool arguments still wrap because the base rule is untouched", () => {
  const declarations = baseDeclarationsFor(".tool-args")
  assert.ok(declarations.length > 0, ".tool-args has no base rule")
  assert.ok(
    hasDeclaration(declarations, "white-space", "pre-wrap"),
    `desktop .tool-args must keep pre-wrap, got: ${declarations.join(" | ")}`,
  )

  const narrow = narrowDeclarationsFor(".tool-args").join(" ").replace(/\s+/g, " ")
  assert.doesNotMatch(narrow, /white-space:\s*pre-wrap/, "narrow override must not re-enable wrapping")
})

test("narrow screens hide the low value counters so the status bar fits two lines", () => {
  const windowDeclarations = narrowDeclarationsFor("#status-window-item")
  const memoryDeclarations = narrowDeclarationsFor("#status-memory-item")

  assert.ok(
    windowDeclarations.some((declaration) => hasDeclaration([declaration], "display", "none")),
    "narrow screens must hide #status-window-item",
  )
  assert.ok(
    memoryDeclarations.some((declaration) => hasDeclaration([declaration], "display", "none")),
    "narrow screens must hide #status-memory-item",
  )

  const baseGap = gapPair(baseDeclarationsFor(".status"))
  const narrowGap = gapPair(narrowDeclarationsFor(".status"))

  assert.ok(baseGap !== undefined, "base .status gap is missing")
  assert.ok(narrowGap !== undefined, "narrow .status gap is missing")
  assert.ok(
    narrowGap[1] < baseGap[1],
    `narrow .status column gap ${narrowGap[1]}px must be tighter than base ${baseGap[1]}px`,
  )
})

test("narrow tool cards keep their padding tighter than the base layout", () => {
  const basePadding = firstPx(baseDeclarationsFor(".tool-head"), "padding")
  const narrowPadding = firstPx(narrowDeclarationsFor(".tool-head"), "padding")

  assert.ok(basePadding !== undefined, "base .tool-head padding is missing")
  assert.ok(narrowPadding !== undefined, ".tool-head has no narrow-screen padding")
  assert.ok(
    narrowPadding < basePadding,
    `narrow .tool-head padding ${narrowPadding}px must be tighter than base ${basePadding}px`,
  )
})

test("the composer placeholder no longer repeats the keyboard hint", () => {
  const placeholder = placeholderFor("composer-input")

  assert.ok(placeholder !== undefined, "composer textarea placeholder is missing")
  assert.doesNotMatch(placeholder, /Enter/i, `placeholder still repeats the shortcut: ${placeholder}`)
  assert.ok(!placeholder.includes("("), `placeholder still carries a parenthetical hint: ${placeholder}`)

  const hint = /<span class="composer-hint"[^>]*>([\s\S]*?)<\/span>/.exec(html)?.[1]
  assert.ok(hint !== undefined, ".composer-hint is missing from index.html")
  assert.match(hint, /Enter 发送/, ".composer-hint must keep the full keyboard hint")
})

test("the composer row and hint can shrink so the page never scrolls sideways", () => {
  const boxDeclarations = baseDeclarationsFor(".composer-box")
  assert.ok(boxDeclarations.length > 0, ".composer-box has no base rule")
  assert.ok(
    hasDeclaration(boxDeclarations, "grid-template-columns", "minmax\\(0, 1fr\\)"),
    `base .composer-box must use a shrinkable single column, got: ${boxDeclarations.join(" | ")}`,
  )

  const rowDeclarations = baseDeclarationsFor(".composer-row")
  assert.ok(rowDeclarations.length > 0, ".composer-row has no base rule")
  assert.ok(
    hasDeclaration(rowDeclarations, "min-width", "0"),
    `base .composer-row must be allowed to shrink below its min-content width, got: ${rowDeclarations.join(" | ")}`,
  )

  const hintDeclarations = baseDeclarationsFor(".composer-hint")
  assert.ok(hintDeclarations.length > 0, ".composer-hint has no base rule")
  assert.ok(
    hasDeclaration(hintDeclarations, "overflow", "hidden"),
    `base .composer-hint must clip overflow, got: ${hintDeclarations.join(" | ")}`,
  )
  assert.ok(
    hasDeclaration(hintDeclarations, "text-overflow", "ellipsis"),
    `base .composer-hint must ellipsize, got: ${hintDeclarations.join(" | ")}`,
  )
  assert.ok(
    hasDeclaration(hintDeclarations, "white-space", "nowrap"),
    `base .composer-hint must stay on one line, got: ${hintDeclarations.join(" | ")}`,
  )
})

test("tool cards still cannot be clipped at narrow widths", () => {
  const args = narrowDeclarationsFor(".tool-args")
  assert.ok(args.length > 0, ".tool-args has no narrow-screen override")
  assert.ok(
    hasDeclaration(args, "white-space", "nowrap"),
    `narrow .tool-args must not wrap, got: ${args.join(" | ")}`,
  )
  assert.ok(
    hasDeclaration(args, "text-overflow", "ellipsis"),
    `narrow .tool-args must ellipsize, got: ${args.join(" | ")}`,
  )

  const rows = narrowDeclarationsFor(".rows")
  assert.ok(rows.length > 0, ".rows has no narrow-screen padding")
  const left = firstPx(rows, "padding-left")
  const right = firstPx(rows, "padding-right")
  assert.ok(left !== undefined && right !== undefined, `narrow .rows must set both paddings, got: ${rows.join(" | ")}`)
  assert.equal(left, right, `narrow .rows padding is asymmetric: left ${left}px vs right ${right}px`)
})

test("the send button never wraps and the long hint is hidden on narrow screens", () => {
  const button = narrowDeclarationsFor(".btn-send")
  assert.ok(button.length > 0, ".btn-send has no narrow-screen override")
  assert.ok(
    hasDeclaration(button, "white-space", "nowrap"),
    `narrow .btn-send must not wrap, got: ${button.join(" | ")}`,
  )
  assert.ok(
    hasDeclaration(button, "flex-shrink", "0"),
    `narrow .btn-send must not shrink, got: ${button.join(" | ")}`,
  )

  const hint = narrowDeclarationsFor(".composer-hint")
  assert.ok(hint.length > 0, ".composer-hint has no narrow-screen override")
  assert.ok(
    hint.some((declaration) => hasDeclaration([declaration], "display", "none")),
    `narrow .composer-hint must be hidden, got: ${hint.join(" | ")}`,
  )
})

test("the narrow placeholder drops the keyboard hint and follows the media query", () => {
  assert.match(
    appJs,
    /matchMedia\(\s*["']\(max-width:\s*620px\)["']\s*\)/,
    "app.js must branch on a (max-width: 620px) media query",
  )
  assert.match(appJs, /["'`]说点什么…["'`]/, "narrow placeholder must be the bare 说点什么…")
  assert.match(
    appJs,
    /说点什么…（Enter 发送，Shift\+Enter 换行）/,
    "the wide placeholder must keep the full keyboard hint",
  )
  assert.match(appJs, /["']change["']/, "app.js must listen for media query changes")
})

test("narrow screens keep their 16px inputs", () => {
  const fontSize = firstPx(narrowDeclarationsFor(".composer-input"), "font-size")
  assert.ok(fontSize !== undefined, ".composer-input has no narrow-screen font-size")
  assert.ok(fontSize >= 16, `.composer-input is ${fontSize}px on narrow screens; iOS zooms below 16px`)
})
