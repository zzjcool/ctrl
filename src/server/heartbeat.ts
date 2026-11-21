import { formatElapsed } from "../jobs/tools.ts"

export const HEARTBEAT_PREFIX = "[ctrl] heartbeat"

export const HEARTBEAT_COUNTER_PREFIX = "heartbeat"

export const HEARTBEAT_FOCUS_LINES = 5

export const DEFAULT_HEARTBEAT_IDLE_MINUTES = 60
export const DEFAULT_HEARTBEAT_TOKEN_BUDGET = 150_000
export const DEFAULT_HEARTBEAT_MAX_PER_DAY = 4
export const DEFAULT_HEARTBEAT_TICK_MS = 60_000

export const HEARTBEAT_INSTRUCTION =
  "Decide whether to move one of these forward right now. If none of it is worth doing, say so in one sentence and end the turn — do not spin."

export const PROPOSAL_DECISION_INSTRUCTION =
  "Every proposal listed above must get a decision this turn — apply or discard with a one-line reason. Leaving them open is not an option."

export const PROPOSAL_BLOCKING_MS = 24 * 60 * 60 * 1000

export const STALE_FOCUS_INSTRUCTION = "以下 focus 已超过 3 天没有新证据，本轮必须逐条决策："

export const STALE_FOCUS_OPTIONS = "  继续（说明下一步）/ 合并到哪一条 / dropped（必须给 reason）"

export interface ProposalSummary {
  id: string
  ageMs: number
  diffstat: string
  blocking: boolean
}

export function proposalSummary(
  proposal: { id: string; createdAt: string; diffstat?: string },
  now: number,
): ProposalSummary {
  const createdAt = Date.parse(proposal.createdAt)
  const ageMs = Number.isFinite(createdAt) ? Math.max(0, now - createdAt) : 0
  const diffstat = proposal.diffstat === undefined ? "" : oneLine(proposal.diffstat)
  return {
    id: proposal.id,
    ageMs,
    diffstat: diffstat === "" ? "no diffstat" : diffstat,
    blocking: ageMs > PROPOSAL_BLOCKING_MS,
  }
}

export interface HeartbeatDeps {
  now: () => number
  usageToday: () => { tokens: number }
  openFocus: () => number
  focusTexts?: () => string[]
  staleFocusTexts?: () => string[]
  openProposals: () => ProposalSummary[]
  lastEventAt: () => string | undefined
  turnRunning: () => boolean
  start: (text: string) => void
  readCounter: (date: string) => number
  writeCounter: (date: string, count: number) => void
}

export interface HeartbeatOptions {
  idleMinutes?: number
  dailyTokenBudget?: number
  maxPerDay?: number
  tickMs?: number
}

export interface Heartbeat {
  readonly idleMinutes: number
  readonly dailyTokenBudget: number
  readonly maxPerDay: number
  tick(): boolean
  stop(): void
}

export function heartbeatCounterKey(date: string): string {
  return `${HEARTBEAT_COUNTER_PREFIX}:${date}`
}

export function heartbeatDate(at: number): string {
  const when = new Date(at)
  const month = String(when.getMonth() + 1).padStart(2, "0")
  const day = String(when.getDate()).padStart(2, "0")
  return `${when.getFullYear()}-${month}-${day}`
}

