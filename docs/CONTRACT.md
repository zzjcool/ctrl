# ctrl contract (v1 — personal scope)

> Single source of truth. Personal tool, one user, one control machine.
> Frozen decisions are marked **§**. Anything not written here is out of scope.

## 0. What ctrl is

A **local control machine** runs ctrl. You chat with an agent on one page. Its
tools (`read_file`, `write_file`, `list_dir`, `bash`, long tasks) execute on a
machine you reach over SSH. The remote needs **only sshd** — no node, no agent,
no runtime. The agent is not told it is remote: same tool names, same output
format, same working-directory semantics.

One line: **the conversation stays here, the hands work there.**

Why personal: the pieces it needs are mine (pi-durable, ssh access to a couple of
boxes). It is not a product and does not compete with OpenHands/Coder/Codex.

## 1. Layers

| Layer | Owner | What it does |
| --- | --- | --- |
| Conversation, memory, compaction, resume | **pi-durable** (dependency) | append-only `events.jsonl`, BM25+ recall, agent loop |
| Tool execution | **ctrl** | 8 tools, two backends: `local`, `ssh` |
| Page | **ctrl** | one chat page, tailing the log |
| herdr / kraal | **out of scope** | optional later backend, not needed now |

## 2. Non-goals (frozen)

- No sync / mirror / write-through. **The remote directory is the working copy.**
- No sandbox/container lifecycle, no snapshots.
- No git integration, no diff viewer, no editor.
- No plugin system, no multi-agent UI, no task scheduler.
- No multi-user, no hosted service, no TLS, no auth beyond loopback.
- No product/business concerns: no telemetry, no onboarding, no installer.
- No Windows.

## 3. Engine dependency

- pi-durable at `~/code/pi-durable` (sibling checkout, pinned `9e6fc89`).
- **Exactly one file imports it**: `src/engine/durable.ts`. Nothing else may.
- pi-durable is never modified. No `exports` map needed while the sibling
  layout holds; moving to a package later is a one-file change.
- The log format is pi-durable's; ctrl adds **no fields**. Machine binding is
  written to a sidecar `<sessionDir>/ctrl.json`, not into events.

## 4. Executor seam (frozen)

```ts
interface Executor {
  readonly kind: "local" | "ssh"
  readonly machine: string            // shown on every tool card
  exec(argv: string[], o?: { cwd?; env?; input?; timeoutMs? }): Promise<ExecResult>
  read(path: string, o?: { cwd?; offset?; limit? }): Promise<string>   // 1-based lines
  write(path: string, data: string, o?: { cwd? }): Promise<void>
  list(path: string, o?: { cwd? }): Promise<string[]>
  spawn(argv: string[], o?: { cwd?; env?; name? }): Promise<{ address: string }>
  readTask(address: string, o?: { lines?: number }): Promise<string>
  stopTask(address: string): Promise<void>
}
type ExecResult = { code: number | null; stdout: string; stderr: string; ms: number; timedOut: boolean; truncated: boolean }
```

### SSH backend rules (frozen)

- Transport: the system `ssh` binary, **one ControlMaster socket per machine**
  (`-M -S <tmp>/ctrl-<host>.sock -N -f`, `ControlPersist=60`). Measured: 1.1 s
  per fresh connection vs ~32 ms multiplexed — never per-call connections.
- `exec`: `ssh -S sock <host> -- sh -c '<single-quoted line>'`. argv is joined
  with POSIX single-quote escaping (`'` → `'\''`). Never interpolate raw paths.
- Always send `sh -c` explicitly: `machine.exec`-style remote shells do not
  exist here; the remote shell is whatever sshd gives us.
- Timeouts: kill the local ssh **and** the remote process group
  (`setsid` on spawn, `kill -TERM -<pgid>` on stop). A dropped ssh connection
  must not leave a build running silently.
- Errors are rewritten before they reach the model: no `ssh:` prefixes, no
  host names, no `Permission denied (publickey)`.
- `read` = `cat`; `write` = `mkdir -p` + `cat > path` with the body on stdin;
  `list` = `ls -1Ap`; binary payloads are rejected, not mangled.

## 5. Workspace (frozen)

- The remote directory **is** the working copy. `read_file`/`write_file`/
  `list_dir`/`bash` all resolve against the session's remote cwd.
- No local mirror. The local disk stores sessions and memory only.
- `~` means the **remote** user's home. Document this in the system prompt.

## 6. Tool set (frozen, 8)

| Tool | Backend call | Notes |
| --- | --- | --- |
| `read_file` | `read` | 20 000 char cap |
| `write_file` | `write` | creates parents |
| `list_dir` | `list` | one level |
| `bash` | `exec(["sh","-c",cmd])` | **hard 10 s cap** — see below |
| `run_task` | `spawn` | long command; returns an address |
| `task_output` | `readTask` / `stopTask` | `{ address, lines?, kill? }` |
| `remember` / `recall` | pi-durable | imported unchanged |

`bash` is hidden unless `--allow-bash`; the other seven are advertised.

