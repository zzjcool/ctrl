import { randomBytes } from "node:crypto"
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { LlmClient, LlmCompleteRequest, LlmContentPart, LlmDelta, LlmMessage } from "../engine/durable.ts"

export const MEDIA_DIR = "media"

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024

export const IMAGE_CACHE_CONTROL = "max-age=31536000"

const MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
}

const EXTENSION_BY_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
}

const MEDIA_NAME = /^\d{8}T\d{6}Z-[0-9a-f]{6}\.(png|jpg|jpeg|webp)$/

const IMAGE_MARKER = /\[image:([^\[\]\r\n]+)\]/g

const VIEW_ROOTS = ["/tmp"]

export interface SavedImage {
  id: string
  path: string
  bytes: number
}

export function mediaDir(agentHome: string): string {
  return path.join(agentHome, MEDIA_DIR)
}

export function imageType(contentType: string | undefined): string | undefined {
  if (typeof contentType !== "string") return undefined
  const bare = contentType.split(";")[0]?.trim().toLowerCase() ?? ""
  return EXTENSION_BY_TYPE[bare] === undefined ? undefined : bare
}

export function imageMimeType(file: string): string | undefined {
  return MIME_BY_EXTENSION[path.extname(file).toLowerCase()]
}

export function imageMarker(file: string): string {
  return `[image:${file}]`
}

function imageStamp(date: Date): string {
  const iso = date.toISOString()
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`
}

export function saveImage(input: {
  agentHome: string
  contentType: string | undefined
  bytes: Buffer
  now?: Date
}): SavedImage {
  const type = imageType(input.contentType)
  if (type === undefined) throw new Error(`unsupported image type: ${input.contentType ?? "(none)"}`)
  if (input.bytes.byteLength === 0) throw new Error("image body is empty")
  if (input.bytes.byteLength > MAX_IMAGE_BYTES) throw new Error(`image is over the ${MAX_IMAGE_BYTES}-byte limit`)
  const extension = EXTENSION_BY_TYPE[type] as string
  const directory = mediaDir(input.agentHome)
  mkdirSync(directory, { recursive: true })
  const id = `${imageStamp(input.now ?? new Date())}-${randomBytes(3).toString("hex")}`
  const target = path.join(directory, `${id}.${extension}`)
  writeFileSync(target, input.bytes)
  return { id, path: target, bytes: input.bytes.byteLength }
}

export function mediaPath(agentHome: string, name: string): string | undefined {
  if (!MEDIA_NAME.test(name)) return undefined
  const directory = path.resolve(mediaDir(agentHome))
  const target = path.resolve(directory, name)
  return path.dirname(target) === directory ? target : undefined
}

export function readImagePart(file: string): LlmContentPart | undefined {
  const mimeType = imageMimeType(file)
  if (mimeType === undefined) return undefined
  let size: number
  try {
    const info = statSync(file)
    if (!info.isFile()) return undefined
    size = info.size
  } catch {
    return undefined
  }
  if (size <= 0 || size > MAX_IMAGE_BYTES) return undefined
  let data: Buffer
  try {
    data = readFileSync(file)
  } catch {
    return undefined
  }
  if (data.byteLength <= 0 || data.byteLength > MAX_IMAGE_BYTES) return undefined
  return { type: "image", mimeType, dataBase64: data.toString("base64") }
}

export function imageMarkerPaths(text: string): string[] {
  const paths: string[] = []
  for (const match of text.matchAll(IMAGE_MARKER)) {
    const raw = (match[1] ?? "").trim()
    if (raw !== "") paths.push(raw)
  }
  return paths
}

export function expandImageText(text: string): string | LlmContentPart[] {
  const paths = imageMarkerPaths(text)
  if (paths.length === 0) return text
  const images: LlmContentPart[] = []
  const missing: string[] = []
  for (const file of paths) {
    const part = path.isAbsolute(file) ? readImagePart(file) : undefined
    if (part === undefined) missing.push(`[image missing: ${file}]`)
    else images.push(part)
  }
  const remainder = text
    .replace(IMAGE_MARKER, " ")
    .split("\n")
    .map((line) => line.replace(/[ \t]{2,}/g, " ").trim())
    .filter((line) => line !== "")
    .join("\n")
  const prose = [remainder, ...missing].filter((line) => line !== "").join("\n")
  const parts: LlmContentPart[] = []
  if (prose !== "") parts.push({ type: "text", text: prose })
  parts.push(...images)
  return parts
}

export function withImageParts(message: LlmMessage): LlmMessage {
  if (message.role !== "user" || typeof message.content !== "string") return message
  const content = expandImageText(message.content)
  return typeof content === "string" ? message : { ...message, content }
}

export function createImageLlm(base: LlmClient): LlmClient {
  const stream = base.completeStream
  const withImages = (request: LlmCompleteRequest): LlmCompleteRequest => ({
    ...request,
    messages: request.messages.map(withImageParts),
  })
  return {
    model: base.model,
    complete: (request) => base.complete(withImages(request)),
    ...(stream === undefined
      ? {}
      : { completeStream: (request: LlmCompleteRequest, onDelta: LlmDelta) => stream.call(base, withImages(request), onDelta) }),
  }
}

function within(target: string, root: string): boolean {
  const base = path.resolve(root)
  return target === base || target.startsWith(`${base}${path.sep}`)
}

export type ViewableImage = { path: string } | { error: string }

export function viewableImage(raw: string, agentHome: string): ViewableImage {
  if (raw === "") return { error: "view_image requires path" }
  if (!path.isAbsolute(raw)) return { error: `view_image needs an absolute path: ${raw}` }
  const target = path.resolve(raw)
  const allowed = within(target, agentHome) || VIEW_ROOTS.some((root) => within(target, root))
  if (!allowed) {
    return { error: `view_image refuses ${target}: it must live under ${path.resolve(agentHome)} or /tmp` }
  }
  const mimeType = imageMimeType(target)
  if (mimeType === undefined) return { error: `view_image refuses ${target}: only PNG, JPEG and WebP are supported` }
  let size: number
  try {
    const info = statSync(target)
    if (!info.isFile()) return { error: `view_image cannot read ${target}: it is not a file` }
    size = info.size
  } catch {
    return { error: `view_image cannot read ${target}: no such file` }
  }
  if (size <= 0) return { error: `view_image cannot read ${target}: the file is empty` }
  if (size > MAX_IMAGE_BYTES) {
    return { error: `view_image refuses ${target}: ${size} bytes is over the ${MAX_IMAGE_BYTES}-byte limit` }
  }
  return { path: target }
}
