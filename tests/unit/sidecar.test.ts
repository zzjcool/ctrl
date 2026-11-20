import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"
import { readSidecar, sidecarPath, writeSidecar } from "../../src/server/sidecar.ts"

async function home(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "ctrl-home-"))
}

test("sidecar lives next to the session log, not inside it", async () => {
  const root = await home()
  const file = sidecarPath(root, "20261016T193612Z-abc12345")
  assert.equal(file, path.join(root, "sessions", "20261016T193612Z-abc12345", "ctrl.json"))
})

test("write then read round trips the workspace", async () => {
  const root = await home()
  const written = writeSidecar(root, "s1", {
    cwd: "/home/u/proj",
    createdAt: "2026-10-16T19:36:12.000Z",
  })
  assert.deepEqual(readSidecar(root, "s1"), written)
  const onDisk = JSON.parse(await readFile(sidecarPath(root, "s1"), "utf8"))
  assert.deepEqual(Object.keys(onDisk).sort(), ["createdAt", "cwd"], "v3 writes cwd and createdAt, nothing else")
  assert.equal(onDisk.cwd, "/home/u/proj")
})

test("a missing sidecar is not an error", async () => {
  const root = await home()
  assert.equal(readSidecar(root, "never-written"), undefined)
})

test("a corrupt sidecar is ignored instead of thrown", async () => {
  const root = await home()
  const file = sidecarPath(root, "s2")
  await mkdir(path.dirname(file), { recursive: true })
  for (const body of ["{", "", "[]", "null", '{"cwd":42}', '{"machine":"hw-nj"}']) {
    await writeFile(file, body)
    assert.equal(readSidecar(root, "s2"), undefined, `body: ${body}`)
  }
})

test("a partially valid sidecar keeps the fields it has and defaults the rest", async () => {
  const root = await home()
  const file = sidecarPath(root, "s3")
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify({ cwd: "/srv" }))
  const value = readSidecar(root, "s3")
  assert.equal(value?.cwd, "/srv")
  assert.equal(value?.createdAt, new Date(0).toISOString())
})

test("a v2 sidecar still yields a workspace: machine is ignored, remoteCwd is the cwd", async () => {
  const root = await home()
  const file = sidecarPath(root, "s4")
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(
    file,
    JSON.stringify({ machine: "hw-nj", remoteCwd: "/home/u/proj", createdAt: "2026-10-16T19:36:12.000Z" }),
  )
  assert.deepEqual(readSidecar(root, "s4"), { cwd: "/home/u/proj", createdAt: "2026-10-16T19:36:12.000Z" })
})

test("an id that could escape the sessions directory is refused", async () => {
  const root = await home()
  assert.throws(() => sidecarPath(root, "../../etc"), /invalid session id/)
  assert.equal(readSidecar(root, "../../etc"), undefined)
})
