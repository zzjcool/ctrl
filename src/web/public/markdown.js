export function renderMarkdown(text) {
  return renderBlocks(escapeHtml(String(text ?? "")))
}

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function renderInline(source) {
  const slots = []
  let work = source.replace(/`([^`\n]*)`/g, (_match, code) => {
    slots.push(`<code>${code}</code>`)
    return `\u0000${slots.length - 1}\u0000`
  })
  work = work.replace(/\*\*([^\n]+?)\*\*/g, "<strong>$1</strong>")
  work = work.replace(/\*([^*\n]+?)\*/g, "<em>$1</em>")
  work = work.replace(/\[([^\]\n]*)\]\(([^\s)]*)\)/g, (match, label, url) => {
    if (url.includes("<") || url.includes("\u0000")) return match
    const href = url.trim()
    if (!isSafeUrl(href)) return match
    return `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`
  })
  return work.replace(/\u0000(\d+)\u0000/g, (_match, index) => slots[Number(index)] ?? "")
}

function isSafeUrl(url) {
  const candidate = url.toLowerCase()
  return candidate.startsWith("http://") || candidate.startsWith("https://")
}

function indentWidth(indent) {
  let width = 0
  for (const char of indent) width += char === "\t" ? 2 : 1
  return width
}

function listItemFrom(line) {
  const indent = /^[ \t]*/.exec(line)[0]
  const rest = line.slice(indent.length)
  const depth = Math.floor(indentWidth(indent) / 2)
  const unordered = /^[-*+] (.*)$/.exec(rest)
  if (unordered) return { depth, ordered: false, text: unordered[1] }
  const ordered = /^(\d{1,3})\. (.*)$/.exec(rest)
  if (ordered) return { depth, ordered: true, text: ordered[2] }
  return null
}

function buildList(items, start, depth) {
  const ordered = items[start].ordered
  const tag = ordered ? "ol" : "ul"
  let html = `<${tag}>`
  let index = start
  while (index < items.length && items[index].depth >= depth) {
    const item = items[index]
    if (item.depth > depth || item.ordered !== ordered) break
    index += 1
    let inner = `<li>${renderInline(item.text)}`
    while (index < items.length && items[index].depth > depth) {
      const child = buildList(items, index, items[index].depth)
      inner += child.html
      index = child.next
    }
    inner += "</li>"
    html += inner
  }
  html += `</${tag}>`
  return { html, next: index }
}

function renderList(items) {
  let html = ""
  let index = 0
  while (index < items.length) {
    const built = buildList(items, index, items[index].depth)
    html += built.html
    index = built.next
  }
  return html
}

function quoteHtml(lines) {
  const parts = []
  let buffer = []
  const flush = () => {
    if (!buffer.length) return
    parts.push(`<p class="prose">${buffer.map(renderInline).join("<br>")}</p>`)
    buffer = []
  }
  for (const line of lines) {
    if (!line.trim()) {
      flush()
      continue
    }
    buffer.push(line)
  }
  flush()
  return parts.join("")
}

function fenceHtml(lang, body) {
  const label = lang ? `<div class="fence-lang">${lang}</div>` : ""
  return `<div class="fence">${label}<pre><code class="fence-code">${body}</code></pre></div>`
}

function tableRowFrom(line) {
  if (!line || !line.includes("|")) return null
  const cells = []
  let cell = ""
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (char === "\\" && line[index + 1] === "|") {
      cell += "|"
      index += 1
      continue
    }
    if (char === "|") {
      cells.push(cell.trim())
      cell = ""
      continue
    }
    cell += char
  }
  cells.push(cell.trim())
  if (cells.length > 1 && cells[0] === "") cells.shift()
  if (cells.length > 1 && cells[cells.length - 1] === "") cells.pop()
  return cells
}

function isTableAlignLine(line) {
  const cells = tableRowFrom(line)
  if (!cells || !cells.length) return false
  return cells.every((cell) => /^:?-+:?$/.test(cell))
}

function tableAlignments(line) {
  const cells = tableRowFrom(line) ?? []
  return cells.map((cell) => {
    const left = cell.startsWith(":")
    const right = cell.endsWith(":")
    if (left && right) return "center"
    if (right) return "right"
    if (left) return "left"
    return ""
  })
}

function tableHtml(lines) {
  const header = tableRowFrom(lines[0]) ?? []
  const aligns = tableAlignments(lines[1])
  const width = header.length
  const style = (index) => (aligns[index] ? ` style="text-align:${aligns[index]}"` : "")
  const row = (cells, tag) => {
    const parts = []
    for (let index = 0; index < width; index += 1) {
      const content = index < cells.length ? renderInline(cells[index]) : ""
      parts.push(`<${tag}${style(index)}>${content}</${tag}>`)
    }
    return parts.join("")
  }
  const head = `<thead><tr>${row(header, "th")}</tr></thead>`
  const body = lines.slice(2).map((line) => `<tr>${row(tableRowFrom(line) ?? [], "td")}</tr>`)
  return `<div class="table-wrap"><table>${head}<tbody>${body.join("")}</tbody></table></div>`
}

function renderBlocks(source) {
  if (!source.trim()) return ""
  const lines = source.split("\n")
  const out = []
  let paragraph = []
  let index = 0

  const flushParagraph = () => {
    while (paragraph.length && !paragraph[0].trim()) paragraph.shift()
    while (paragraph.length && !paragraph[paragraph.length - 1].trim()) paragraph.pop()
    if (!paragraph.length) return
    out.push(`<p class="prose">${paragraph.map(renderInline).join("<br>")}</p>`)
    paragraph = []
  }

  while (index < lines.length) {
    const line = lines[index]
    const open = /^\s*```(.*)$/.exec(line)
    if (open) {
      flushParagraph()
      const lang = open[1].trim().replace(/[^A-Za-z0-9+#._-]/g, "")
      const body = []
      index += 1
      while (index < lines.length) {
        if (/^\s*```\s*$/.test(lines[index])) {
          index += 1
          break
        }
        body.push(lines[index])
        index += 1
      }
      out.push(fenceHtml(lang, body.join("\n")))
      continue
    }
    if (!line.trim()) {
      flushParagraph()
      index += 1
      continue
    }
    const heading = /^(#{1,6}) (.*)$/.exec(line)
    if (heading) {
      flushParagraph()
      out.push(`<h${heading[1].length}>${renderInline(heading[2])}</h${heading[1].length}>`)
      index += 1
      continue
    }
    if (/^&gt;/.test(line)) {
      flushParagraph()
      const quote = []
      while (index < lines.length && /^&gt;/.test(lines[index])) {
        quote.push(lines[index].replace(/^&gt;\s?/, ""))
        index += 1
      }
      out.push(`<blockquote>${quoteHtml(quote)}</blockquote>`)
      continue
    }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushParagraph()
      out.push("<hr>")
      index += 1
      continue
    }
    if (tableRowFrom(line) && isTableAlignLine(lines[index + 1])) {
      flushParagraph()
      const rows = [line, lines[index + 1]]
      index += 2
      while (index < lines.length && lines[index].trim() && tableRowFrom(lines[index])) {
        rows.push(lines[index])
        index += 1
      }
      out.push(tableHtml(rows))
      continue
    }
    if (listItemFrom(line)) {
      flushParagraph()
      const items = []
      while (index < lines.length) {
        const item = listItemFrom(lines[index])
        if (!item) break
        items.push(item)
        index += 1
      }
      out.push(renderList(items))
      continue
    }
    paragraph.push(line)
    index += 1
  }
  flushParagraph()
  return out.join("")
}
