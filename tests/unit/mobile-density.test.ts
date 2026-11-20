import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const styles = readFileSync(path.join(repoRoot, "src/web/public/styles.css"), "utf8")
const html = readFileSync(path.join(repoRoot, "src/web/public/index.html"), "utf8")

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

test("narrow screens keep their 16px inputs", () => {
  const fontSize = firstPx(narrowDeclarationsFor(".composer-input"), "font-size")
  assert.ok(fontSize !== undefined, ".composer-input has no narrow-screen font-size")
  assert.ok(fontSize >= 16, `.composer-input is ${fontSize}px on narrow screens; iOS zooms below 16px`)
})
