import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { request as httpRequest } from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, before, test } from "node:test"
import { startServer, type RunningServer } from "../../src/server/server.ts"

const AGENT = "media"

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  "base64",
)

const MAX_IMAGE_BYTES = 5 * 1024 * 1024

interface Reply {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: Buffer
  text: string
  json: any
}

interface Fixture {
  running: RunningServer
  root: string
  workspace: string
  agentHome: string
}

let fixture: Fixture

before(async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ctrl-media-contract-root-"))
  const workspace = await mkdtemp(path.join(tmpdir(), "ctrl-media-contract-work-"))
  const running = await startServer({
    root,
    agent: AGENT,
    workspace,
    port: 0,
    host: "127.0.0.1",
    maxSteps: 2,
    dream: false,
    env: { ...process.env, PI_DURABLE_API_KEY: "contract-key", PI_DURABLE_MODEL: "fake-model" },
  })
  fixture = { running, root, workspace, agentHome: path.join(root, "agents", AGENT) }
})

after(async () => {
  await fixture.running.close()
  await rm(fixture.root, { recursive: true, force: true })
  await rm(fixture.workspace, { recursive: true, force: true })
})

function send(
  method: string,
  requestPath: string,
  body?: Buffer,
  headers: Record<string, string> = {},
): Promise<Reply> {
  return new Promise<Reply>((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: fixture.running.port,
        method,
        path: requestPath,
        headers: {
          ...headers,
          ...(body === undefined ? {} : { "content-length": Buffer.byteLength(body) as unknown as string }),
        },
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
        response.on("end", () => {
          const payload = Buffer.concat(chunks)
          const text = payload.toString("utf8")
          let json: unknown
          try {
            json = JSON.parse(text)
          } catch {
            json = undefined
          }
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body: payload, text, json })
        })
      },
    )
    req.on("error", reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

function upload(bytes: Buffer, contentType: string): Promise<Reply> {
  return send("POST", "/api/agent/images", bytes, { "content-type": contentType })
}

test("an uploaded screenshot is stored under the agent home and served back byte for byte", async () => {
  const reply = await upload(PNG_1X1, "image/png")
  assert.equal(reply.status, 200, reply.text)
  const saved = reply.json as { id: string; path: string; bytes: number }
  assert.equal(saved.bytes, PNG_1X1.byteLength)
  assert.equal(path.isAbsolute(saved.path), true)
  assert.equal(path.dirname(saved.path), path.join(fixture.agentHome, "media"))
  assert.match(path.basename(saved.path), /^\d{8}T\d{6}Z-[0-9a-f]{6}\.png$/)
  assert.equal(path.basename(saved.path, ".png"), saved.id)
  assert.deepEqual(await readFile(saved.path), PNG_1X1)
  assert.equal((await stat(saved.path)).isFile(), true)

  const served = await send("GET", `/media/${encodeURIComponent(path.basename(saved.path))}`)
  assert.equal(served.status, 200, served.text)
  assert.equal(served.headers["content-type"], "image/png")
  assert.equal(served.headers["cache-control"], "max-age=31536000")
  assert.deepEqual(served.body, PNG_1X1)

  const head = await send("HEAD", `/media/${path.basename(saved.path)}`)
  assert.equal(head.status, 200)
  assert.equal(head.body.byteLength, 0)

  const missing = await send("GET", "/media/20240101T000000Z-abcdef.png")
  assert.equal(missing.status, 404, missing.text)
})

test("a body that is not png, jpeg or webp is refused before it is written", async () => {
  assert.equal((await upload(Buffer.from("<svg/>"), "text/plain")).status, 415)
  assert.equal((await upload(PNG_1X1, "image/gif")).status, 415)
  assert.equal((await upload(PNG_1X1, "application/octet-stream")).status, 415)
  assert.equal((await send("POST", "/api/agent/images", PNG_1X1)).status, 415)
  assert.equal((await upload(Buffer.alloc(0), "image/png")).status, 400)

  const listing = await stat(path.join(fixture.agentHome, "media"))
  assert.equal(listing.isDirectory(), true, "no refused upload may create a file")

  assert.equal((await send("GET", "/api/agent/images")).status, 405)
})

test("an upload over 5 MB is refused with 413", async () => {
  const reply = await upload(Buffer.alloc(MAX_IMAGE_BYTES + 1, 9), "image/png")
  assert.equal(reply.status, 413, reply.text)
  assert.match(reply.text, /too large/)
})

test("the media route cannot be walked out of its directory", async () => {
  for (const attempt of [
    "/media/..%2Fagent.json",
    "/media/..%2F..%2Fagent.json",
    "/media/%2e%2e%2fagent.json",
    "/media/..%2Fsessions%2Fmain%2Fevents.jsonl",
  ]) {
    const reply = await send("GET", attempt)
    assert.ok(reply.status === 400 || reply.status === 404, `${attempt} returned ${reply.status}`)
    assert.doesNotMatch(reply.text, /"name": "media"/)
    assert.doesNotMatch(reply.text, /session_created/)
  }

  assert.equal((await send("GET", "/media/agent.json")).status, 404)
  assert.equal((await send("GET", "/media/")).status, 404)
  assert.equal((await send("GET", "/media/%E0%A4%A")).status, 400)
})
