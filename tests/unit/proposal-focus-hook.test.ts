import assert from "node:assert/strict"
import type { DatabaseSync } from "node:sqlite"
import { test } from "node:test"
import { openMemoryDb } from "../../src/memory/db.ts"
import { getFocus, upsertFocus } from "../../src/memory/focus.ts"
import type { FocusItem } from "../../src/memory/focus.ts"
import type { Proposal } from "../../src/memory/proposals.ts"
import type { ServerResponse } from "node:http"
import { handleProposalRoutes } from "../../src/server/proposal-routes.ts"
import { syncFocusOnApplied, syncFocusOnClosed } from "../../src/server/proposal-focus-hook.ts"
import type { AppContext } from "../../src/server/routes.ts"

const PROPOSAL_ID = "prop-20261121-abcdef"

function fresh(): DatabaseSync {
  return openMemoryDb(":memory:")
}

function seed(db: DatabaseSync, id: string, evidence: string[]): FocusItem {
  return upsertFocus(db, { id, text: `focus ${id} follows the proposal`, state: "doing", evidence })
}

function read(db: DatabaseSync, id: string): FocusItem {
  const item = getFocus(db, id)
  assert.ok(item !== undefined, `focus ${id} must still exist`)
  return item
}

function fakeResponse(): { response: ServerResponse; statuses: number[]; bodies: string[] } {
  const statuses: number[] = []
  const bodies: string[] = []
  const response = {
    writableEnded: false,
    writeHead(status: number) {
      statuses.push(status)
      return this
    },
    end(body?: string) {
      bodies.push(typeof body === "string" ? body : "")
      this.writableEnded = true
    },
  }
  return { response: response as unknown as ServerResponse, statuses, bodies }
}

function stubContext(selfEdit: unknown, handle: () => DatabaseSync | undefined): AppContext {
  return { selfEdit, memory: { handle } } as unknown as AppContext
}

test("applying a proposal moves its focus to review and appends the merged sha", () => {
  const db = fresh()
  try {
    seed(db, "foc-applied", [`drafted ${PROPOSAL_ID}`, "gate green"])
    syncFocusOnApplied(db, PROPOSAL_ID, "0123456789abcdef0123456789abcdef01234567")
    const item = read(db, "foc-applied")
    assert.equal(item.state, "review")
    assert.deepEqual(item.evidence, [`drafted ${PROPOSAL_ID}`, "gate green", "applied:0123456789ab"])
  } finally {
    db.close()
  }
})

test("applying without a sha degrades to the proposal id instead of inventing one", () => {
  const db = fresh()
  try {
    seed(db, "foc-nosha", [`${PROPOSAL_ID} merged`])
    syncFocusOnApplied(db, PROPOSAL_ID)
    const item = read(db, "foc-nosha")
    assert.equal(item.state, "review")
    assert.deepEqual(item.evidence, [`${PROPOSAL_ID} merged`, `applied:${PROPOSAL_ID}`])
  } finally {
    db.close()
  }
})

test("a failed proposal sends its focus back to open with the failure summary", () => {
  const db = fresh()
  try {
    seed(db, "foc-failed", [`${PROPOSAL_ID} under verification`])
    syncFocusOnClosed(db, PROPOSAL_ID, "failed", "boom: the unit suite went red on the focus ledger")
    const item = read(db, "foc-failed")
    assert.equal(item.state, "open")
    assert.deepEqual(item.evidence, [
      `${PROPOSAL_ID} under verification`,
      "failed:boom: the unit suite went red on the foc",
    ])
    assert.ok((item.evidence ?? []).some((entry) => entry.includes("boom")))
  } finally {
    db.close()
  }
})

test("discarding a proposal sends its focus back to open and tags it discarded", () => {
  const db = fresh()
  try {
    seed(db, "foc-discarded", [`${PROPOSAL_ID} proposed`])
    syncFocusOnClosed(db, PROPOSAL_ID, "discarded", "")
    const item = read(db, "foc-discarded")
    assert.equal(item.state, "open")
    assert.deepEqual(item.evidence, [`${PROPOSAL_ID} proposed`, "discarded"])
  } finally {
    db.close()
  }
})

test("only focus entries whose evidence really names the proposal are touched", () => {
  const db = fresh()
  try {
    seed(db, "foc-other", ["prop-20261121-abcde-other"])
    seed(db, "foc-case", [PROPOSAL_ID.toUpperCase()])
    seed(db, "foc-plain", ["unrelated work"])
    syncFocusOnApplied(db, PROPOSAL_ID, "fedcba9876543210fedcba9876543210fedcba98")
    assert.equal(read(db, "foc-other").state, "doing")
    assert.equal(read(db, "foc-case").state, "doing")
    assert.equal(read(db, "foc-plain").state, "doing")
  } finally {
    db.close()
  }
})

test("the apply route still answers 200 when the focus hook throws", async () => {
  const broken = {
    prepare() {
      throw new Error("db is broken")
    },
  } as unknown as DatabaseSync
  const proposal = { id: PROPOSAL_ID, status: "applied", mergedCommit: "abc123" } as unknown as Proposal
  let restarted = 0
  const { response, statuses, bodies } = fakeResponse()
  const ctx = stubContext(
    {
      apply: async () => proposal,
      scheduleRestart: () => {
        restarted += 1
      },
    },
    () => broken,
  )
  const messages: string[] = []
  const original = console.error
  console.error = (message?: unknown) => {
    messages.push(String(message))
  }
  try {
    await handleProposalRoutes(response, ctx, "POST", ["", "proposals", PROPOSAL_ID, "apply"])
  } finally {
    console.error = original
  }
  assert.deepEqual(statuses, [200])
  assert.deepEqual(JSON.parse(bodies[0] ?? "{}"), { applied: true, restarting: true })
  assert.equal(restarted, 1)
  assert.equal(messages.length, 1)
  assert.ok(messages[0]?.includes("could not sync focus"), messages[0])
})
