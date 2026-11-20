import type { DatabaseSync } from "node:sqlite"
import type { DreamBatch } from "./dream.ts"
import { extractJsonObject } from "./dream.ts"
import { clipChars, isRecord } from "./events.ts"
import { LESSON_KIND, addMemory } from "./memories.ts"

export const RETRO_MAX_TOKENS = 800
export const RETRO_MAX_LESSONS = 3
export const RETRO_MAX_LESSON_CHARS = 300
export const RETRO_DEFAULT_CONFIDENCE = 0.5

export const RETRO_SCOPES = ["delegate", "memory", "search", "code", "other"] as const
export type RetroScope = (typeof RETRO_SCOPES)[number]

export interface RetroLesson {
  text: string
  scope: RetroScope
  confidence: number
}

export interface RetroWriteResult {
  created: number
  merged: number
}

export const RETRO_INSTRUCTIONS =
  "You review one batch of an agent's recent events and extract durable lessons for the next run. " +
  "Reply with ONE JSON object and nothing else — no prose, no code fence:\n" +
  '{"lessons":[{"text":"...","scope":"delegate|memory|search|code|other","confidence":0.0}]}\n' +
  "Rules:\n" +
  "- A lesson is something to do differently next time: a mistake that keeps repeating, a command or way of " +
  "working that turned out to be effective, a shorter path someone missed. Write it as an instruction, in the " +
  "language the events are written in.\n" +
  "- Do not narrate what happened, do not summarise the batch, do not restate a plain fact.\n" +
  "- At most 3 lessons, each at most 300 characters. Drop anything you are not sure about.\n" +
  '- Reply {"lessons":[]} when nothing qualifies.'

export function buildRetroPrompt(batch: DreamBatch): string {
  const transcript = batch.events
    .filter((event) => event.text !== "")
    .map((event) => `[seq ${event.seq}] ${event.role}: ${event.text.replace(/\s+/g, " ").trim()}`)
    .join("\n")
  return (
    `${RETRO_INSTRUCTIONS}\n\n` +
    `Events (seq ${batch.fromSeq}..${batch.toSeq}):\n${transcript === "" ? "(no prose, only markers)" : transcript}`
  )
}

export function cleanRetroScope(value: unknown): RetroScope {
  if (typeof value !== "string") return "other"
  const scope = value.trim().toLowerCase()
  return (RETRO_SCOPES as readonly string[]).includes(scope) ? (scope as RetroScope) : "other"
}

export function cleanConfidence(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return RETRO_DEFAULT_CONFIDENCE
  return Math.max(0, Math.min(1, value))
}

export function parseRetroPayload(text: string): RetroLesson[] {
  const json = extractJsonObject(text)
  if (json === undefined) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return []
  }
  if (!isRecord(parsed)) return []
  const lessons: RetroLesson[] = []
  for (const draft of Array.isArray(parsed.lessons) ? parsed.lessons : []) {
    if (lessons.length >= RETRO_MAX_LESSONS) break
    if (!isRecord(draft)) continue
    const body = typeof draft.text === "string" ? draft.text.trim() : ""
    if (body === "") continue
    lessons.push({
      text: clipChars(body, RETRO_MAX_LESSON_CHARS),
      scope: cleanRetroScope(draft.scope),
      confidence: cleanConfidence(draft.confidence),
    })
  }
  return lessons
}

export function applyLessons(
  db: DatabaseSync,
  lessons: RetroLesson[],
  opts: { sourceSeqs: number[]; now: Date },
): RetroWriteResult {
  const written: RetroWriteResult = { created: 0, merged: 0 }
  for (const lesson of lessons) {
    const result = addMemory(db, {
      text: lesson.text,
      kind: LESSON_KIND,
      tags: [LESSON_KIND, lesson.scope],
      importance: lesson.confidence,
      sourceSeqs: opts.sourceSeqs,
      now: opts.now,
    })
    if (result.created) written.created += 1
    else written.merged += 1
  }
  return written
}
