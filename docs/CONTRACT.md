# ctrl contract (v3 — a conversation that hires pi)

> Personal tool, one user. One named agent, one append-only log, long-term
> memory — and it does not touch code itself: it delegates to pi workers.

## 0. What ctrl is

You start ctrl with a name. That name is an agent that persists: one log, one
memory, one working directory. You talk to it forever; it remembers.

It has **no hands**. Asked to do work, it hires a `pi` process to do it
(`delegate`), then reports what came back. ctrl edits nothing and runs nothing
itself — that is the whole point of the split: the durable mind stays here, the
disposable muscle runs in a worker.

**An agent is a directory.** Delete the directory, the agent is gone. Create a
new name, you get a new agent with its own log and its own memory.

## 1. Layers

| Layer | Owner | What it does |
| --- | --- | --- |
| Log, memory, compaction, resume | **pi-durable** (dependency) | append-only `events.jsonl`, BM25+ recall, agent loop |
| Workers | **pi** (child process) | the actual read/bash/edit/grep work |
| Tools | **ctrl** | `delegate` / `job_status` / `job_stop` |
| Page | **ctrl** | one timeline, tailing the log |
| herdr | **out of scope** | optional later backend |

## 2. Non-goals (frozen)

- **No conversation/session concept in the product.** One agent = one log.
- No agent switching or roster in the page; the process serves one agent.
- **No machines, local or remote.** ctrl has no executor of its own; the
  `local`/`ssh` executors are deleted. If remote work comes back, it comes back
  as a pi worker running somewhere else, not as a ctrl tool.
- **ctrl never executes.** No `read_file`, no `bash`, no `edit`, no ssh, no
  machine concept. Everything that touches a file happens inside a pi worker.
- No job queue/scheduler beyond a concurrency cap; no retries, no priorities.
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
  sessions/main/ctrl.json        { cwd, createdAt }
<root>/trash/<name>-<stamp>/     `ctrl agent rm <name>` moves the directory here
```

- `<name>` matches `^[a-z0-9][a-z0-9_-]{0,31}$`.
- The internal log id is always `main`; there is exactly one.
- `ctrl agent rm` archives (moves to `trash/`); `--purge` deletes for real.
- A new name = a new directory = a new agent with no memory and no log.

## 5. Tools (frozen, 5)

| Tool | Behaviour |
| --- | --- |
| `delegate` | `{ task, cwd?, model?, thinking?, wait? }` → starts a detached `pi -p` worker; waits up to `wait` (default 8 s) and returns the finished job if it is done, otherwise `started job <id>` |
| `job_status` | `{ id?, lines?, full?, wait? }` → state, elapsed, exit code, tail of the worker's output; waits up to 8 s for a running job; no `id` lists every job |
| `job_stop` | `{ id }` → SIGTERM the worker's process group |
| `remember` / `recall` | pi-durable, unchanged |

Both `delegate` and `job_status` **wait up to 8 s** — under the engine's 10 s
tool cap — and return as soon as the worker exits. Without that, a model polls
once per step and burns its whole budget on a 40 s job (observed: 11 steps of
`job_status` and no answer). The model still summarises; it never pastes a log.

## 5.1 A worker job on disk (frozen)

```
<agent>/jobs/<id>/
  meta.json    { id, task, cwd, model, thinking, startedAt, pid, exitedAt?, code? }
  out.log      stdout+stderr of the worker (append-only while running)
  pi/          the worker's own pi session dir (so it can be resumed by hand)
```

- Command: `pi -p <task> --provider <p> --model <m> --thinking <t>
  --session-dir <job>/pi --session-id <id>` run with cwd = the task's cwd.
- At most **3** workers run at once; `delegate` past the cap returns an error
  telling the model to wait.
- A job survives a ctrl restart: state is read from disk, never from memory.

## 6. Model (frozen)

- Default `workbuddy/deepseek-v4.1-flash`, `reasoning_effort: max`, 8192
  completion cap. `--model` / `--reasoning-effort` override; `PI_DURABLE_MODEL`
  beats the built-in default.
- The model is chosen when the log is created and recorded in `session_created`.
- The system prompt names the agent and states what it is:
  `You are <name>, a persistent agent with long-term memory. You do not edit
  files or run commands yourself: delegate work to a pi worker with the
  delegate tool, then report what it did. The log is your memory; there is no
  conversation. Your workspace is <cwd>.`

## 7. HTTP API (frozen)

| Method + path | Behaviour |
| --- | --- |
| `GET /api/health` | `{ status, agent }` |
| `GET /api/agent` | `{ agent, session, resumePoint, turn }` |
| `GET /api/agent/events?since=N` | `{ events, total, since, turn }` — the stream |
| `GET /api/agent/events?tail=T` | last T events; `since` = seq of the first one |
| `GET /api/agent/events?before=S&tail=T` | the T events before seq `S` (paging up) |
| `POST /api/agent/messages` | `{ text }` → 202; a turn already running → 409 |
| `POST /api/agent/abort` | `{ aborted }` |
| `GET /api/jobs` | `{ jobs: [{ id, state, task, startedAt, elapsedMs, code? }] }` (page polling) |
| `GET/POST /api/memory`, `DELETE /api/memory/:id` | pi-durable memory, tombstones |

`turn = { running, startedAt?, error?, aborted? }`.
Event responses cap at 200 per call; the page pages upward with `before`.

## 8. The turn loop (frozen)

- `POST /messages` validates, claims the single turn slot, answers `202`, and
  runs in the background. Closing the tab never stops it.
- `abort` wraps `llm.complete({signal})`; a tool already executing is not
  interrupted — long work is `run_task`, stopped with `task_output {kill:true}`.
- Resume: pi-durable marks dangling tool calls failed and never replays them.
  `ctrl.json` remembers the workspace the agent was using.

## 9. Page (frozen)

One screen, no navigation, no rail:

- **head**: the agent's name (it is a name, not a title), status strip with
  event count, last activity, running-worker count, and a quiet "recovered"
  note when `resumePoint.kind !== "clean"` and there is history.
- **timeline**: one continuous column with timestamps and date separators. Your
  lines are marked `›`; the agent's prose and tool cards follow in the same
  column. No left/right chat bubbles. A `delegate` card shows the task text,
  the worker's state and its output — and keeps updating after the turn ends
  (the page polls `/api/jobs`).
- **load earlier**: a button at the top when more history exists (`before=`).
- **composer**: textarea + send/stop. Nothing else.

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
| D8 | machine | gone: ctrl has no machine; workers run locally |
| D10 | who works | ctrl talks, pi works; ctrl never edits or runs |
| D9 | delete | `ctrl agent rm` archives to `trash/`; `--purge` removes |

## 11. Revisions

- **R1** — naming; repo created.
- **R2** — product surface = one conversation page.
- **R3** — personal scope, remote-as-workdir, SSH-only.
- **R4** — v1 accepted deviations (exit marker, response shapes, abort scope).
- **R5** — default model deepseek-v4.1-flash, reasoning max, 8192 cap.
- **R8** — ctrl stops doing work: the execution tools and the ssh/local
  executors are removed; a `delegate` tool starts `pi -p` workers and polls
  them. `--machine` and `/api/machines` disappear with them.
- **R7** — remote execution is parked: the ssh backend remains in the tree but
  is unreachable from the CLI, and the page runs one local agent.
- **R6** — the conversation concept is removed: one named agent, one log, one
  memory; agent = directory; delete = archive; no in-page agent or machine
  switching. Sessions API replaced by `/api/agent/*`.
