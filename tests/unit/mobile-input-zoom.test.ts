import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const styles = readFileSync(path.join(repoRoot, "src/web/public/styles.css"), "utf8")

const INPUT_SELECTORS = [".composer-input", ".drawer-input", ".focus-input", ".drawer-all input"]

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

function narrowFontSize(selector: string): number | undefined {
  let fontSize: number | undefined
  for (const block of narrowBlocks(styles)) {
    for (const rule of rules(block.body)) {
      if (!rule.selectors.includes(selector)) continue
      const declared = /(?:^|;)\s*font-size\s*:\s*([^;]+)/.exec(rule.declarations)
      if (declared?.[1] === undefined) continue
      const px = /(\d+(?:\.\d+)?)px/.exec(declared[1])
      if (px?.[1] !== undefined) fontSize = Number(px[1])
    }
  }
  return fontSize
}

test("narrow screens keep input font-size at 16px so iOS Safari does not zoom on focus", () => {
  assert.ok(
    narrowBlocks(styles).length > 0,
    "styles.css needs a narrow (max-width <= 640px) media query to scope the fix",
  )

  for (const selector of INPUT_SELECTORS) {
    const fontSize = narrowFontSize(selector)
    assert.ok(fontSize !== undefined, `${selector} has no font-size inside a narrow media query`)
    assert.ok(fontSize >= 16, `${selector} is ${fontSize}px on narrow screens; iOS zooms below 16px`)
  }
})

test("the fix does not disable page zoom", () => {
  // comments may name the anti-pattern to warn against it; only declarations matter
  const rulesOnly = stripComments(styles)
  assert.doesNotMatch(rulesOnly, /user-scalable\s*=\s*no/i, "user-scalable=no breaks accessibility")
  assert.doesNotMatch(rulesOnly, /maximum-scale/i, "maximum-scale breaks accessibility")
})
