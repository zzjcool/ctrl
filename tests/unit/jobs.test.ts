import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, before, test } from "node:test"
import type { ToolContext } from "../../src/engine/durable.ts"
import { JobRunner } from "../../src/jobs/runner.ts"
import type { RunnerConfig } from "../../src/jobs/runner.ts"
import {
  JOB_ID_PATTERN,
  MAX_OUTPUT_CHARS,
  countRunning,
  isProcessAlive,
  jobPaths,
  listJobs,
  newJobId,
  readJob,
  readJobLog,
  readJobMeta,
  updateJobMeta,
  writeJobMeta,
} from "../../src/jobs/store.ts"
import type { JobMeta, JobView } from "../../src/jobs/store.ts"
import { createJobTools } from "../../src/jobs/tools.ts"

const FAKE_PI_SOURCE = `#!/bin/sh
printf 'args: %s\\n' "$*"
if [ -n "$FAKE_PI_STDERR" ]; then printf '%s\\n' "$FAKE_PI_STDERR" >&2; fi
sleep "\${FAKE_PI_SLEEP:-0}"
i=0
while [ "$i" -lt "\${FAKE_PI_LINES:-0}" ]; do
  printf 'line %s\\n' "$i"
  i=$((i+1))
done
if [ -n "$FAKE_PI_IGNORE_TERM" ]; then
  trap '' TERM
  while :; do sleep 1; done
fi
if [ -n "$FAKE_PI_BIG" ]; then
  j=0
  while [ "$j" -lt "$FAKE_PI_BIG" ]; do
    echo "BIG-LINE-$j-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx-END-$j"
    j=$((j+1))
  done
fi
printf 'done\\n'
exit "\${FAKE_PI_EXIT:-0}"
`

const ENV_KEYS = ["FAKE_PI_EXIT", "FAKE_PI_SLEEP", "FAKE_PI_LINES", "FAKE_PI_BIG", "FAKE_PI_STDERR", "FAKE_PI_IGNORE_TERM"] as const
type EnvKey = (typeof ENV_KEYS)[number]

const savedEnv = new Map<EnvKey, string | undefined>(ENV_KEYS.map((key) => [key, process.env[key]]))

function setEnv(vars: Partial<Record<EnvKey, string>>): void {
  for (const key of ENV_KEYS) {
    const value = vars[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

let fakePi: string
const scratch: string[] = []

async function scratchDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix))
  scratch.push(dir)
  return dir
}

let agentHome: string

function makeRunner(opts: Partial<RunnerConfig> = {}): JobRunner {
  return new JobRunner({
    agentHome,
    piBin: fakePi,
    piProvider: "any-endpoint",
    maxWorkers: 3,
    model: "test-model",
    thinking: "max",
    ...opts,
  })
}

function toolContext(cwd: string): ToolContext {
  return { cwd, allowBash: false, timeoutMs: 10_000, maxOutputChars: 8_000 }
}

function jobTool(runner: JobRunner, name: string) {
  const tool = createJobTools({ runner, agentHome }).find((candidate) => candidate.name === name)
  assert.ok(tool, `tool ${name} is missing from the frozen v3 set`)
  return tool
}

function idOf(output: string): string {
  const match = /^started job (\S+) — poll with job_status$/.exec(output)
  assert.ok(match, `unexpected delegate output: ${output}`)
  return match[1] as string
}

