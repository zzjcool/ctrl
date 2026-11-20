import { readFile, stat } from "node:fs/promises"
import type { IncomingMessage, ServerResponse } from "node:http"
import { IMAGE_CACHE_CONTROL, imageMimeType, mediaPath } from "../media/images.ts"
import { sendText } from "./http.ts"

export const MEDIA_PREFIX = "/media/"

export async function serveMedia(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  agentHome: string,
): Promise<void> {
  const method = request.method ?? "GET"
  if (method !== "GET" && method !== "HEAD") {
    sendText(response, 405, "method not allowed")
    return
  }
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname.slice(MEDIA_PREFIX.length))
  } catch {
    sendText(response, 400, "invalid path encoding")
    return
  }
  const target = mediaPath(agentHome, decoded)
  if (target === undefined) {
    sendText(response, 404, "not found")
    return
  }
  let isFile = false
  try {
    isFile = (await stat(target)).isFile()
  } catch {
    isFile = false
  }
  if (!isFile) {
    sendText(response, 404, "not found")
    return
  }
  let body: Buffer
  try {
    body = await readFile(target)
  } catch {
    sendText(response, 404, "not found")
    return
  }
  response.writeHead(200, {
    "content-type": imageMimeType(target) ?? "application/octet-stream",
    "content-length": body.byteLength,
    "cache-control": IMAGE_CACHE_CONTROL,
  })
  if (method === "HEAD") response.end()
  else response.end(body)
}
