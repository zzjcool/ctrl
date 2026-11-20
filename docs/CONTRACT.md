# ctrl contract (draft v0)

> Single source of truth. Decisions marked 🔴 are **not frozen** — they need an
> owner decision before code that depends on them is written.
> English is used here to match pi-durable; README stays Chinese.

---

## 0. What ctrl is (frozen)

ctrl is a **durable agent console**: a persistent conversation (log + memory +
compaction) owned by the local machine, whose tools execute on machines reached
through **herdr core**.

Three planes:

| Plane | Lives where | Owner |
| --- | --- | --- |
| Conversation | local disk (`~/.pi-durable`) | pi-durable (dependency) |
| Execution | remote machines | herdr core (JSON-RPC) |
| Scheduling | local process | ctrl |

One sentence: **the line stays here, the work goes there.**

## 1. Layer ownership (frozen)

| Layer | Product | Responsibility |
| --- | --- | --- |
| Machines, terminals, exec, files, events | **herdr core** (`hc`) | the only thing installed remotely (auto-copied by `hc machine add --install`) |
| Human window into herdr | **kraal** | Swift client; out of scope here |
| Conversation, memory, dispatch, web console | **ctrl** | this repo |
| Log, recall, agent loop, compaction | **pi-durable** | imported, not forked (§3) |

ctrl is **not** a sandbox runtime. Isolation is whatever herdr offers: a
machine, a container on that machine, or `machine.add --temp`. ctrl never
manages VM/container lifecycles in v1.

## 2. Non-goals for v1 (frozen)

- No multi-user, no hosted service, no auth beyond loopback/token.
- No plugin system (that is the pi-durable discussion, parked for v2).
- No multi-agent orchestration UI (v1 runs commands; §9 is the v2 door).
- No two-way merge of the local/remote workspace (§5 is one-way write-through).
- No diff viewer, no editor, no file tree mutations in the web UI.
- No embeddings; recall is pi-durable's BM25+.
- No Windows support.

## 3. Code layout and dependency (D0 🔴)

ctrl is its own repo and **never forks pi-durable**:

- Reuse: `runAgent`, session store (`createSession` / `openSession` /
  `continueRecentSession`), memory store, paths, LLM client, event types.
- **ctrl owns its tool layer.** pi-durable's v1 contract freezes its tool set
  (§7 there), and remote tools are product semantics, not engine semantics.
  ctrl implements `ToolSpec` (`{name, description, parameters, execute(args, ctx)}`)
  and passes its own array to `runAgent({ tools })`.
- Consequence: ctrl must track pi-durable's `ToolResult`/`ToolContext` shape
  (both are tiny and stable), and pi-durable needs no revision for ctrl to exist.

Dependency mechanics 🔴 — pick one:

| Option | Shape | Cost |
| --- | --- | --- |
| **A** sibling checkout + `file:` dep | `~/code/pi-durable`, `"pi-durable": "file:../pi-durable"`, plus an `exports` map in pi-durable's package.json | one small pi-durable change; `npm install` links it |
| **B** git submodule | `ctrl/vendor/pi-durable` | pinned, but submodule ergonomics |
| **C** relative import | `import ... from "../../pi-durable/src/core/agent.ts"` | zero setup, breaks on `npm pack`, hides the real dependency |

Recommendation: **A**. It is the only option that keeps `npm ci` honest and
lets a future worker run the repo without knowing where pi-durable lives.

## 4. Execution backend (D1, frozen except transport edge cases)

```ts
interface Executor {
  exec(argv: string[], o?: { cwd?: string; env?: Record<string,string>; input?: string; timeoutSec?: number })
    : Promise<{ code: number | null; stdout: string; stderr: string; ms: number; timedOut: boolean; truncated: boolean }>
  read(path: string, o?: { offset?: number; limit?: number }): Promise<string>
  write(path: string, data: string): Promise<void>
  list(path: string): Promise<string[]>
  spawn(argv: string[], o: { cwd?: string; env?: Record<string,string>; name?: string })
    : Promise<{ terminal: string }>            // herdr address, e.g. "hw-nj/t7"
}
```

