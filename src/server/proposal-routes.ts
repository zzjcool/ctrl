import type { ServerResponse } from "node:http"
import { errorMessage } from "../memory/events.ts"
import { GateError } from "../selfedit/gate.ts"
import { HttpError, sendJson } from "./http.ts"
import { syncFocusOnApplied, syncFocusOnClosed } from "../memory/proposal-focus.ts"
import { methodNotAllowed, notFound } from "./routes.ts"
import type { AppContext } from "./routes.ts"

export function isProposalPath(_pathname: string, segments: string[]): boolean {
  return segments[1] === "proposals"
}

export async function handleProposalRoutes(
  response: ServerResponse,
  ctx: AppContext,
  method: string,
  segments: string[],
): Promise<void> {
  const id = segments[2]
  const action = segments[3]
  if (segments[4] !== undefined) {
    notFound(response)
    return
  }

  if (id === undefined) {
    if (method !== "GET") {
      methodNotAllowed(response, method)
      return
    }
    sendJson(response, 200, { proposals: ctx.selfEdit.list() })
    return
  }

  if (action === undefined) {
    if (method !== "GET") {
      methodNotAllowed(response, method)
      return
    }
    const detail = await guard(() => ctx.selfEdit.detail(id))
    sendJson(response, 200, { proposal: detail.proposal, diff: detail.diff })
    return
  }

  if (method !== "POST") {
    methodNotAllowed(response, method)
    return
  }

  if (action === "apply") {
    const proposal = await guard(() => ctx.selfEdit.apply(id))
    try {
      syncFocusOnApplied(ctx.memory.handle(), proposal.id, proposal.mergedCommit)
    } catch (error) {
      console.error(`could not sync focus for applied proposal ${proposal.id}: ${errorMessage(error)}`)
    }
    sendJson(response, 200, { applied: true, restarting: true })
    ctx.selfEdit.scheduleRestart()
    return
  }

  if (action === "discard") {
    const proposal = await guard(() => ctx.selfEdit.discard(id))
    try {
      syncFocusOnClosed(ctx.memory.handle(), proposal.id, "discarded", proposal.summary ?? proposal.error ?? "")
    } catch (error) {
      console.error(`could not sync focus for discarded proposal ${proposal.id}: ${errorMessage(error)}`)
    }
    sendJson(response, 200, { discarded: true, proposal })
    return
  }

  notFound(response)
}

async function guard<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof GateError) throw new HttpError(error.status, error.message)
    throw error
  }
}
