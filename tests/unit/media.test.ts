import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"
import { createSession } from "../../src/engine/durable.ts"
import { ImageAttachments, attachmentSink, hasDanglingCall } from "../../src/media/attachments.ts"
import type { LlmClient, LlmCompleteRequest, LlmContentPart, LlmMessage, LlmResponse } from "../../src/engine/durable.ts"
import {
  MAX_IMAGE_BYTES,
  createImageLlm,
  expandImageText,
  imageMarkerPaths,
  imageType,
  mediaPath,
  readImagePart,
  saveImage,
  viewableImage,
} from "../../src/media/images.ts"
import { createViewImageTool } from "../../src/media/tool.ts"

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  "base64",
)

const JPEG_1X1 = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0x00, 0x01, 0xff, 0xd9])

function workspace(): string {
  return mkdtempSync(path.join(tmpdir(), "ctrl-media-"))
}

function writeImage(directory: string, name: string, bytes: Buffer = PNG_1X1): string {
  const file = path.join(directory, name)
  writeFileSync(file, bytes)
  return file
}

test("an upload lands in <agentHome>/media with a stamped name and its byte count", () => {
  const home = workspace()
  try {
    const saved = saveImage({
      agentHome: home,
      contentType: "image/png",
      bytes: PNG_1X1,
      now: new Date("2024-03-04T05:06:07.890Z"),
    })
    assert.match(path.basename(saved.path), /^20240304T050607Z-[0-9a-f]{6}\.png$/)
    assert.equal(saved.id, path.basename(saved.path, ".png"))
    assert.equal(saved.bytes, PNG_1X1.byteLength)
    assert.equal(path.dirname(saved.path), path.join(home, "media"))
    assert.equal(path.isAbsolute(saved.path), true)
    assert.deepEqual(readFileSync(saved.path), PNG_1X1)

    const second = saveImage({ agentHome: home, contentType: "image/jpeg", bytes: JPEG_1X1 })
    assert.match(path.basename(second.path), /^\d{8}T\d{6}Z-[0-9a-f]{6}\.jpg$/)
    assert.notEqual(second.path, saved.path)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("only png, jpeg and webp content types are accepted", () => {
  assert.equal(imageType("image/png"), "image/png")
  assert.equal(imageType("IMAGE/JPEG"), "image/jpeg")
  assert.equal(imageType("image/webp; charset=binary"), "image/webp")
  assert.equal(imageType("image/jpeg\n"), "image/jpeg")
  assert.equal(imageType("text/plain"), undefined)
  assert.equal(imageType("image/gif"), undefined)
  assert.equal(imageType(undefined), undefined)

  const home = workspace()
  try {
    assert.throws(() => saveImage({ agentHome: home, contentType: "image/gif", bytes: PNG_1X1 }), /unsupported image type/)
    assert.throws(() => saveImage({ agentHome: home, contentType: undefined, bytes: PNG_1X1 }), /unsupported image type/)
    assert.throws(
      () => saveImage({ agentHome: home, contentType: "image/png", bytes: Buffer.alloc(MAX_IMAGE_BYTES + 1, 1) }),
      /over the 5242880-byte limit/,
    )
    assert.throws(() => saveImage({ agentHome: home, contentType: "image/png", bytes: Buffer.alloc(0) }), /empty/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("a readable image becomes an image part, and anything else does not", () => {
  const home = workspace()
  try {
    const png = writeImage(home, "shot.png")
    assert.deepEqual(readImagePart(png), {
      type: "image",
      mimeType: "image/png",
      dataBase64: PNG_1X1.toString("base64"),
    })

    const gif = writeImage(home, "anim.gif")
    assert.equal(readImagePart(gif), undefined)

    assert.equal(readImagePart(path.join(home, "missing.png")), undefined)

    const huge = writeImage(home, "huge.webp", Buffer.alloc(MAX_IMAGE_BYTES + 1, 1))
    assert.equal(readImagePart(huge), undefined)

    const empty = writeImage(home, "empty.png", Buffer.alloc(0))
    assert.equal(readImagePart(empty), undefined)

    assert.equal(readImagePart(home), undefined)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("media names are strict, so /media cannot escape its directory", () => {
  const home = "/tmp/ctrl-media-agent-home"
  const ok = mediaPath(home, "20240304T050607Z-abcdef.png")
  assert.equal(ok, path.join(home, "media", "20240304T050607Z-abcdef.png"))
  assert.equal(mediaPath(home, "../agent.json"), undefined)
  assert.equal(mediaPath(home, "../../etc/passwd"), undefined)
  assert.equal(mediaPath(home, ".."), undefined)
  assert.equal(mediaPath(home, "sub/20240304T050607Z-abcdef.png"), undefined)
  assert.equal(mediaPath(home, "/etc/passwd"), undefined)
  assert.equal(mediaPath(home, "20240304T050607Z-abcdef.exe"), undefined)
  assert.equal(mediaPath(home, "shot.png"), undefined)
  assert.equal(mediaPath(home, ""), undefined)
})

test("markers are found wherever they sit, several per message", () => {
  assert.deepEqual(imageMarkerPaths("no pictures here"), [])
  assert.deepEqual(imageMarkerPaths("[image:/a.png]"), ["/a.png"])
  assert.deepEqual(imageMarkerPaths("see [image:/a.png] and [image:/b.webp]"), ["/a.png", "/b.webp"])
  assert.deepEqual(imageMarkerPaths("[image: /a.png ]"), ["/a.png"])
  assert.deepEqual(imageMarkerPaths("[image:]"), [])
})

test("a user message with markers becomes content parts, and the marker text disappears", () => {
  const home = workspace()
  try {
    const first = writeImage(home, "one.png")
    const second = writeImage(home, "two.jpg", JPEG_1X1)

    assert.equal(expandImageText("plain words"), "plain words")

    const single = expandImageText(`what is this? [image:${first}]`)
    assert.deepEqual(single, [
      { type: "text", text: "what is this?" },
      { type: "image", mimeType: "image/png", dataBase64: PNG_1X1.toString("base64") },
    ])
    assert.doesNotMatch(JSON.stringify(single), new RegExp(`\\[image:${first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]`))

    const many = expandImageText(`[image:${first}] and [image:${second}] look`)
    const manyParts = many as LlmContentPart[]
    assert.equal(manyParts.length, 3)
    assert.deepEqual(manyParts[0], { type: "text", text: "and look" })
    assert.equal(manyParts[1]?.type, "image")
    assert.equal(manyParts[2]?.type, "image")
    assert.equal((manyParts[2] as { mimeType: string }).mimeType, "image/jpeg")

    const onlyImages = expandImageText(`[image:${first}] [image:${second}]`)
    assert.equal((onlyImages as LlmContentPart[]).length, 2, "no empty text part when there is no prose")

    const missing = expandImageText(`look [image:${path.join(home, "gone.png")}]`)
    assert.deepEqual(missing, [
      { type: "text", text: `look\n[image missing: ${path.join(home, "gone.png")}]` },
    ])

    const relative = expandImageText("look [image:media/shot.png]")
    assert.deepEqual(relative, [{ type: "text", text: "look\n[image missing: media/shot.png]" }])

    const huge = writeImage(home, "huge.png", Buffer.alloc(MAX_IMAGE_BYTES + 1, 7))
    const oversized = expandImageText(`[image:${huge}]`) as LlmContentPart[]
    assert.equal(oversized.length, 1)
    assert.deepEqual(oversized[0], { type: "text", text: `[image missing: ${huge}]` })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

function captureClient(): { client: LlmClient; requests: LlmCompleteRequest[] } {
  const requests: LlmCompleteRequest[] = []
  const reply: LlmResponse = {
    text: "ok",
    toolCalls: [],
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    finishReason: "stop",
  }
  const client: LlmClient = {
    model: "fake-model",
    complete: async (request) => {
      requests.push(request)
      return reply
    },
  }
  return { client, requests }
}

test("the llm wrapper turns marked user messages into parts and leaves every other message alone", async () => {
  const home = workspace()
  try {
    const file = writeImage(home, "shot.png")
    const { client, requests } = captureClient()
    const wrapped = createImageLlm(client)
    const messages: LlmMessage[] = [
      { role: "system", content: `system [image:${file}]` },
      { role: "user", content: `what is this? [image:${file}]` },
      { role: "user", content: "no pictures here" },
      { role: "assistant", content: `done [image:${file}]` },
      { role: "tool", content: `tool output [image:${file}]`, toolCallId: "call-1" },
    ]

    await wrapped.complete({ messages })

    const sent = requests[0]?.messages as LlmMessage[]
    assert.deepEqual(sent[0], messages[0], "a system message never becomes parts")
    assert.deepEqual(sent[1], {
      role: "user",
      content: [
        { type: "text", text: "what is this?" },
        { type: "image", mimeType: "image/png", dataBase64: PNG_1X1.toString("base64") },
      ],
    })
    assert.equal(sent[2], messages[2], "a message without markers is passed through untouched")
    assert.deepEqual(sent[3], messages[3])
    assert.deepEqual(sent[4], messages[4])
    assert.equal(wrapped.model, "fake-model")
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("viewableImage keeps the agent to its own home and /tmp", () => {
  const home = workspace()
  const tmpName = `ctrl-view-image-${process.pid}-${Date.now()}.png`
  const tmpFile = path.join("/tmp", tmpName)
  const elsewhere = mkdtempSync(path.join(tmpdir(), "ctrl-media-outside-"))
  try {
    const inside = writeImage(home, "inside.png")
    assert.deepEqual(viewableImage(inside, home), { path: inside })
    assert.deepEqual(viewableImage(`media/inside.png`, home), {
      error: "view_image needs an absolute path: media/inside.png",
    })

    writeFileSync(tmpFile, PNG_1X1)
    assert.deepEqual(viewableImage(tmpFile, home), { path: tmpFile })

    const outside = writeImage(elsewhere, "outside.png")
    const refused = viewableImage(outside, home)
    assert.ok("error" in refused)
    assert.match(refused.error, /must live under/)

    const traversal = viewableImage("/tmp/../etc/passwd.png", home)
    assert.ok("error" in traversal)
    assert.match(traversal.error, /must live under/)

    const gif = writeImage(home, "anim.gif")
    const gifCheck = viewableImage(gif, home)
    assert.ok("error" in gifCheck)
    assert.match(gifCheck.error, /only PNG, JPEG and WebP/)

    const nothing = viewableImage(path.join(home, "ghost.png"), home)
    assert.ok("error" in nothing)
    assert.match(nothing.error, /no such file/)

    const huge = writeImage(home, "huge.png", Buffer.alloc(MAX_IMAGE_BYTES + 1, 3))
    const hugeCheck = viewableImage(huge, home)
    assert.ok("error" in hugeCheck)
    assert.match(hugeCheck.error, /over the 5242880-byte limit/)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(elsewhere, { recursive: true, force: true })
    rmSync(tmpFile, { force: true })
  }
})

test("view_image attaches the picture to the log and refuses anything outside its reach", async () => {
  const home = workspace()
  try {
    const log = createSession({ sessionId: "main", home, cwd: home, model: "fake-model" })
    const attachments = new ImageAttachments()
    const tool = createViewImageTool({ agentHome: home, sessionId: "main", attachments })
    const file = writeImage(home, "shot.png")

    const outside = await tool.execute({ path: "/etc/hosts.png" }, fakeContext(home))
    assert.equal(outside.ok, false)
    assert.match(outside.output, /must live under/)

    const relative = await tool.execute({ path: "shot.png" }, fakeContext(home))
    assert.equal(relative.ok, false)
    assert.match(relative.output, /absolute path/)

    const missingPath = await tool.execute({}, fakeContext(home))
    assert.equal(missingPath.ok, false)
    assert.match(missingPath.output, /requires path/)

    const attached = await tool.execute({ path: file }, fakeContext(home))
    assert.equal(attached.ok, true)
    assert.equal(attached.output, `attached ${file} — you will see it on the next step`)
    assert.equal(attachments.queued("main"), 1, "the marker waits for the tool batch to finish")
    assert.deepEqual(
      log.events().filter((event) => event.type === "user_message"),
      [],
      "nothing is appended while the tool call is still unanswered",
    )

    const sink = attachmentSink(log, attachments)
    sink.appendToolCall({ callId: "call-1", name: "view_image", args: { path: file } })
    assert.equal(attachments.queued("main"), 1, "a pending call keeps the marker back")
    assert.equal(hasDanglingCall(log.events()), true)
    sink.appendToolResult({ callId: "call-1", name: "view_image", ok: true, output: attached.output })
    assert.equal(hasDanglingCall(log.events()), false)
    assert.equal(attachments.queued("main"), 0, "the marker is written once the call is answered")

    const appended = log.events().filter((event) => event.type === "user_message")
    assert.deepEqual(
      appended.map((event) => (event.type === "user_message" ? event.data.text : "")),
      [`[image:${file}]`],
    )
    const last = appended.at(-1)
    assert.equal(typeof last?.id, "string")
    assert.ok((last?.id ?? "").length > 0)
    assert.equal(Number.isFinite(Date.parse(String(last?.ts))), true)
    assert.equal(last?.seq, log.events().length - 1)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

function fakeContext(cwd: string) {
  return { cwd, allowBash: false, timeoutMs: 1000, maxOutputChars: 1000 }
}
