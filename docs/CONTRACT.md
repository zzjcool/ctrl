# ctrl contract (v2 — one named agent)

> Personal tool, one user. v2 removes the conversation concept entirely:
> there is **one named agent** whose whole life is a single append-only log.

## 0. What ctrl is

You start ctrl with a name. That name is an agent that persists: one log, one
memory, one working directory, one machine its hands are on. The page is that
agent across the table — no conversations, no threads, no "new chat".

**An agent is a directory.** Delete the directory, the agent is gone. Create a
new name, you get a new agent with its own log and its own memory.

## 1. Layers

| Layer | Owner | What it does |
| --- | --- | --- |
| Log, memory, compaction, resume | **pi-durable** (dependency) | append-only `events.jsonl`, BM25+ recall, agent loop |
| Tools | **ctrl** | 8 tools over `local` or `ssh` |
| Page | **ctrl** | one timeline, tailing the log |
| herdr | **out of scope** | optional later backend |

## 2. Non-goals (frozen)

- **No conversation/session concept in the product.** One agent = one log.
- No agent switching or roster in the page; the process serves one agent.
- **No machine switching (v1).** `--machine` is fixed at start; switching was
  cut on purpose and comes back later, if ever.
- No sync/mirror: the remote directory is the working copy.
- No sandbox lifecycle, git integration, diff viewer, editor, plugins,
  multi-agent UI, multi-user, TLS, product concerns, Windows.

## 3. Engine dependency

- pi-durable at `~/code/pi-durable` (sibling checkout). **One file** imports it:
  `src/engine/durable.ts`.
- pi-durable is never forked. Two additive client options (`reasoningEffort`,
  `maxTokens`) were added upstream for model control; nothing else is touched.
- The event format is pi-durable's; ctrl adds no fields. Machine/agent metadata
  lives in files next to the log.

## 4. An agent on disk (frozen)

```
<root>/agents/<name>/            root defaults to ~/.ctrl
  agent.json                     { name, model, createdAt }
  memory/index.jsonl             pi-durable memory (per agent — a new agent starts blank)
  sessions/main/events.jsonl     the single log
  sessions/main/meta.json        pi-durable cache
  sessions/main/ctrl.json        { machine, cwd, createdAt }
<root>/trash/<name>-<stamp>/     `ctrl agent rm <name>` moves the directory here
```

- `<name>` matches `^[a-z0-9][a-z0-9_-]{0,31}$`.
- The internal log id is always `main`; there is exactly one.
- `ctrl agent rm` archives (moves to `trash/`); `--purge` deletes for real.
- A new name = a new directory = a new agent with no memory and no log.

## 5. Tools (frozen, 8)

Unchanged from v1: `read_file`, `write_file`, `list_dir`, `bash` (hidden unless
`--allow-bash`), `run_task`, `task_output`, plus pi-durable's `remember` /
`recall`. `run_task` exists because the engine caps every tool call at 10 s.

## 6. Model (frozen)

- Default `workbuddy/deepseek-v4.1-flash`, `reasoning_effort: max`, 8192
  completion cap. `--model` / `--reasoning-effort` override; `PI_DURABLE_MODEL`
  beats the built-in default.
- The model is chosen when the log is created and recorded in `session_created`.
- The system prompt names the agent and states where its hands are:
  `You are <name>, a persistent agent. Your tools run on <machine>, working
  directory <cwd>. The log is your memory; there is no conversation.`

## 7. HTTP API (frozen)

| Method + path | Behaviour |
| --- | --- |
| `GET /api/health` | `{ status, agent, machine, kind }` |
| `GET /api/agent` | `{ agent, session, resumePoint, turn, machine }` |
| `GET /api/agent/events?since=N` | `{ events, total, since, turn }` — the stream |
| `GET /api/agent/events?tail=T` | last T events; `since` = seq of the first one |
| `GET /api/agent/events?before=S&tail=T` | the T events before seq `S` (paging up) |
| `POST /api/agent/messages` | `{ text }` → 202; a turn already running → 409 |
| `POST /api/agent/abort` | `{ aborted }` |
| `GET /api/machines` | `{ machines: [{ name, kind, current }] }` (informational) |
| `GET/POST /api/memory`, `DELETE /api/memory/:id` | pi-durable memory, tombstones |

`turn = { running, startedAt?, error?, aborted? }`.
Event responses cap at 200 per call; the page pages upward with `before`.

## 8. The turn loop (frozen)

- `POST /messages` validates, claims the single turn slot, answers `202`, and
  runs in the background. Closing the tab never stops it.
- `abort` wraps `llm.complete({signal})`; a tool already executing is not
  interrupted — long work is `run_task`, stopped with `task_output {kill:true}`.
- Resume: pi-durable marks dangling tool calls failed and never replays them.
  `ctrl.json` remembers the machine and cwd the agent was using.

## 9. Page (frozen)

One screen, no navigation, no rail:

- **head**: the agent's name (it is a name, not a title), status strip with
  machine, event count, last activity, and a quiet "recovered" note when
  `resumePoint.kind !== "clean"` and there is history.
- **timeline**: one continuous column with timestamps and date separators. Your
  lines are marked `›` and set in a slightly louder weight; the agent's prose
  and tool cards follow in the same column. No left/right chat bubbles.
- **load earlier**: a button at the top when more history exists (`before=`).
- **composer**: textarea + send/stop. The machine is a read-only label.

## 10. Decisions (resolved)

| # | Decision | Value |
| --- | --- | --- |
| D1 | transport | system `ssh` + ControlMaster; herdr later, optional |
| D2 | workspace | remote is the truth; no sync |
| D3 | identity | a named agent = a directory; no conversations |
| D4 | long tasks | `run_task` + `task_output` (10 s loop cap) |
| D5 | engine | pi-durable, one import file, additive changes only |
| D6 | UI | one timeline, no panels, no rail |
| D7 | model | deepseek-v4.1-flash, effort max, 8192 cap |
| D8 | machine | fixed at start, no switching in v1 |
| D9 | delete | `ctrl agent rm` archives to `trash/`; `--purge` removes |

## 11. Revisions

- **R1** — naming; repo created.
- **R2** — product surface = one conversation page.
- **R3** — personal scope, remote-as-workdir, SSH-only.
- **R4** — v1 accepted deviations (exit marker, response shapes, abort scope).
- **R5** — default model deepseek-v4.1-flash, reasoning max, 8192 cap.
- **R6** — the conversation concept is removed: one named agent, one log, one
  memory; agent = directory; delete = archive; no in-page agent or machine
  switching. Sessions API replaced by `/api/agent/*`.
