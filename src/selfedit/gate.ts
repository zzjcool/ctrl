import type { DatabaseSync } from "node:sqlite"
import { readJobLog } from "../jobs/store.ts"
import {
  DEFAULT_PROPOSAL_LIMIT,
  createProposal,
  failingTests,
  getProposal,
  listProposals,
  testsGreen,
  updateProposal,
} from "../memory/proposals.ts"
import type { Proposal, ProposalTests } from "../memory/proposals.ts"
import {
  git,
  gitAddAll,
  gitBranch,
  gitBranchExists,
  gitCheckout,
  gitCommit,
  gitCreateBranch,
  gitDeleteBranch,
  gitDiff,
  gitDiffStat,
  gitHasStagedChanges,
  gitMergeNoFf,
  gitStatusPorcelain,
  errorMessage,
  runCommand,
} from "./git.ts"

export const SELF_BRANCH_PREFIX = "self/"

export const DEFAULT_BASE_BRANCH = "main"

export const VERIFY_SLOTS = ["typecheck", "unit", "e2e", "contract"] as const

export const DEFAULT_VERIFY_COMMANDS = ["npm run typecheck", "npm test", "npm run test:e2e", "npm run test:contract"]

export const DEFAULT_VERIFY_TIMEOUT_MS = 600_000

export const MAX_DIFF_CHARS = 200_000

export const MAX_TEST_OUTPUT_CHARS = 20_000

export const MAX_COMMIT_TASK_CHARS = 60

export const MAX_SUMMARY_CHARS = 500

export const RESTART_DELAY_MS = 500

export interface SelfEditRunner {
  delegate(input: { task: string; cwd?: string }, fallbackCwd: string): { ok: boolean; output: string; id?: string }
}

export interface SelfEditGateOptions {
  repoRoot: string
  runner: SelfEditRunner
  db?: DatabaseSync
  agentHome?: string
  verifyCommands?: string[]
  verifyTimeoutMs?: number
  baseBranch?: string
  restart?: () => void
  warn?: (message: string) => void
  now?: () => Date
}

export interface SelfEditStart {
  ok: boolean
  output: string
  jobId?: string
  branch?: string
}

export interface SelfEditExit {
  id: string
  code?: number | null
  signal?: string | null
}

interface PendingEdit {
  proposalId: string
  jobId: string
  branch: string
  base: string
  task: string
  createdAt: string
}

export class GateError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = "GateError"
    this.status = status
  }
}