Transport: spawn `hc connect`, speak JSON-RPC 2.0, one JSON object per line
(the protocol's `hello` may switch to framed mode; ctrl asks for line mode).
Handshake once at startup; reconnect with backoff; every request carries a
monotonic id and a deadline.

Mapping:

| Executor | herdr method | Hard limits to respect |
| --- | --- | --- |
| `exec` | `machine.exec` | timeout ≤ **600 s**, stdin ≤ 8 MB raw (base64), stdout/stderr come back base64 |
| `read` | `file.read` | ≤ 8 MB, offset/limit are **lines** |
| `write` | `file.write` | ≤ 8 MB raw per call (base64); no mode bits — `chmod` via `exec` |
| `list` | `machine.exec` (`ls -1`) | no dedicated method |
| `spawn` | `terminal.run` | returns an address; then `terminal.wait` / `read` / `send` / `interrupt` |

Errors carry `data.kind` — surface as `ToolResult { ok: false, output }`, never
throw through the agent loop.

## 5. Workspace model (D2 🔴, D3)

Principle: **local disk is the source of truth**; the remote tree is a build
mirror that ctrl owns.

- **Write-through**: every `write` goes local first, then `file.write` remote.
- **Delta push**: before a command runs, ctrl diffs a manifest
  (`path → size, mtime, xxh/sha`) against the last pushed state and sends only
  what changed. First contact sends a `tar` through `machine.exec` stdin in
  ≤6 MB chunks, `<pack>` then `tar -xzf`.
- **Lazy pull**: `read`/`list` hit local first; on miss, `file.read` remote and
  cache. This is how remote-generated files (`go.sum`, generated code) become
  visible without a full sync-back.
- **Exclusions**: `.git/`, `node_modules/`, build caches by default; configurable.

Remote root 🔴 — options:

| Option | Path | Trade-off |
| --- | --- | --- |
| A | `<remoteRoot>/.ctrl/<sessionId>/` | isolation by construction; duplicates the tree per session |
| B | `<remoteRoot>/` shared, `git worktree` per session | cheap, but needs git and a clean base repo |
| C | user-supplied absolute path per session | simplest, no isolation |

Recommendation: **A** for v1 (correctness over disk), revisit when repos get big.

## 6. Durable sessions and resume (D5)

- Reuse pi-durable's `events.jsonl` and memory log — ctrl adds **no fields to
  the frozen wire format**.
- ctrl writes a **sidecar** `<sessionDir>/ctrl.jsonl`: one record per tool call
  binding `callId → { machine, cwd, argv, terminal?, startedAt }`. It is
  derived data; events.jsonl stays authoritative for the conversation.
- Resume: replays events (pi-durable already marks dangling tool calls as
  failed, never re-executes — its §A1/R5), then uses the sidecar to
  `terminal.get` any address: still alive → attach/observe; gone → report
  "lost", do not resend the command.
- Each session owns exactly one remote workdir and at most one long-running
  terminal per `spawn` call.

## 7. Long tasks (D4)

- Threshold: a command expected to exceed ~60 s goes through `spawn`
  (`terminal.run`) instead of `exec`. The model chooses via a separate tool
  (`run_task`) rather than ctrl guessing.
- Streaming: ctrl polls `terminal.read` (bounded lines) and pushes to the web
  layer over SSE; exit status comes from `terminal.wait`.
- Interrupt: `terminal.interrupt`, then keep the terminal address in the sidecar.
- Never wait on a terminal from the agent loop without a deadline; the loop
  records `assistant_pending`/tool call before waiting.

## 8. Web surface (D6)

- `node:http`, zero deps, loopback by default (`127.0.0.1:7333`), optional
  `--token`; no CORS, no cookies, no accounts.
- Views: **chat**, **sessions**, **machines/terminals**, **memory**.
- API: `/api/health`, `/api/sessions`, `/api/chat` (send), `/api/stream` (SSE),
  `/api/machines`, `/api/terminals/:addr/read`, `/api/memory`.
- Every herdr method exposed to the browser must be **whitelisted**; `machine.add`,
  `machine.rm`, `terminal.attach`, `terminal.kill` stay CLI-only in v1.
- The web process is the only thing holding the `hc connect` pipe.

## 9. Scheduling (D7 🔴)

v1 = the agent runs commands on a chosen machine; ctrl picks the machine from a
config default plus an explicit `--on`.

v2 = `terminal.run` launches agent templates (pi/claude) on a machine, ctrl
tracks them as durable child tasks (`wait`/`send`/`read`), and the web UI shows
a task tree. The door is the sidecar record plus a `tasks` table in the UI; no
schema change is needed now.

## 10. Testing (frozen requirements)

- **Unit**: JSON-RPC client against a fake stdio core; manifest diff; tar
  chunking; each tool adapter (limits, base64, error kinds).
- **e2e**: fake herdr core (stdio JSON-RPC server) + pi-durable's fake LLM
  server; scenarios: remote edit → remote exec → local read; long task stream;
  `kill -9` then resume with a live and a dead terminal.
- **Live acceptance (manual, M1 gate)**: from a local checkout, `ctrl` builds a
  Go repo on `hw-nj`; the target has hc + Go and **no node, no pi, no agent**.

## 11. Open decisions (🔴 all of them change what M1 code looks like)

| # | Question | Recommendation |
| --- | --- | --- |
| D0 | how ctrl depends on pi-durable | A: sibling checkout + `file:` + `exports` map |
| D2 | workspace: write-through mirror vs remote-as-truth | write-through (keep local truth) |
| D3 | remote workdir layout | `~/.ctrl/<sessionId>/` per session |
| D-a | web auth: loopback only vs `--token` | loopback + optional token |
| D-b | v1 scope: commands only vs also launch agents | commands only |
| D-c | which LLM/provider | same as pi-durable (`workbuddy/hy4-preview-ioa`, key from `~/.pi/agent/auth.json`) |

## 12. Revisions

- **R1** — project started. Repo `zzjcool/ctrl`. Name story: the broken Ctrl key.
