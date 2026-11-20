import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

export type CommentHit = { file: string; line: number; column: number; kind: "line" | "block"; text: string }

const REGEX_PREFIX_KEYWORDS = new Set([
  "return",
  "typeof",
  "case",
  "in",
  "of",
  "instanceof",
  "new",
  "delete",
  "void",
  "throw",
  "do",
  "else",
  "yield",
  "await",
])

const REGEX_PREFIX_PUNCTUATION = new Set([
  "(",
  "[",
  "{",
  ",",
  ";",
  ":",
  "=",
  "!",
  "?",
  "+",
  "-",
  "*",
  "/",
  "%",
  "&",
  "|",
  "^",
  "~",
  "<",
  ">",
  "=>",
])

const JS_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"])
const TREE_EXTENSIONS = new Set([".ts", ".js", ".css"])
const SKIP_DIRECTORIES = new Set(["node_modules", "dist", ".git"])

function isWhitespace(char: string): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f" || char === "\v"
}

function isIdentifierStart(char: string): boolean {
  return (char >= "a" && char <= "z") || (char >= "A" && char <= "Z") || char === "_" || char === "$"
}

function isIdentifierPart(char: string): boolean {
  return isIdentifierStart(char) || (char >= "0" && char <= "9")
}

function isDigit(char: string): boolean {
  return char >= "0" && char <= "9"
}

function regexAllowedAfter(token: string): boolean {
  if (token === "") return true
  return REGEX_PREFIX_KEYWORDS.has(token) || REGEX_PREFIX_PUNCTUATION.has(token)
}

function makeLocator(source: string): (index: number) => { line: number; column: number } {
  const lineStarts = [0]
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") lineStarts.push(index + 1)
  }
  return (index: number) => {
    let low = 0
    let high = lineStarts.length - 1
    while (low < high) {
      const mid = (low + high + 1) >> 1
      if (lineStarts[mid] <= index) low = mid
      else high = mid - 1
    }
    return { line: low + 1, column: index - lineStarts[low] + 1 }
  }
}

