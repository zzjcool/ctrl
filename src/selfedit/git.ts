import { spawn } from "node:child_process"

export const DEFAULT_COMMAND_TIMEOUT_MS = 600_000

export interface CommandResult {
  ok: boolean
  code: number | null
  signal: string | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export interface CommandOptions {
  cwd: string
  timeoutMs?: number
  shell?: boolean
  env?: NodeJS.ProcessEnv
}

export function runCommand(command: string, args: string[], opts: CommandOptions): Promise<CommandResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
  return new Promise<CommandResult>((resolve) => {
    let stdout = ""
    let stderr = ""
    let timedOut = false
    let settled = false
    let timer: NodeJS.Timeout | undefined
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, args, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        stdio: ["ignore", "pipe", "pipe"],
        shell: opts.shell === true,
        detached: true,
      })
    } catch (error) {
      resolve({ ok: false, code: null, signal: null, stdout, stderr: errorMessage(error), timedOut })
      return
    }

    const finish = (result: CommandResult): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolve(result)
    }

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true
        killGroup(child.pid)
      }, timeoutMs)
      timer.unref()
    }

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += typeof chunk === "string" ? chunk : chunk.toString("utf8")
    })
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8")
    })
    child.on("error", (error) => {
      finish({ ok: false, code: null, signal: null, stdout, stderr: `${stderr}${errorMessage(error)}`, timedOut })
    })
    child.on("close", (code, signal) => {
      finish({
        ok: !timedOut && code === 0,
        code,
        signal: signal === null ? null : String(signal),
        stdout,
        stderr: timedOut ? `${stderr}\ncommand timed out after ${Math.round(timeoutMs / 1000)}s`.trim() : stderr,
        timedOut,
      })
    })
  })
}

export function git(repo: string, args: string[], opts: { timeoutMs?: number } = {}): Promise<CommandResult> {
  return runCommand("git", args, { cwd: repo, ...opts })
}

export async function gitBranch(repo: string): Promise<string | undefined> {
  const result = await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])
  const name = result.stdout.trim()
  return result.ok && name !== "" ? name : undefined
}

export async function gitStatusPorcelain(repo: string): Promise<CommandResult> {
  return await git(repo, ["status", "--porcelain"])
}

export async function gitBranchExists(repo: string, branch: string): Promise<boolean> {
  const result = await git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])
  return result.ok
}

export async function gitHasStagedChanges(repo: string): Promise<boolean> {
  const result = await git(repo, ["diff", "--cached", "--quiet"])
  return result.code === 1
}

export async function gitCreateBranch(repo: string, branch: string): Promise<CommandResult> {
  return await git(repo, ["checkout", "-b", branch])
}

export async function gitCheckout(repo: string, branch: string, opts: { force?: boolean } = {}): Promise<CommandResult> {
  return await git(repo, opts.force === true ? ["checkout", "-f", branch] : ["checkout", branch])
}

export async function gitAddAll(repo: string): Promise<CommandResult> {
  return await git(repo, ["add", "-A"])
}

export async function gitCommit(repo: string, message: string): Promise<CommandResult> {
  return await git(repo, ["commit", "-m", message, "--no-gpg-sign"])
}

export async function gitDiffStat(repo: string, base: string, branch: string): Promise<CommandResult> {
  return await git(repo, ["diff", `${base}...${branch}`, "--stat"])
}

export async function gitDiff(repo: string, base: string, branch: string): Promise<CommandResult> {
  return await git(repo, ["diff", `${base}...${branch}`])
}

export async function gitDiffNameStatus(repo: string, base: string, branch: string): Promise<CommandResult> {
  return await git(repo, ["diff", "--name-status", `${base}...${branch}`])
}

export async function gitShowFile(repo: string, ref: string, file: string): Promise<CommandResult> {
  return await git(repo, ["show", `${ref}:${file}`])
}

export async function gitRevParse(repo: string, ref: string): Promise<string | undefined> {
  const result = await git(repo, ["rev-parse", ref])
  const sha = result.stdout.trim()
  return result.ok && sha !== "" ? sha : undefined
}

export async function gitMergeNoFf(repo: string, branch: string, message: string): Promise<CommandResult> {
  return await git(repo, ["merge", "--no-ff", branch, "-m", message])
}

export async function gitDeleteBranch(repo: string, branch: string): Promise<CommandResult> {
  return await git(repo, ["branch", "-D", branch])
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function killGroup(pid: number | undefined): void {
  if (pid === undefined) return
  try {
    process.kill(-pid, "SIGKILL")
    return
  } catch {

  }
  try {
    process.kill(pid, "SIGKILL")
  } catch {

  }
}
