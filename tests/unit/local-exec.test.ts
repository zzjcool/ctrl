// LocalExecutor: the same seam as ssh, exercised for real (CONTRACT §4).

import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"
import { expandHome, LocalExecutor } from "../../src/exec/local.ts"

async function workspace(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "ctrl-local-"))
}

test("exec returns exit code, stdout and stderr", async () => {
  const exec = new LocalExecutor({ cwd: await workspace() })
  const ok = await exec.exec(["sh", "-c", "echo out; echo err >&2; exit 0"])
  assert.equal(ok.code, 0)
  assert.equal(ok.stdout, "out")
  assert.equal(ok.stderr, "err")
  assert.equal(ok.timedOut, false)
  assert.ok(ok.ms >= 0)

  const bad = await exec.exec(["sh", "-c", "echo boom >&2; exit 3"])
  assert.equal(bad.code, 3)
  assert.equal(bad.stderr, "boom")
})

test("exec honours cwd and stdin", async () => {
  const cwd = await workspace()
  const exec = new LocalExecutor({ cwd })
  const pwd = await exec.exec(["pwd"])
  // macOS resolves /tmp and /var through a /private symlink; compare real paths.
  const { realpath } = await import("node:fs/promises")
  assert.equal(await realpath(pwd.stdout), await realpath(cwd))

  const cat = await exec.exec(["sh", "-c", "cat"], { input: "hello stdin" })
  assert.equal(cat.stdout, "hello stdin")
  assert.equal(cat.code, 0)
})

test("exec kills the whole process group on timeout", async () => {
  const cwd = await workspace()
  const marker = path.join(cwd, "survived")
  const exec = new LocalExecutor({ cwd })
  const started = Date.now()
  const result = await exec.exec(
    ["sh", "-c", `sleep 0.6; touch ${JSON.stringify(marker)}; sleep 5`],
    { timeoutMs: 200 },
  )
  const elapsed = Date.now() - started
  assert.equal(result.timedOut, true)
  assert.ok(elapsed < 2000, `timeout should return fast, took ${elapsed}ms`)
  // If the process group survived, the marker appears ~400 ms later.
  await new Promise((resolve) => setTimeout(resolve, 700))
  await assert.rejects(readFile(marker, "utf8"), /ENOENT/)
})

test("read/write/list round trip, with 1-based offsets", async () => {
  const cwd = await workspace()
  const exec = new LocalExecutor({ cwd })
  await exec.write("sub/dir/file.txt", "a\nb\nc\nd\ne\n")
  assert.equal(await exec.read("sub/dir/file.txt"), "a\nb\nc\nd\ne\n")
  assert.equal(await exec.read("sub/dir/file.txt", { offset: 2, limit: 2 }), "b\nc")
  assert.equal(await exec.read(path.join(cwd, "sub/dir/file.txt"), { offset: 4 }), "d\ne")

  await exec.write("sub/dir/other.txt", "x")
  const entries = await exec.list("sub/dir")
  assert.deepEqual(entries, ["file.txt", "other.txt"])
  const root = await exec.list(".")
  assert.deepEqual(root, ["sub/"])
})

test("read rejects a binary payload instead of mangling it", async () => {
  const cwd = await workspace()
  const exec = new LocalExecutor({ cwd })
  await writeFile(path.join(cwd, "blob.bin"), Buffer.from([0x61, 0x00, 0x62]))
  await assert.rejects(exec.read("blob.bin"), /binary/)
})

test("exec reports a missing program as a failure, not a throw", async () => {
  const exec = new LocalExecutor({ cwd: await workspace() })
  const result = await exec.exec(["ctrl-no-such-program"])
  assert.equal(result.code, null)
  assert.match(result.stderr, /ENOENT/)
})

test("spawn/readTask/stopTask: a long task is polled, not awaited", async () => {
  const cwd = await workspace()
  const exec = new LocalExecutor({ cwd })
  const { address } = await exec.spawn(["sh", "-c", "echo started; sleep 5"], { cwd })
  assert.match(address, /^local\/[a-z0-9]+$/)

  // The spawn call returned before the command finished.
  const first = await waitFor(async () => {
    const text = await exec.readTask(address)
    return text.includes("started") ? text : undefined
  })
  assert.match(first, /started/)

  await exec.stopTask(address)
  // After a TERM the task is gone; reading must still be well defined.
  const after = await exec.readTask(address)
  assert.equal(typeof after, "string")
})

test("readTask reports the exit code of a finished task", async () => {
  const cwd = await workspace()
  const exec = new LocalExecutor({ cwd })
  const { address } = await exec.spawn(["sh", "-c", "echo done; exit 0"], { cwd })
  const output = await waitFor(async () => {
    const text = await exec.readTask(address)
    return text.includes("[exit 0]") ? text : undefined
  })
  assert.match(output, /done/)
})

test("readTask/stopTask reject an address from another machine", async () => {
  const exec = new LocalExecutor({ machine: "local", cwd: await workspace() })
  await assert.rejects(exec.readTask("hw-nj/t123"), /task address must look like local\/<id>/)
  await assert.rejects(exec.stopTask("../etc"), /task address must look like local\/<id>/)
})

test("expandHome resolves only a leading tilde", () => {
  assert.equal(expandHome("~").startsWith("/"), true)
  assert.equal(expandHome("~/x").endsWith("/x"), true)
  assert.equal(expandHome("/srv/~/x"), "/srv/~/x")
})

async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error("timed out waiting for condition")
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