function scanJavaScript(source: string, file: string): CommentHit[] {
  const hits: CommentHit[] = []
  const locate = makeLocator(source)
  const length = source.length

  function record(start: number, end: number, kind: "line" | "block"): void {
    const inner = kind === "line" ? source.slice(start + 2, end) : source.slice(start + 2, end - 2)
    const { line, column } = locate(start)
    hits.push({ file, line, column, kind, text: inner.trim() })
  }

  function lineEnd(start: number): number {
    let index = start
    while (index < length && source[index] !== "\n" && source[index] !== "\r") index += 1
    return index
  }

  function skipRegex(start: number): number {
    let index = start + 1
    let inClass = false
    while (index < length) {
      const char = source[index]
      if (char === "\n" || char === "\r") return -1
      if (char === "\\") {
        index += 2
        continue
      }
      if (char === "[") {
        inClass = true
        index += 1
        continue
      }
      if (char === "]") {
        inClass = false
        index += 1
        continue
      }
      if (char === "/" && !inClass) {
        index += 1
        while (index < length && isIdentifierPart(source[index])) index += 1
        return index
      }
      index += 1
    }
    return -1
  }

  function skipQuoted(start: number): number {
    const quote = source[start]
    let index = start + 1
    while (index < length) {
      const char = source[index]
      if (char === "\\") {
        index += 2
        continue
      }
      if (char === quote) return index + 1
      if (char === "\n") return index
      index += 1
    }
    return index
  }

  function skipTemplate(start: number): number {
    let index = start
    while (index < length) {
      const char = source[index]
      if (char === "\\") {
        index += 2
        continue
      }
      if (char === "`") return index + 1
      if (char === "$" && source[index + 1] === "{") {
        index = scanCode(index + 2, true)
        continue
      }
      index += 1
    }
    return index
  }

  function scanCode(start: number, inSubstitution: boolean): number {
    let index = start
    let depth = 0
    let last = ""
    while (index < length) {
      const char = source[index]
      if (isWhitespace(char)) {
        index += 1
        continue
      }
      if (char === "/" && source[index + 1] === "/") {
        const end = lineEnd(index)
        record(index, end, "line")
        index = end
        continue
      }
      if (char === "/" && source[index + 1] === "*") {
        const close = source.indexOf("*/", index + 2)
        const end = close === -1 ? length : close + 2
        record(index, end, "block")
        index = end
        continue
      }
      if (char === "/") {
        if (regexAllowedAfter(last)) {
          const end = skipRegex(index)
          if (end !== -1) {
            index = end
            last = "regex"
            continue
          }
        }
        index += 1
        last = "/"
        continue
      }
      if (char === '"' || char === "'") {
        index = skipQuoted(index)
        last = "string"
        continue
      }
      if (char === "`") {
        index = skipTemplate(index + 1)
        last = "template"
        continue
      }
      if (char === "{") {
        depth += 1
        index += 1
        last = "{"
        continue
      }
      if (char === "}") {
        if (inSubstitution && depth === 0) return index + 1
        if (depth > 0) depth -= 1
        index += 1
        last = "}"
        continue
      }
      if (isIdentifierStart(char)) {
        let end = index + 1
        while (end < length && isIdentifierPart(source[end])) end += 1
        last = source.slice(index, end)
        index = end
        continue
      }
      if (isDigit(char)) {
        let end = index + 1
        while (end < length && (isIdentifierPart(source[end]) || source[end] === ".")) end += 1
        last = "number"
        index = end
        continue
      }
      if (char === "=" && source[index + 1] === ">") {
        index += 2
        last = "=>"
        continue
      }
      if ((char === "+" || char === "-") && source[index + 1] === char) {
        index += 2
        last = char + char
        continue
      }
      index += 1
      last = char
    }
    return index
  }

  let start = 0
  if (source.startsWith("#!")) start = lineEnd(0)
  scanCode(start, false)
  return hits
}

function scanCss(source: string, file: string): CommentHit[] {
  const hits: CommentHit[] = []
  const locate = makeLocator(source)
  let index = 0
  while (index < source.length) {
    if (source[index] === "/" && source[index + 1] === "*") {
      const close = source.indexOf("*/", index + 2)
      const end = close === -1 ? source.length : close + 2
      const { line, column } = locate(index)
      hits.push({ file, line, column, kind: "block", text: source.slice(index + 2, end - 2).trim() })
      index = end
      continue
    }
    index += 1
  }
  return hits
}

export function findComments(source: string, file = "<anonymous>"): CommentHit[] {
  if (path.extname(file).toLowerCase() === ".css") return scanCss(source, file)
  return scanJavaScript(source, file)
}

export function scanFiles(files: string[]): CommentHit[] {
  return files.flatMap((file) => {
    const extension = path.extname(file).toLowerCase()
    if (extension !== ".css" && !JS_EXTENSIONS.has(extension)) return []
    return findComments(readFileSync(file, "utf8"), file)
  })
}

export function scanTree(roots: string[]): CommentHit[] {
  const files: string[] = []
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue
        walk(full)
        continue
      }
      if (entry.isFile() && TREE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) files.push(full)
    }
  }
  for (const root of roots) walk(root)
  files.sort()
  return scanFiles(files)
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  const roots = process.argv.slice(2)
  const targets = roots.length > 0 ? roots : ["src", "tests"]
  const hits = scanTree(targets)
  for (const hit of hits) {
    process.stdout.write(`${hit.file}:${hit.line}:${hit.column} ${hit.kind} ${hit.text.replace(/\s+/g, " ")}\n`)
  }
  if (hits.length > 0) process.exitCode = 1
  else process.stdout.write(`no comments in ${targets.join(", ")}\n`)
}