export function selfEditBranchName(now: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0")
  const stamp = [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    "-",
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join("")
  return `${SELF_BRANCH_PREFIX}${stamp}`
}

export function selfEditProposalId(now: Date = new Date()): string {
  return selfEditBranchName(now).slice(SELF_BRANCH_PREFIX.length)
}

export function workerTask(task: string, repoRoot: string, branch: string): string {
  return (
    `${task}\n\n` +
    `你在 ${repoRoot} 的 ${branch} 分支上工作；只改源码和测试；` +
    `不要动 .git、不要改 package.json 的 scripts、不要碰仓库外的文件；` +
    `改了测试必须在 commit message 里说明理由。`
  )
}

export class SelfEditGate {
  readonly repoRoot: string
  readonly verifyCommands: string[]
  readonly verifyTimeoutMs: number
  readonly baseBranch: string
  readonly restart: () => void
  private readonly runner: SelfEditRunner
  private readonly db: DatabaseSync | undefined
  private readonly agentHome: string | undefined
  private readonly warn: (message: string) => void
  private readonly now: () => Date
  private readonly pending = new Map<string, PendingEdit>()

  constructor(opts: SelfEditGateOptions) {
    this.repoRoot = opts.repoRoot
    this.runner = opts.runner
    this.db = opts.db
    this.agentHome = opts.agentHome
    this.verifyCommands = opts.verifyCommands !== undefined && opts.verifyCommands.length > 0 ? [...opts.verifyCommands] : [...DEFAULT_VERIFY_COMMANDS]
    this.verifyTimeoutMs =
      opts.verifyTimeoutMs !== undefined && Number.isFinite(opts.verifyTimeoutMs) && opts.verifyTimeoutMs > 0
        ? Math.floor(opts.verifyTimeoutMs)
        : DEFAULT_VERIFY_TIMEOUT_MS
    this.baseBranch = opts.baseBranch?.trim() || DEFAULT_BASE_BRANCH
    this.restart = opts.restart ?? (() => process.exit(0))
    this.warn = opts.warn ?? ((message: string) => process.stderr.write(`ctrl: ${message}\n`))
    this.now = opts.now ?? (() => new Date())
  }

  get busy(): boolean {
    return this.pending.size > 0
  }

  activeJobId(): string | undefined {
    return this.pending.keys().next().value
  }

  list(): Proposal[] {
    if (this.db === undefined) return []
    try {
      return listProposals(this.db, { limit: DEFAULT_PROPOSAL_LIMIT })
    } catch (error) {
      this.warn(`could not list proposals: ${errorMessage(error)}`)
      return []
    }
  }

  async detail(id: string): Promise<{ proposal: Proposal; diff: string }> {
    const proposal = this.requireProposal(id)
    const result = await gitDiff(this.repoRoot, proposal.base, proposal.branch)
    const diff = result.ok ? result.stdout : ""
    return { proposal, diff: diff.length > MAX_DIFF_CHARS ? diff.slice(0, MAX_DIFF_CHARS) : diff }
  }

  async start(task: string): Promise<SelfEditStart> {
    const trimmed = task.trim()
    if (trimmed === "") return { ok: false, output: "self_edit requires a non-empty task" }
    if (this.busy) {
      return { ok: false, output: `a self-edit job is still running (${this.activeJobId() ?? "unknown"}) — wait for its proposal` }
    }

    const status = await gitStatusPorcelain(this.repoRoot)
    if (!status.ok) return { ok: false, output: `cannot read the repo at ${this.repoRoot}: ${clip(status.stderr)}` }
    if (status.stdout.trim() !== "") return { ok: false, output: "the workspace is not clean — commit or stash the changes before self_edit" }

    const current = await gitBranch(this.repoRoot)
    if (current === undefined) return { ok: false, output: `cannot read the current branch of ${this.repoRoot}` }
    if (current.startsWith(SELF_BRANCH_PREFIX)) {
      return { ok: false, output: `already on ${current} — return to ${this.baseBranch} before self_edit` }
    }

    const timestamp = this.now()
    const proposalId = selfEditProposalId(timestamp)
    const branch = `${SELF_BRANCH_PREFIX}${proposalId}`
    if (await gitBranchExists(this.repoRoot, branch)) {
      return { ok: false, output: `branch ${branch} already exists — discard that proposal first` }
    }

    const created = await gitCreateBranch(this.repoRoot, branch)
    if (!created.ok) return { ok: false, output: `could not create ${branch}: ${clip(created.stderr)}` }

    const reply = this.runner.delegate({ task: workerTask(trimmed, this.repoRoot, branch), cwd: this.repoRoot }, this.repoRoot)
    if (!reply.ok || reply.id === undefined) {
      await gitCheckout(this.repoRoot, current)
      return { ok: false, output: reply.output }
    }

    this.pending.set(reply.id, {
      proposalId,
      jobId: reply.id,
      branch,
      base: current,
      task: trimmed,
      createdAt: timestamp.toISOString(),
    })

    return {
      ok: true,
      output: `started self-edit job ${reply.id} on branch ${branch} — the proposal appears when it exits`,
      jobId: reply.id,
      branch,
    }
  }

  async handleExit(exit: SelfEditExit): Promise<Proposal | undefined> {
    const pending = this.pending.get(exit.id)
    if (pending === undefined) return undefined
    try {
      return await this.settle(pending, exit)
    } catch (error) {
      return this.recordFailure(pending, exit, errorMessage(error))
    } finally {
      this.pending.delete(exit.id)
      await this.returnToBase()
    }
  }

  async apply(id: string): Promise<Proposal> {
    const db = this.requireDb()
    const proposal = this.requireProposal(id)
    if (proposal.status !== "open") throw new GateError(409, `proposal ${id} is ${proposal.status}`)
    if (!testsGreen(proposal.tests)) {
      const failing = failingTests(proposal.tests)
      throw new GateError(
        409,
        failing.length === 0
          ? `proposal ${id} has no verification results — it cannot be applied`
          : `proposal ${id} failed ${failing.join(", ")} — it cannot be applied`,
      )
    }
    if (this.busy) throw new GateError(409, `a self-edit job is still running (${this.activeJobId() ?? "unknown"})`)

    const status = await gitStatusPorcelain(this.repoRoot)
    if (!status.ok) throw new GateError(409, `cannot read the repo at ${this.repoRoot}: ${clip(status.stderr)}`)
    if (status.stdout.trim() !== "") throw new GateError(409, "the workspace is not clean — commit or stash the changes before applying")

    if (!(await gitBranchExists(this.repoRoot, proposal.branch))) {
      throw new GateError(409, `branch ${proposal.branch} no longer exists`)
    }

    const checkout = await gitCheckout(this.repoRoot, this.baseBranch)
    if (!checkout.ok) throw new GateError(409, `could not check out ${this.baseBranch}: ${clip(checkout.stderr)}`)

    const merge = await gitMergeNoFf(this.repoRoot, proposal.branch, `self-edit: merge ${proposal.branch}`)
    if (!merge.ok) {
      await git(this.repoRoot, ["merge", "--abort"])
      throw new GateError(409, `merge of ${proposal.branch} failed: ${clip(merge.stderr)}`)
    }

    return updateProposal(db, id, { status: "applied", endedAt: this.now().toISOString() }) ?? proposal
  }

  async discard(id: string): Promise<Proposal> {
    const db = this.requireDb()
    const proposal = this.requireProposal(id)
    if (proposal.status === "applied") throw new GateError(409, `proposal ${id} is already applied`)
    for (const pending of this.pending.values()) {
      if (pending.branch === proposal.branch) throw new GateError(409, `the worker for ${proposal.branch} is still running`)
    }

    if ((await gitBranch(this.repoRoot)) === proposal.branch) {
      const checkout = await gitCheckout(this.repoRoot, this.baseBranch)
      if (!checkout.ok) throw new GateError(409, `could not check out ${this.baseBranch}: ${clip(checkout.stderr)}`)
    }

    if (await gitBranchExists(this.repoRoot, proposal.branch)) {
      const deleted = await gitDeleteBranch(this.repoRoot, proposal.branch)
      if (!deleted.ok) throw new GateError(409, `could not delete ${proposal.branch}: ${clip(deleted.stderr)}`)
    }

    return updateProposal(db, id, { status: "discarded", endedAt: this.now().toISOString() }) ?? proposal
  }

  scheduleRestart(): void {
    const timer = setTimeout(() => {
      try {
        this.restart()
      } catch (error) {
        this.warn(`restart failed: ${errorMessage(error)}`)
      }
    }, RESTART_DELAY_MS)
    timer.unref()
  }

  private async settle(pending: PendingEdit, exit: SelfEditExit): Promise<Proposal | undefined> {
    const switched = await gitCheckout(this.repoRoot, pending.branch)
    const branchError = switched.ok ? undefined : `could not check out ${pending.branch}: ${clip(switched.stderr)}`

    const tests = await this.verify()
    const green = testsGreen(tests)
    const jobError = jobFailure(exit)

    await gitAddAll(this.repoRoot)
    let commitError: string | undefined
    if (await gitHasStagedChanges(this.repoRoot)) {
      const message = `self-edit: ${oneLine(pending.task, MAX_COMMIT_TASK_CHARS)}`
      const suffix = !green ? " (tests red)" : jobError !== undefined ? " (worker failed)" : ""
      const commit = await gitCommit(this.repoRoot, `${message}${suffix}`)
      if (!commit.ok) commitError = `commit failed: ${clip(commit.stderr)}`
    }

    const diffstat = await this.diffstat(pending)
    const error = [branchError, jobError, commitError]
      .filter((part): part is string => part !== undefined && part !== "")
      .join("; ")

    return this.record({
      pending,
      tests,
      summary: this.jobSummary(pending.jobId),
      ...(diffstat !== undefined ? { diffstat } : {}),
      ...(error !== "" ? { error } : {}),
    })
  }

  private async verify(): Promise<ProposalTests> {
    const tests: ProposalTests = {}
    for (let index = 0; index < this.verifyCommands.length; index += 1) {
      const command = this.verifyCommands[index] as string
      const name = VERIFY_SLOTS[index] ?? `step${index}`
      tests[name] = await this.verifyOne(command)
    }
    return tests
  }

  private async verifyOne(command: string): Promise<{ ok: boolean; output?: string }> {
    try {
      const result = await runCommand(command, [], {
        cwd: this.repoRoot,
        shell: true,
        timeoutMs: this.verifyTimeoutMs,
      })
      if (result.ok) return { ok: true }
      const parts = [result.stdout, result.stderr].map((part) => part.trimEnd()).filter((part) => part !== "")
      const detail = parts.join("\n")
      const output = detail === "" ? `exit ${result.code ?? result.signal ?? "unknown"}` : detail
      return { ok: false, output: tailChars(output, MAX_TEST_OUTPUT_CHARS) }
    } catch (error) {
      return { ok: false, output: errorMessage(error) }
    }
  }

  private async diffstat(pending: PendingEdit): Promise<string | undefined> {
    const result = await gitDiffStat(this.repoRoot, pending.base, pending.branch)
    const text = result.stdout.trim()
    return result.ok && text !== "" ? text : undefined
  }

  private jobSummary(jobId: string): string | undefined {
    if (this.agentHome === undefined) return undefined
    try {
      const text = readJobLog(this.agentHome, jobId, { lines: 20 }).text.trim()
      return text === "" ? undefined : tailChars(text, MAX_SUMMARY_CHARS)
    } catch {
      return undefined
    }
  }

  private record(input: {
    pending: PendingEdit
    tests: ProposalTests
    summary?: string
    diffstat?: string
    error?: string
  }): Proposal | undefined {
    const db = this.db
    if (db === undefined) {
      this.warn(`no memory database — proposal ${input.pending.proposalId} was not recorded`)
      return undefined
    }
    try {
      return createProposal(db, {
        id: input.pending.proposalId,
        branch: input.pending.branch,
        base: input.pending.base,
        task: input.pending.task,
        status: "open",
        createdAt: input.pending.createdAt,
        tests: input.tests,
        ...(input.summary !== undefined ? { summary: input.summary } : {}),
        ...(input.diffstat !== undefined ? { diffstat: input.diffstat } : {}),
        ...(input.error !== undefined ? { error: input.error } : {}),
      })
    } catch (error) {
      this.warn(`could not record proposal ${input.pending.proposalId}: ${errorMessage(error)}`)
      return undefined
    }
  }

  private recordFailure(pending: PendingEdit, exit: SelfEditExit, message: string): Proposal | undefined {
    this.warn(`self-edit ${pending.proposalId} failed: ${message}`)
    const jobError = jobFailure(exit)
    return this.record({
      pending,
      tests: {},
      ...(jobError !== undefined ? { error: `${jobError}; ${message}` } : { error: message }),
    })
  }

  private async returnToBase(): Promise<void> {
    const plain = await gitCheckout(this.repoRoot, this.baseBranch)
    if (plain.ok) return
    const forced = await gitCheckout(this.repoRoot, this.baseBranch, { force: true })
    if (!forced.ok) this.warn(`self-edit could not return to ${this.baseBranch}: ${clip(forced.stderr)}`)
  }

  private requireDb(): DatabaseSync {
    if (this.db === undefined) throw new GateError(503, "the memory database is unavailable")
    return this.db
  }

  private requireProposal(id: string): Proposal {
    const db = this.requireDb()
    const proposal = getProposal(db, id)
    if (proposal === undefined) throw new GateError(404, `no such proposal: ${id}`)
    return proposal
  }
}

function jobFailure(exit: SelfEditExit): string | undefined {
  if (typeof exit.signal === "string" && exit.signal !== "") return `worker exited on signal ${exit.signal}`
  if (typeof exit.code === "number" && exit.code !== 0) return `worker exited with code ${exit.code}`
  return undefined
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > max ? flat.slice(0, max) : flat
}

function tailChars(text: string, max: number): string {
  return text.length <= max ? text : text.slice(text.length - max)
}

function clip(text: string, max = 500): string {
  const flat = text.trim()
  return flat.length <= max ? flat : flat.slice(0, max)
}