**Why `run_task` exists (deviation from pi-durable's set):** pi-durable's loop
hard-caps each tool at **10 s** (`TOOL_TIMEOUT_MS`, not configurable), and the
whole point here is `go build` on a remote box. Long work must therefore be
started and polled, not awaited. `run_task` returns immediately with an address;
`task_output` tails it and can kill it.

## 7. Machine binding (frozen)

- One session = one machine. Chosen at start: `--machine local` or
  `--machine <ssh-host>` (read from `~/.ssh/config`).
- The agent never sees a host name in tool **parameters**. Switching machines =
  a new session (v1). A visible `use_machine` tool is a later revision.
- The one exception is the address `run_task` returns (`hw-nj/<id>`): it is an
  opaque handle the model must echo to `task_output`, not a selector it can
  choose from.
- The page shows the machine in one chip; every tool card carries the same
  machine label, so the human always knows where the side effect landed.

## 8. Sessions and the stream (frozen)

- A turn is started, not awaited: `POST /api/sessions/:id/messages` → `202`,
  then runs in the background (`TurnRegistry`, one turn per session).
- The page tails `GET /api/sessions/:id/events?since=N` (seq is dense, 0-based).
  Closing the tab never stops a turn; reopening replays it.
- `abort` wraps `llm.complete({signal})` — no engine change. A tool already
  running is not interrupted (v1); `run_task` exists precisely for that.
- Resume: pi-durable marks dangling tool calls failed and never replays them.
  ctrl adds `<sessionDir>/ctrl.json` = `{ machine, remoteCwd, createdAt }` so a
  reopened session knows where it was working.

## 9. Page (frozen)

One page, four parts: conversation, composer (with machine chip), session rail,
status strip. Tool calls render inline as cards: name, machine, duration, exit
status, collapsed output. No machine panel, no terminal panel, no dashboard.

The "recovered" badge shows when `resumePoint.kind !== "clean"` **and** the
session has at least one event — a brand-new session reports `empty`, which is
not a recovery.

## 10. HTTP API (frozen)

| Method + path | Behaviour |
| --- | --- |
| `GET /api/health` | `{ status, machine, kind }` |
| `GET /api/machines` | `{ machines: [{ name, kind, current }] }` |
| `GET /api/sessions` | newest 30 + `title` |
| `POST /api/sessions` | `{ cwd?, model? }` → 201 `{ session }` (meta + `machine` + `remoteCwd`) |
| `GET /api/sessions/:id` | `{ session, events, resumePoint, turn }` |
| `GET /api/sessions/:id/events?since=N` | `{ events, total, since, turn }` ← the stream |
| `POST /api/sessions/:id/messages` | `{ text }` → 202; busy → 409 |
| `POST /api/sessions/:id/abort` | `{ aborted }` |
| `GET/POST /api/memory`, `DELETE /api/memory/:id` | pi-durable memory, tombstone semantics |

`turn = { running, startedAt?, error?, aborted? }`.

## 11. Testing

- Unit: SSH quoting/escaping, LocalExecutor, TurnRegistry lock, `since` slicing.
- e2e: fake LLM + local executor — create session → send → events grow → tool
  card data present; 409 on a second concurrent turn; abort path.
- Manual (the only real acceptance): a Go repo on `hw-nj` builds from a sentence
  typed into the page, and the card says `hw-nj · <n>s · exit 0`.

## 12. Decisions (resolved)

| # | Decision | Value |
| --- | --- | --- |
| D1 | transport | SSH (system binary, ControlMaster); herdr later, optional |
| D2 | workspace | remote is the truth; no sync |
| D3 | machine | one per session, `--machine`, transparent to the model |
| D4 | long tasks | `run_task` + `task_output` (10 s loop cap) |
| D5 | engine | pi-durable, one import file, no modifications |
| D6 | UI | one page, no panels |
| D7 | model | `workbuddy/deepseek-v4.1-flash`, `reasoning_effort: max`, 8192 completion cap; `--model` / `--reasoning-effort` override, `PI_DURABLE_MODEL` still wins over the default |

## 13. Revisions

- **R1** — naming; repo created.
- **R2** — product surface = one conversation page; milestones page-first.
- **R3** — personal scope, remote-as-workdir, SSH-only, tool set narrowed to
  pi-durable's plus the long-task pair. Product/competitive framing dropped.
- **R4** — v1 implemented and verified (`typecheck`, 52 unit, 10 e2e, live SSH
  against `hw-nj`). Accepted during implementation:
  1. `Executor.readTask` returns a string, so the exit code is appended by the
     executor as `[exit N]` (an explicit marker separates it from output).
  2. `POST /api/sessions` answers the same shape as a session detail, because
     the sidecar fields are needed by the page immediately.
  3. A session that cannot even construct an LLM client records one
     `error` event (`LLM unavailable: …`); other failures stay in the turn
     registry so the log never gets two errors for one cause.
  4. `abort` stops the model call, not a tool already executing; long work is
     `run_task`, and `task_output { kill: true }` is how it is stopped.
- **R5** — default model is `workbuddy/deepseek-v4.1-flash` with
  `reasoning_effort: max` and an 8192 completion cap. pi-durable gained two
  additive client options (`reasoningEffort`, `maxTokens`) for this; ctrl still
  talks to the engine through `src/engine/durable.ts` only. Reason for the cap:
  reasoning tokens are billed inside `max_tokens`, and 2048 truncates tool calls.
