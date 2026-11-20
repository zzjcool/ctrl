// SSH quoting and error rewriting (CONTRACT §4).
//
// These are the tests that matter most for a shell-over-ssh backend: one
// unquoted quote is a command injection, and a leaked host name is a leak of
// the machine's identity into the transcript.

import assert from "node:assert/strict"
import { test } from "node:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildExecScript,
  joinArgv,
  quote,
  quotePath,
  remoteDirname,
  remotePath,
  sanitizeStderr,
  SshExecutor,
} from "../../src/exec/ssh.ts"

test("quote wraps a plain word", () => {
  assert.equal(quote("hello"), "'hello'")
  assert.equal(quote(""), "''")
})

test("quote keeps a space inside one word", () => {
  assert.equal(quote("/tmp/a b/c"), "'/tmp/a b/c'")
})

test("quote escapes a single quote as '\\''", () => {
  assert.equal(quote("it's"), `'it'\\''s'`)
  assert.equal(quote("'"), `''\\'''`)
})

test("quote keeps a newline literal inside the quotes", () => {
  assert.equal(quote("a\nb"), "'a\nb'")
})

test("quote survives a real shell round trip", () => {
  const hostile = `a'b"c; rm -rf /tmp/never$HOME\`id\`\n$x`
  const result = spawnSync("sh", ["-c", `printf %s ${quote(hostile)}`], { encoding: "utf8" })
  assert.equal(result.status, 0)
  assert.equal(result.stdout, hostile)
})

test("quotePath lets a leading tilde expand, and only a leading tilde", () => {
  assert.equal(quotePath("~"), '"$HOME"')
  assert.equal(quotePath("~/proj"), '"$HOME"/\'proj\'')
  assert.equal(quotePath("/srv/it's"), "'/srv/it'\\''s'")
  // A tilde that is not the first character is just a character.
  assert.equal(quotePath("/srv/~weird"), "'/srv/~weird'")
})

test("joinArgv quotes every element separately", () => {
  assert.equal(joinArgv(["sh", "-c", "echo hi"]), `'sh' '-c' 'echo hi'`)
  assert.equal(joinArgv([]), "")
})

test("buildExecScript always goes through sh -c, with cwd first", () => {
  const script = buildExecScript(["sh", "-c", "go build ./..."], "/srv/my proj")
  assert.equal(script, `cd '/srv/my proj' && sh -c ''\\''sh'\\'' '\\''-c'\\'' '\\''go build ./...'\\'''`)
  // …and it is a valid shell line (the outer shell does not choke on it).
  const checked = spawnSync("sh", ["-n", "-c", script], { encoding: "utf8" })
  assert.equal(checked.status, 0, checked.stderr)
})

test("buildExecScript without a cwd still wraps in sh -c", () => {
  assert.equal(buildExecScript(["ls", "-1Ap"]), `sh -c ''\\''ls'\\'' '\\''-1Ap'\\'''`)
})

test("buildExecScript survives the remote shell parse with hostile args", () => {
  const cwd = mkdtempSync(join(tmpdir(), "ctrl-quote-"))
  const script = buildExecScript(["printf", "%s|", "a b", "it's", "$HOME", "`date`"], cwd)
  const run = spawnSync("sh", ["-c", script], { encoding: "utf8" })
  assert.equal(run.status, 0, run.stderr)
  // Every argument arrives literally: no expansion, no word splitting.
  assert.equal(run.stdout, "a b|it's|$HOME|`date`|")
  rmSync(cwd, { recursive: true, force: true })
})

test("remotePath resolves relative targets against the session cwd", () => {
  assert.equal(remotePath("a.txt", "/srv/proj"), "/srv/proj/a.txt")
  assert.equal(remotePath("a.txt", "/srv/proj/"), "/srv/proj/a.txt")
  assert.equal(remotePath("/etc/hosts", "/srv/proj"), "/etc/hosts")
  assert.equal(remotePath("~/notes.md", "/srv/proj"), "~/notes.md")
  assert.equal(remotePath("~", "/srv/proj"), "~")
  assert.equal(remotePath("a.txt"), "a.txt")
})

test("remoteDirname handles absolute, relative and tilde paths", () => {
  assert.equal(remoteDirname("/srv/proj/a.txt"), "/srv/proj")
  assert.equal(remoteDirname("/a.txt"), "/")
  assert.equal(remoteDirname("a.txt"), ".")
  assert.equal(remoteDirname("~/x/a.txt"), "~/x")
  assert.equal(remoteDirname("/srv/proj/"), "/srv")
})

test("sanitizeStderr drops the ssh: prefix and the host name", () => {
  const raw = [
    "ssh: Could not resolve hostname hw-nj: Name or service not known",
    "warning: something happened on hw-nj",
  ].join("\n")
  const clean = sanitizeStderr(raw, "hw-nj")
  assert.ok(!clean.includes("ssh:"), clean)
  assert.ok(!clean.includes("hw-nj"), clean)
  assert.match(clean, /machine unreachable: could not resolve host name/)
  // Remote stderr is still useful and must survive.
  assert.match(clean, /warning: something happened on machine/)
})

test("sanitizeStderr rewrites a publickey rejection", () => {
  const clean = sanitizeStderr("user@hw-nj: Permission denied (publickey).", "hw-nj")
  assert.ok(!clean.includes("Permission denied (publickey)"), clean)
  assert.ok(!clean.includes("hw-nj"), clean)
  assert.match(clean, /authentication failed/)
})

test("sanitizeStderr passes a compiler error through untouched", () => {
  const raw = "./main.go:12:2: undefined: fmt"
  assert.equal(sanitizeStderr(raw, "hw-nj"), raw)
})

