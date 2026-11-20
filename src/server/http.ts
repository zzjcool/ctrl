import { readFile, stat } from "node:fs/promises"
import type { IncomingMessage, ServerResponse } from "node:http"
import path from "node:path"

export const MAX_BODY_BYTES = 1_048_576

export class HttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = "HttpError"
    this.status = status
  }
}

export function sendJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.writableEnded) return
  const body = JSON.stringify(value)
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  })
  response.end(body)
}

export function sendText(response: ServerResponse, status: number, value: string): void {
  if (response.writableEnded) return
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(value),
    "cache-control": "no-store",
  })
  response.end(value)
}

export async function readJson(
  request: IncomingMessage,
  opts: { maxBytes?: number } = {},
): Promise<Record<string, unknown>> {
  const maxBytes = opts.maxBytes ?? MAX_BODY_BYTES
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    bytes += buffer.byteLength
    if (bytes > maxBytes) throw new HttpError(413, `request body too large (limit ${maxBytes} bytes)`)
    chunks.push(buffer)
  }
  if (bytes === 0) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"))
  } catch {
    throw new HttpError(400, "invalid JSON request body")
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, "request body must be a JSON object")
  }
  return parsed as Record<string, unknown>
}

export async function serveStatic(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  root: string,
): Promise<boolean> {
  const method = request.method ?? "GET"
  if (method !== "GET" && method !== "HEAD") {
    sendText(response, 405, "method not allowed")
    return true
  }
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    sendText(response, 400, "invalid path encoding")
    return true
  }
  const relative = decoded === "/" || decoded === "" ? "/index.html" : decoded
  const base = path.resolve(root)
  const target = path.resolve(base, `.${relative}`)

  if (target !== base && !target.startsWith(`${base}${path.sep}`)) {
    sendText(response, 403, "forbidden")
    return true
  }
  let info
  try {
    info = await stat(target)
  } catch {
    sendText(response, 404, "not found")
    return true
  }
  if (!info.isFile()) {
    sendText(response, 404, "not found")
    return true
  }
  let body: Buffer
  try {
    body = await readFile(target)
  } catch {
    sendText(response, 404, "not found")
    return true
  }
  response.writeHead(200, {
    "content-type": contentType(target),
    "content-length": body.byteLength,

    "cache-control": "no-cache",
  })
  if (method === "HEAD") response.end()
  else response.end(body)
  return true
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
}

export function contentType(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream"
}