export function heartbeatText(input: {
  idleMs: number
  openFocus: number
  focus: string[]
  staleFocus?: string[]
  openProposals: ProposalSummary[]
}): string {
  const lines = [`${HEARTBEAT_PREFIX} — idle ${formatElapsed(input.idleMs)}.`]
  const proposals = [
    ...input.openProposals.filter((proposal) => proposal.blocking),
    ...input.openProposals.filter((proposal) => !proposal.blocking),
  ]
  if (proposals.length > 0) {
    lines.push(`proposals waiting for approval (${proposals.length}):`)
    for (const proposal of proposals) {
      const mark = proposal.blocking ? " [blocking]" : ""
      lines.push(`- ${proposal.id} (${formatElapsed(proposal.ageMs)} old, ${proposal.diffstat})${mark}`)
    }
  }
  const focus = input.focus.slice(0, HEARTBEAT_FOCUS_LINES)
  if (focus.length > 0) {
    lines.push(`open focus (${input.openFocus}):`)
    for (const text of focus) lines.push(`- ${oneLine(text)}`)
  } else if (input.openFocus > 0) {
    lines.push(`open focus: ${input.openFocus} item(s).`)
  }
  const stale = (input.staleFocus ?? []).map(oneLine).filter((line) => line !== "")
  if (stale.length > 0) {
    lines.push(STALE_FOCUS_INSTRUCTION)
    for (const line of stale) {
      lines.push(line)
      lines.push(STALE_FOCUS_OPTIONS)
    }
  }
  lines.push(HEARTBEAT_INSTRUCTION)
  if (proposals.length > 0) lines.push(PROPOSAL_DECISION_INSTRUCTION)
  return lines.join("\n")
}

export function createHeartbeat(deps: HeartbeatDeps, opts: HeartbeatOptions = {}): Heartbeat {
  const idleMinutes = number(opts.idleMinutes, DEFAULT_HEARTBEAT_IDLE_MINUTES)
  const dailyTokenBudget = number(opts.dailyTokenBudget, DEFAULT_HEARTBEAT_TOKEN_BUDGET)
  const maxPerDay = Math.trunc(number(opts.maxPerDay, DEFAULT_HEARTBEAT_MAX_PER_DAY))
  const tickMs = Math.trunc(number(opts.tickMs, DEFAULT_HEARTBEAT_TICK_MS))
  const enabled = idleMinutes > 0 && maxPerDay > 0
  let timer: ReturnType<typeof setInterval> | undefined
  let stopped = false

  const tick = (): boolean => {
    if (stopped || !enabled) return false
    try {
      if (deps.turnRunning()) return false
      const now = deps.now()
      const last = lastEventMs(deps)
      if (last === undefined) return false
      const idleMs = now - last
      if (idleMs < idleMinutes * 60_000) return false
      const openFocus = deps.openFocus()
      const proposals = deps.openProposals()
      if (openFocus <= 0 && proposals.length === 0) return false
      if (deps.usageToday().tokens >= dailyTokenBudget) return false
      const date = heartbeatDate(now)
      const used = deps.readCounter(date)
      if (used >= maxPerDay) return false
      const text = heartbeatText({
        idleMs,
        openFocus,
        focus: deps.focusTexts === undefined ? [] : deps.focusTexts(),
        staleFocus: deps.staleFocusTexts === undefined ? [] : deps.staleFocusTexts(),
        openProposals: proposals,
      })
      deps.writeCounter(date, used + 1)
      try {
        deps.start(text)
      } catch (error) {
        deps.writeCounter(date, used)
        warn(`heartbeat turn did not start: ${errorMessage(error)}`)
        return false
      }
      return true
    } catch (error) {
      warn(`heartbeat skipped: ${errorMessage(error)}`)
      return false
    }
  }

  if (enabled && tickMs > 0) {
    timer = setInterval(() => {
      tick()
    }, tickMs)
    timer.unref?.()
  }

  return {
    idleMinutes,
    dailyTokenBudget,
    maxPerDay,
    tick,
    stop() {
      stopped = true
      if (timer === undefined) return
      clearInterval(timer)
      timer = undefined
    },
  }
}

function lastEventMs(deps: HeartbeatDeps): number | undefined {
  const raw = deps.lastEventAt()
  if (raw === undefined) return undefined
  const at = Date.parse(raw)
  return Number.isFinite(at) ? at : undefined
}

function number(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 200)
}

function warn(message: string): void {
  process.stderr.write(`ctrl: ${message}\n`)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