async function waitFor(
  read: () => JobView | undefined,
  done: (job: JobView) => boolean,
  label: string,
  timeoutMs = 10_000,
): Promise<JobView> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const job = read()
    if (job !== undefined && done(job)) return job
    if (Date.now() > deadline) throw new Error(`${label} (last: ${JSON.stringify(job)})`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

async function waitForLog(id: string, needle: string, timeoutMs = 5_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const text = readJobLog(agentHome, id, { full: true }).text
    if (text.includes(needle)) return text
    if (Date.now() > deadline) throw new Error(`the worker never wrote ${JSON.stringify(needle)}; log: ${text}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

function deadPid(): number {
  for (let pid = 900_000; pid < 900_100; pid += 1) {
    if (!isProcessAlive(pid)) return pid
  }
  throw new Error("no free pid found")
}

async function seedJobIn(
  home: string,
  id: string,
  meta: Partial<JobMeta> = {},
  startedAt: string = new Date().toISOString(),
): Promise<string> {
  await mkdir(jobPaths(home, id).dir, { recursive: true })
  writeJobMeta(home, {
    id,
    task: `seeded ${id}`,
    cwd: home,
    model: "test-model",
    thinking: "max",
    startedAt,
    pid: deadPid(),
    ...meta,
  })
  return id
}

async function seedJob(id: string, startedAt: string, meta: Partial<JobMeta> = {}): Promise<string> {
  return await seedJobIn(agentHome, id, meta, startedAt)
}

before(async () => {
  const dir = await scratchDir("ctrl-fake-pi-")
  fakePi = path.join(dir, "pi")
  await writeFile(fakePi, FAKE_PI_SOURCE, { mode: 0o755 })
  agentHome = await scratchDir("ctrl-jobs-home-")
})

after(async () => {
  restoreEnv()
  for (const dir of scratch) await rm(dir, { recursive: true, force: true })
})

test("a job id is 20261120T080102Z-a1b2c3 shaped and sortable", () => {
  const early = newJobId(new Date("2026-11-20T08:01:02Z"), "aaaaaa")
  const late = newJobId(new Date("2026-11-20T08:01:03Z"), "bbbbbb")
  assert.equal(early, "20261120T080102Z-aaaaaa")
  assert.match(early, JOB_ID_PATTERN)
  assert.ok(early < late, "ids sort by time")
  assert.notEqual(newJobId(), newJobId(), "the suffix keeps two jobs in one second apart")
})

test("the worker command line is the frozen one (CONTRACT §5.1)", () => {
  const runner = makeRunner({ piProvider: "any-endpoint" })
  assert.deepEqual(runner.workerArgv({ id: "20261120T080102Z-a1b2c3", task: "count the .ts files" }), [
    "-p",
    "count the .ts files",
    "--provider",
    "any-endpoint",
    "--model",
    "test-model",
    "--thinking",
    "max",
    "--no-session",
    "--mode",
    "json",
  ])
  assert.ok(
    runner.workerArgv({ id: "20261120T080102Z-a1b2c3", task: "t" }).join(" ").includes("--mode json"),
    "the worker streams JSON events so its log shows progress and can be watched for stalls",
  )
  assert.deepEqual(
    runner.workerArgv({ id: "20261120T080102Z-a1b2c3", task: "t", model: "other/model", thinking: "low" }).slice(4, 8),
    ["--model", "other/model", "--thinking", "low"],
    "delegate may override model and thinking per job",
  )
})

test("delegate starts a detached pi worker, writes the job dir, and returns at once", async () => {
  setEnv({ FAKE_PI_SLEEP: "0.6" })
  const runner = makeRunner()
  const work = await scratchDir("ctrl-jobs-work-")
  try {
    const started = Date.now()
    const reply = runner.delegate({ task: "say hi" }, work)
    assert.equal(reply.ok, true, reply.output)
    assert.ok(Date.now() - started < 1_000, "delegate must not wait for the worker")
    assert.equal(reply.output, `started job ${reply.id} — poll with job_status`)

    const id = reply.id as string
    assert.match(id, JOB_ID_PATTERN)

    const paths = jobPaths(agentHome, id)
    assert.ok((await stat(paths.metaPath)).isFile())
    assert.ok((await stat(paths.logPath)).isFile())
    assert.ok((await stat(paths.piDir)).isDirectory())

    const meta = readJobMeta(agentHome, id)
    assert.equal(meta?.id, id)
    assert.equal(meta?.task, "say hi")
    assert.equal(meta?.cwd, work, "the job runs in the cwd delegate was given")
    assert.equal(meta?.model, "test-model")
    assert.equal(meta?.thinking, "max")
    assert.equal(typeof meta?.pid, "number")
    assert.ok((meta?.pid ?? 0) > 0, "the pid is on disk, not only in memory")
    assert.equal(meta?.exitedAt, undefined)
    assert.equal(readJob(agentHome, id)?.state, "running")

    const log = await waitForLog(id, "args: -p say hi --provider any-endpoint")
    assert.match(log, /--no-session/)

    assert.equal(readJob(agentHome, id)?.state, "running")
    assert.equal(countRunning(agentHome), 1)

    const stopped = await runner.stop(id)
    assert.equal(stopped.ok, true, stopped.output)
  } finally {
    setEnv({})
  }
})

test("a finished worker is read from disk: state, exit code and the output tail", async () => {
  setEnv({ FAKE_PI_EXIT: "7", FAKE_PI_LINES: "3", FAKE_PI_STDERR: "something on stderr" })
  const runner = makeRunner()
  const work = await scratchDir("ctrl-jobs-work-")
  try {
    const reply = runner.delegate({ task: "fail please" }, work)
    const id = idOf(reply.output)

    const job = await waitFor(() => readJob(agentHome, id), (candidate) => candidate.state !== "running", "job never finished")
    assert.equal(job.state, "failed")
    assert.equal(job.code, 7)
    assert.equal(typeof job.exitedAt, "string")
    assert.ok(job.elapsedMs >= 0)

    const status = jobTool(runner, "job_status")
    const shown = await status.execute({ id, lines: 40 }, toolContext(work))
    assert.equal(shown.ok, true, shown.output)
    assert.ok(shown.output.includes(`job ${id}`), shown.output)
    assert.match(shown.output, /state: failed {2}exit: 7/)
    assert.match(shown.output, /elapsed: \d+\.\ds/)
    assert.match(shown.output, /line 2/, "the tail carries the worker's own output")
    assert.match(shown.output, /done/)
    assert.match(shown.output, /something on stderr/, "stderr lands in the same log")

    assert.equal(readJob(agentHome, id)?.state, "failed")
    assert.equal(makeRunner().delegate({ task: "" }, work).ok, false, "and the cap/validation still answers")
  } finally {
    setEnv({})
  }
})

test("delegate is refused past the concurrency cap, in words the model can act on", async () => {
  setEnv({ FAKE_PI_SLEEP: "5" })
  const runner = makeRunner({ maxWorkers: 2 })
  const work = await scratchDir("ctrl-jobs-work-")
  try {
    const first = runner.delegate({ task: "one" }, work)
    const second = runner.delegate({ task: "two" }, work)
    assert.equal(first.ok, true, first.output)
    assert.equal(second.ok, true, second.output)
    assert.equal(countRunning(agentHome), 2)

    const third = runner.delegate({ task: "three" }, work)
    assert.equal(third.ok, false)
    assert.equal(third.output, "2 workers already running — poll them with job_status")
    assert.equal(third.id, undefined, "a refused delegate starts nothing")

    for (const id of [first.id, second.id]) await runner.stop(id as string)

    const fourth = runner.delegate({ task: "four" }, work)
    assert.equal(fourth.ok, true, fourth.output)
    await runner.stop(fourth.id as string)
  } finally {
    setEnv({})
  }
})

test("delegate refuses a task or a cwd it cannot honour — without throwing", async () => {
  const runner = makeRunner()
  const work = await scratchDir("ctrl-jobs-work-")
  assert.equal(runner.delegate({ task: "   " }, work).ok, false)
  assert.match(runner.delegate({ task: "x", cwd: "/definitely/not/here-ctrl" }, work).output, /cwd does not exist/)

  const nested = path.join(work, "sub")
  await mkdir(nested)
  const reply = runner.delegate({ task: "relative", cwd: "sub" }, work)
  assert.equal(reply.ok, true, reply.output)
  assert.equal(readJobMeta(agentHome, reply.id as string)?.cwd, nested)
  await runner.stop(reply.id as string)
})

test("job_status with no id lists the recent jobs, newest first", async () => {
  const runner = makeRunner()
  const work = await scratchDir("ctrl-jobs-work-")
  setEnv({})
  const older = runner.delegate({ task: "an older task with a long tail so it gets cut in the listing" }, work)
  await new Promise((resolve) => setTimeout(resolve, 1_100))
  const newer = runner.delegate({ task: "the newer one" }, work)
  for (const id of [older.id, newer.id]) {
    await waitFor(() => readJob(agentHome, id as string), (job) => job.state !== "running", "job never finished")
  }

  const status = jobTool(runner, "job_status")
  const reply = await status.execute({}, toolContext(work))
  assert.equal(reply.ok, true)
  const lines = reply.output.split("\n")
  assert.equal(lines[0]?.startsWith(newer.id as string), true, `newest first, got: ${reply.output}`)
  assert.equal(lines[1]?.startsWith(older.id as string), true)
  assert.match(lines[0] ?? "", /^\S+ {2}exited +[\d.]+s {2}the newer one$/)
  assert.ok(reply.output.includes("older task with a long tail"), "the task is shown")

  const tail = await status.execute({ id: newer.id, lines: 2 }, toolContext(work))
  assert.ok(tail.output.trimEnd().endsWith("done"), tail.output)
})

test("full=true returns the whole log but stops at 20000 characters and says so", async () => {
  setEnv({ FAKE_PI_BIG: "300" })
  const runner = makeRunner()
  const work = await scratchDir("ctrl-jobs-work-")
  try {
    const reply = runner.delegate({ task: "be loud" }, work)
    const id = idOf(reply.output)
    await waitFor(() => readJob(agentHome, id), (job) => job.state !== "running", "job never finished")

    const raw = readJobLog(agentHome, id, { full: true })
    assert.ok(raw.truncated, "a 30000+ character log must be cut")
    assert.equal(raw.text.length, MAX_OUTPUT_CHARS)
    assert.ok(raw.text.trimEnd().endsWith("done"), "the tail of the log is what survives")

    const status = jobTool(runner, "job_status")
    const shown = await status.execute({ id, full: true }, toolContext(work))
    assert.ok(shown.output.includes(`truncated to the last ${MAX_OUTPUT_CHARS} characters`), shown.output)
    assert.ok(shown.output.length < MAX_OUTPUT_CHARS + 2_000)

    const tail = await status.execute({ id }, toolContext(work))
    const body = tail.output.split("\n\n").slice(1).join("\n\n")
    assert.equal(body.trim().split("\n").length, 40, "default is the last 40 lines")
  } finally {
    setEnv({})
  }
})

test("job_stop SIGTERMs the worker and the job then reads killed from disk alone", async () => {
  setEnv({ FAKE_PI_SLEEP: "30" })
  const runner = makeRunner()
  const work = await scratchDir("ctrl-jobs-work-")
  try {
    const reply = runner.delegate({ task: "hang around" }, work)
    const id = idOf(reply.output)
    const pid = readJobMeta(agentHome, id)?.pid ?? 0
    assert.equal(isProcessAlive(pid), true)

    const stop = jobTool(runner, "job_stop")
    const stopped = await stop.execute({ id }, toolContext(work))
    assert.equal(stopped.ok, true, stopped.output)
    assert.equal(stopped.output, `stopped ${id}`)
    assert.equal(isProcessAlive(pid), false, "the whole process group is gone")

    const job = readJob(agentHome, id)
    assert.equal(job?.state, "killed")
    assert.equal(job?.signal, "SIGTERM")
    assert.ok(typeof job?.exitedAt === "string")

    const again = await stop.execute({ id }, toolContext(work))
    assert.equal(again.ok, false)
    assert.match(again.output, /is not running \(killed\)/)
  } finally {
    setEnv({})
  }
})

test("a worker past the job timeout is killed by the sweep, and its log says why", async () => {
  setEnv({ FAKE_PI_SLEEP: "5" })
  const runner = makeRunner()
  const work = await scratchDir("ctrl-jobs-work-")
  try {
    assert.equal(runner.jobTimeoutMinutes, 15)
    const reply = runner.delegate({ task: "never finishes" }, work)
    const id = idOf(reply.output)
    const pid = readJobMeta(agentHome, id)?.pid ?? 0
    assert.equal(isProcessAlive(pid), true)

    const stopped = await runner.sweepTimeouts(Date.now() + 16 * 60_000)
    assert.deepEqual(stopped, [id])

    const job = readJob(agentHome, id)
    assert.equal(job?.state, "killed")
    assert.equal(job?.signal, "SIGTERM")
    assert.equal(isProcessAlive(pid), false, "the worker's process group is gone")

    const log = readJobLog(agentHome, id, { full: true }).text
    assert.match(log, /ctrl: job exceeded 15m — stopped/)
    const status = jobTool(runner, "job_status")
    const shown = await status.execute({ id }, toolContext(work))
    assert.match(shown.output, /state: killed/)
    assert.match(shown.output, /ctrl: job exceeded 15m — stopped/)

    assert.deepEqual(await runner.sweepTimeouts(Date.now() + 16 * 60_000), [])
  } finally {
    setEnv({})
  }
})

test("the sweep leaves a worker alone until it is actually past the timeout", async () => {
  setEnv({ FAKE_PI_SLEEP: "5" })
  const work = await scratchDir("ctrl-jobs-work-")
  try {

    const unlimited = makeRunner({ jobTimeoutMinutes: 0 })
    assert.equal(unlimited.jobTimeoutMinutes, 0)
    assert.deepEqual(await unlimited.sweepTimeouts(Date.now() + 365 * 24 * 60 * 60_000), [])

    const runner = makeRunner()
    const reply = runner.delegate({ task: "still young" }, work)
    const id = idOf(reply.output)

    const startedAt = Date.parse(readJobMeta(agentHome, id)?.startedAt ?? "")
    assert.deepEqual(await runner.sweepTimeouts(startedAt + 15 * 60_000), [], "elapsed == timeout is not over")
    assert.deepEqual(await runner.sweepTimeouts(), [])
    assert.equal(readJob(agentHome, id)?.state, "running")

    assert.deepEqual(await unlimited.sweepTimeouts(startedAt + 365 * 24 * 60 * 60_000), [])
    assert.equal(readJob(agentHome, id)?.state, "running", "0 disables the sweep")

    await runner.stop(id)
    assert.equal(readJob(agentHome, id)?.state, "killed")

    assert.equal(countRunning(agentHome), 0)
    assert.deepEqual(await runner.sweepTimeouts(Date.now() + 365 * 24 * 60 * 60_000), [])
  } finally {
    setEnv({})
  }
})

test("a worker that stopped writing its log is killed by the stall sweep, and its log says why", async () => {
  setEnv({ FAKE_PI_SLEEP: "30" })
  const runner = makeRunner()
  const work = await scratchDir("ctrl-jobs-work-")
  try {
    assert.equal(runner.stallMinutes, 4)
    const reply = runner.delegate({ task: "go quiet" }, work)
    const id = idOf(reply.output)
    const pid = readJobMeta(agentHome, id)?.pid ?? 0
    await waitForLog(id, "args: -p go quiet")

    const quietSince = new Date(Date.now() - 10 * 60_000)
    await utimes(jobPaths(agentHome, id).logPath, quietSince, quietSince)
    updateJobMeta(agentHome, id, { startedAt: quietSince.toISOString() })

    assert.deepEqual(await runner.sweepStalls(), [id])

    const job = readJob(agentHome, id)
    assert.equal(job?.state, "killed")
    assert.equal(job?.signal, "SIGTERM")
    assert.equal(isProcessAlive(pid), false, "the worker's process group is gone")

    const log = readJobLog(agentHome, id, { full: true }).text
    assert.match(log, /ctrl: no output for \d+m — stopped/)

    const shown = await jobTool(runner, "job_status").execute({ id }, toolContext(work))
    assert.match(shown.output, /state: killed/)
    assert.match(shown.output, /ctrl: no output for \d+m — stopped/, "the note survives the renderer as a plain line")

    assert.deepEqual(await runner.sweepStalls(), [])
  } finally {
    setEnv({})
  }
})

test("the stall sweep leaves a young worker and a busy worker alone", async () => {
  setEnv({ FAKE_PI_SLEEP: "30" })
  const runner = makeRunner()
  const work = await scratchDir("ctrl-jobs-work-")
  try {
    const reply = runner.delegate({ task: "just started" }, work)
    const id = idOf(reply.output)
    await waitForLog(id, "args: -p just started")

    assert.deepEqual(await runner.sweepStalls(), [], "the two-minute grace covers a fresh worker")
    assert.equal(readJob(agentHome, id)?.state, "running")

    updateJobMeta(agentHome, id, { startedAt: new Date(Date.now() - 10 * 60_000).toISOString() })
    assert.deepEqual(await runner.sweepStalls(), [], "an old job whose log just grew is still working")
    assert.equal(readJob(agentHome, id)?.state, "running")

    await runner.stop(id)
    assert.equal(readJob(agentHome, id)?.state, "killed")
  } finally {
    setEnv({})
  }
})

test("--stall-minutes 0 turns the stall sweep off", async () => {
  setEnv({ FAKE_PI_SLEEP: "30" })
  const work = await scratchDir("ctrl-jobs-work-")
  try {
    const runner = makeRunner()
    const reply = runner.delegate({ task: "quiet for an hour" }, work)
    const id = idOf(reply.output)
    await waitForLog(id, "args: -p quiet for an hour")

    const quietSince = new Date(Date.now() - 60 * 60_000)
    await utimes(jobPaths(agentHome, id).logPath, quietSince, quietSince)
    updateJobMeta(agentHome, id, { startedAt: quietSince.toISOString() })

    const off = makeRunner({ stallMinutes: 0 })
    assert.equal(off.stallMinutes, 0)
    assert.deepEqual(await off.sweepStalls(), [])
    assert.equal(readJob(agentHome, id)?.state, "running")

    await runner.stop(id)
    assert.equal(readJob(agentHome, id)?.state, "killed")
  } finally {
    setEnv({})
  }
})

test("the tools answer a bad id with a sentence instead of throwing", async () => {
  const runner = makeRunner()
  const work = await scratchDir("ctrl-jobs-work-")
  const status = jobTool(runner, "job_status")
  const stop = jobTool(runner, "job_stop")

  const missing = await status.execute({ id: "20261120T080102Z-ffffff" }, toolContext(work))
  assert.equal(missing.ok, false)
  assert.match(missing.output, /no such job/)

  const escaping = await status.execute({ id: "../../etc/passwd" }, toolContext(work))
  assert.equal(escaping.ok, false, "a path is not a job id")

  const stopMissing = await stop.execute({ id: "20261120T080102Z-ffffff" }, toolContext(work))
  assert.equal(stopMissing.ok, false)
  assert.match(stopMissing.output, /no such job/)

  const stopNothing = await stop.execute({}, toolContext(work))
  assert.equal(stopNothing.ok, false)
  assert.match(stopNothing.output, /requires an id/)
})

test("a job's state is derived from meta.json plus a liveness probe", async () => {
  const live = await seedJob(newJobId(new Date("2026-11-20T08:00:00Z"), "live01"), "2020-01-01T00:00:00.000Z", {
    pid: process.pid,
  })
  const dead = await seedJob(newJobId(new Date("2026-11-20T08:00:01Z"), "dead01"), "2020-01-01T00:00:01.000Z")
  const ok = await seedJob(newJobId(new Date("2026-11-20T08:00:02Z"), "ok0001"), "2020-01-01T00:00:02.000Z", {
    exitedAt: "2020-01-01T00:00:12.000Z",
    code: 0,
    signal: null,
  })
  const bad = await seedJob(newJobId(new Date("2026-11-20T08:00:03Z"), "bad001"), "2020-01-01T00:00:03.000Z", {
    exitedAt: "2020-01-01T00:00:13.000Z",
    code: 3,
    signal: null,
  })
  const killed = await seedJob(newJobId(new Date("2026-11-20T08:00:04Z"), "kill01"), "2020-01-01T00:00:04.000Z", {
    exitedAt: "2020-01-01T00:00:14.000Z",
    code: null,
    signal: "SIGTERM",
  })

  assert.equal(readJob(agentHome, live)?.state, "running", "a live pid is running")
  assert.equal(readJob(agentHome, dead)?.state, "lost", "gone with no exit recorded = ctrl died while it ran")
  assert.equal(readJob(agentHome, ok)?.state, "exited")
  assert.equal(readJob(agentHome, bad)?.state, "failed")
  assert.equal(readJob(agentHome, killed)?.state, "killed")

  assert.equal(readJob(agentHome, ok)?.elapsedMs, 10_000)
  assert.ok((readJob(agentHome, live)?.elapsedMs ?? 0) > 0)

  const seeded = [live, dead, ok, bad, killed]
  const listed = listJobs(agentHome, { limit: 0 })
    .map((job) => job.id)
    .filter((id) => seeded.includes(id))
  assert.deepEqual(listed, [killed, bad, ok, dead, live])

  const empty = await scratchDir("ctrl-jobs-empty-")
  assert.deepEqual(listJobs(empty), [])
  assert.equal(readJob(empty, "20261120T080102Z-ffffff"), undefined)
  assert.equal(countRunning(empty), 0)
})

test("a job directory that was hand-made in an earlier run is still readable", async () => {

  const home = await scratchDir("ctrl-jobs-handmade-")
  const id = "20261120T080102Z-a1b2c3"
  await mkdir(path.join(home, "jobs", id, "pi"), { recursive: true })
  await writeFile(
    path.join(home, "jobs", id, "meta.json"),
    JSON.stringify({
      id,
      task: "count the .ts files",
      cwd: "/tmp",
      model: "workbuddy/deepseek-v4.1-flash",
      thinking: "max",
      startedAt: new Date(Date.now() - 2_000).toISOString(),
      pid: deadPid(),
      exitedAt: new Date().toISOString(),
      code: 0,
    }),
  )
  await writeFile(path.join(home, "jobs", id, "out.log"), "found 42 files\ndone\n")

  const job = readJob(home, id)
  assert.equal(job?.state, "exited")
  assert.equal(job?.task, "count the .ts files")
  assert.equal(readJobLog(home, id).text, "found 42 files\ndone")

  const runner = makeRunner()
  const status = createJobTools({ runner, agentHome: home }).find((tool) => tool.name === "job_status")
  const shown = await status?.execute({ id }, toolContext("/tmp"))
  assert.match(shown?.output ?? "", /found 42 files/)
  assert.equal(shown?.output.split("\n\n").slice(1).join("\n\n").trimEnd(), "found 42 files\ndone", "plain log lines stay as they are")
})

test("job_status renders a JSONL worker log as a timeline", async () => {
  const home = await scratchDir("ctrl-jobs-jsonl-")
  const id = await seedJobIn(home, "20261120T080102Z-jsonl1", {
    exitedAt: new Date().toISOString(),
    code: 0,
    signal: null,
  })
  const stream = readFileSync(new URL("./fixtures/pi-json-stream.jsonl", import.meta.url), "utf8")
  const giant = JSON.stringify({ type: "agent_end", messages: [{ role: "system", content: "pad ".repeat(9_000) }] })
  await writeFile(path.join(home, "jobs", id, "out.log"), `${stream}${giant}\nctrl: no output for 4m — stopped\n`)

  const runner = makeRunner()
  const status = createJobTools({ runner, agentHome: home }).find((tool) => tool.name === "job_status")
  const shown = await status?.execute({ id }, toolContext("/tmp"))
  const body = (shown?.output ?? "").split("\n\n").slice(1).join("\n\n").trimEnd()
  assert.equal(
    body,
    [
      "→ bash: echo hello-ctrl",
      "← hello-ctrl",
      "assistant: The command printed `hello-ctrl`.",
      "ctrl: no output for 4m — stopped",
    ].join("\n"),
    shown?.output,
  )
  assert.ok(!shown?.output.includes("tool_execution_start"), "raw events do not leak into the status")
  assert.ok(
    body.includes("→ bash: echo hello-ctrl"),
    "a huge trailing event does not push the timeline out of the window",
  )
  assert.equal(body.split("\n").length, 4)
})

test("a missing pi binary is refused up front, not turned into a ghost job", async () => {
  const work = await scratchDir("ctrl-jobs-work-")
  const before = listJobs(agentHome, { limit: 0 }).length

  const missing = makeRunner({ piBin: "/definitely/not/a/pi-binary" }).delegate({ task: "will not start" }, work)
  assert.equal(missing.ok, false)
  assert.match(missing.output, /pi binary not found or not executable: \/definitely\/not\/a\/pi-binary/)
  assert.match(missing.output, /--pi-bin/)
  assert.equal(listJobs(agentHome, { limit: 0 }).length, before, "a refused delegate leaves no job directory")

  const onPath = makeRunner({ piBin: "ctrl-no-such-pi-binary" })
  assert.match(onPath.delegate({ task: "not on PATH" }, work).output, /pi binary not found/)
})

test("the delegate tool waits out a fast worker and returns the finished job", async () => {
  setEnv({ FAKE_PI_SLEEP: "0.2", FAKE_PI_LINES: "1" })
  const runner = makeRunner()
  const work = await scratchDir("ctrl-jobs-work-")
  const delegate = createJobTools({ runner, agentHome }).find((tool) => tool.name === "delegate")

  const reply = await delegate?.execute({ task: "quick" }, toolContext(work))
  assert.equal(reply?.ok, true, reply?.output)
  assert.match(reply?.output ?? "", /state: exited/)
  assert.match(reply?.output ?? "", /exit: 0/)
})

test("job_status waits for a running worker instead of returning immediately", async () => {
  setEnv({ FAKE_PI_SLEEP: "1.5" })
  const runner = makeRunner()
  const work = await scratchDir("ctrl-jobs-work-")
  const tools = createJobTools({ runner, agentHome })
  const delegate = tools.find((tool) => tool.name === "delegate")
  const status = tools.find((tool) => tool.name === "job_status")

  const started = await delegate?.execute({ task: "slowish", wait: 100 }, toolContext(work))
  assert.match(started?.output ?? "", /started job/)
  const id = /job (\S+)/.exec(started?.output ?? "")?.[1] as string

  const waited = await status?.execute({ id, wait: 5000 }, toolContext(work))
  assert.match(waited?.output ?? "", /state: exited/)
  assert.match(waited?.output ?? "", /exit: 0/)
})

test("a worker that ignores SIGTERM is still stopped, with SIGKILL", async () => {
  setEnv({ FAKE_PI_IGNORE_TERM: "1" })
  const runner = makeRunner()
  const work = await scratchDir("ctrl-jobs-work-")
  const reply = runner.delegate({ task: "stubborn" }, work)
  const id = reply.id as string
  await waitForLog(id, "args: -p stubborn")
  await new Promise((resolve) => setTimeout(resolve, 400))
  const stopped = await runner.stop(id)
  assert.equal(stopped.ok, true, stopped.output)
  assert.match(stopped.output, /SIGKILL/)
  assert.equal(readJob(agentHome, id)?.state, "killed")
})

test("job_status tells the model to stop polling after three checks", async () => {
  setEnv({ FAKE_PI_SLEEP: "30" })
  const runner = makeRunner()
  const work = await scratchDir("ctrl-jobs-work-")
  const tools = createJobTools({ runner, agentHome })
  const delegate = tools.find((tool) => tool.name === "delegate")
  const status = tools.find((tool) => tool.name === "job_status")
  const started = await delegate?.execute({ task: "long", wait: 0 }, toolContext(work))
  const id = /job (\S+)/.exec(started?.output ?? "")?.[1] as string
  for (let i = 0; i < 3; i += 1) await status?.execute({ id, wait: 0 }, toolContext(work))
  const fourth = await status?.execute({ id, wait: 0 }, toolContext(work))
  assert.match(fourth?.output ?? "", /Stop polling/)
  await runner.stop(id)
})