// ---------------------------------------------------------------------------
// SshExecutor against a stub `ssh` binary
//
// No network: the binary is a shell script that records its argv and replays
// canned output, so the parts ctrl actually owns — ControlMaster reuse, argv
// construction, exit-code handling, error rewriting — are covered for real.
// ---------------------------------------------------------------------------

interface StubOptions {
  masterExit?: number
  exit?: number
  stdout?: string
  stderr?: string
}

async function stubSsh(options: StubOptions): Promise<{ executor: SshExecutor; log: string; stdinFile: string; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), "ctrl-stub-ssh-"))
  const log = join(dir, "argv.log")
  const stdinFile = join(dir, "stdin.txt")
  const bin = join(dir, "ssh")
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      `printf 'argc=%s %s\\n' "$#" "$*" >> ${quote(log)}`,
      `cat > ${quote(stdinFile)} 2>/dev/null`,
      'for last; do :; done',
      'case "$*" in *" -N "*) exit ' + `${options.masterExit ?? 0}` + ";; esac",
      `printf '%s' ${quote(options.stdout ?? "")}`,
      `printf '%s' ${quote(options.stderr ?? "")} >&2`,
      `exit ${options.exit ?? 0}`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  )
  const socket = join(dir, "ctrl-host.sock")
  return {
    executor: new SshExecutor({ host: "hw-nj", sshBinary: bin, socketPath: socket }),
    log,
    stdinFile,
    dir,
  }
}

test("SshExecutor.exec reuses the ControlMaster socket and passes one script arg", async () => {
  const stub = await stubSsh({ stdout: "built\n" })
  try {
    const result = await stub.executor.exec(["sh", "-c", "go build ./..."], { cwd: "/srv/proj" })
    assert.equal(result.code, 0)
    assert.equal(result.stdout, "built")
    const lines = readFileSync(stub.log, "utf8").trim().split("\n")
    assert.equal(lines.length, 2, "one master connection, then one multiplexed call")
    assert.match(lines[0] ?? "", /-M -S .*ctrl-host\.sock -N -f -o ControlPersist=60/)
    assert.match(lines[1] ?? "", /-S .*ctrl-host\.sock/)
    assert.match(lines[1] ?? "", /hw-nj -- cd '\/srv\/proj' && sh -c /)
    // The remote command is ONE argument (-S sock -o opt host -- script = 7),
    // so the local shell never sees it.
    assert.match(lines[1] ?? "", /^argc=7 /)
  } finally {
    rmSync(stub.dir, { recursive: true, force: true })
  }
})

test("SshExecutor degrades to plain ssh when no master can be established", async () => {
  const stub = await stubSsh({ masterExit: 255, stderr: "ssh: connect to host hw-nj port 22: Connection refused", stdout: "still works" })
  try {
    const result = await stub.executor.exec(["true"])
    assert.equal(result.code, 0)
    assert.equal(result.stdout, "still works")
    const lines = readFileSync(stub.log, "utf8").trim().split("\n")
    // The degraded call must not point at a socket that does not exist.
    assert.ok(!(lines[1] ?? "").includes("-S "), lines[1])
  } finally {
    rmSync(stub.dir, { recursive: true, force: true })
  }
})

test("SshExecutor turns a 255 into a sanitized, host-free error", async () => {
  const stub = await stubSsh({
    masterExit: 0,
    exit: 255,
    stderr: "ssh: connect to host hw-nj port 22: Connection refused",
  })
  try {
    await assert.rejects(stub.executor.exec(["true"]), (error: Error) => {
      assert.match(error.message, /machine unreachable/)
      assert.ok(!error.message.includes("ssh:"), error.message)
      assert.ok(!error.message.includes("hw-nj"), error.message)
      return true
    })
  } finally {
    rmSync(stub.dir, { recursive: true, force: true })
  }
})

test("SshExecutor.write sends the body on stdin and creates parents first", async () => {
  const stub = await stubSsh({ masterExit: 0 })
  try {
    await stub.executor.write("~/proj/it's/a.txt", "body\n")
    const script = readFileSync(stub.log, "utf8").trim().split("\n")[1] ?? ""
    // One quoted block per path, with the tilde left expandable.
    assert.ok(script.includes(`mkdir -p "$HOME"/'proj/it'\\''s'`), script)
    assert.ok(script.includes(`cat > "$HOME"/'proj/it'\\''s/a.txt'`), script)
    assert.equal(readFileSync(stub.stdinFile, "utf8"), "body\n")
  } finally {
    rmSync(stub.dir, { recursive: true, force: true })
  }
})

test("SshExecutor.readTask keeps a running task readable and reports a finished one", async () => {
  const running = await stubSsh({ masterExit: 0, stdout: "compiling...\n\n__CTRL_TASK_EXIT__" })
  const finished = await stubSsh({ masterExit: 0, stdout: "done\n\n__CTRL_TASK_EXIT__0" })
  try {
    // A running task keeps its trailing newline; a finished one gets a line.
    assert.equal(await running.executor.readTask("hw-nj/tabc"), "compiling...\n")
    assert.equal(await finished.executor.readTask("hw-nj/tabc"), "done\n[exit 0]")
  } finally {
    rmSync(running.dir, { recursive: true, force: true })
    rmSync(finished.dir, { recursive: true, force: true })
  }
})

test("SshExecutor.read/list reject with a readable message instead of stderr soup", async () => {
  const stub = await stubSsh({ masterExit: 0, exit: 1, stderr: "cat: /srv/nope: No such file or directory" })
  try {
    await assert.rejects(stub.executor.read("/srv/nope"), /read \/srv\/nope failed: cat: \/srv\/nope: No such file or directory/)
    await assert.rejects(stub.executor.list("/srv/nope"), /list \/srv\/nope failed/)
  } finally {
    rmSync(stub.dir, { recursive: true, force: true })
  }
})
