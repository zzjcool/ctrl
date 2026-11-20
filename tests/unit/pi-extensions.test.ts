import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, test } from "node:test"
import { providerExtensionPath } from "../../src/jobs/pi-extensions.ts"

const dirs: string[] = []

after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})

async function home(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "ctrl-pi-ext-"))
  dirs.push(dir)
  return dir
}

test("the provider extension is found under the pi npm install root", async () => {
  const root = await home()
  const entry = path.join(root, ".pi", "agent", "npm", "abc123", "pi-any-endpoint", "extensions", "index.ts")
  await mkdir(path.dirname(entry), { recursive: true })
  await writeFile(entry, "")
  assert.equal(providerExtensionPath(root), entry)
})

test("a missing install root is reported as no extension, not an error", async () => {
  const root = await home()
  assert.equal(providerExtensionPath(root), undefined)
})
