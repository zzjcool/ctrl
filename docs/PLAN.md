# ctrl 实施方案（待执行）

> 这份文件回答「谁来做、按什么顺序、以什么为验收、哪些是硬约束」。
> 契约（目标/边界/决策）在 [CONTRACT.md](CONTRACT.md)；这里只讲怎么落地。
> 代码尚未开始——本文件是第一刀之前的全部准备。

---

## 1. 运行形态

```
浏览器 ── HTTP ──► ctrl 进程（本地）
                     ├─ pi-durable：events.jsonl / memory / runAgent / 压缩
                     ├─ TurnRegistry：一轮一次、后台跑、可 abort
                     └─ Executor ──► hc connect（JSON-RPC over stdio）──► 远端机器
                                                                          machine.exec
                                                                          file.read/write
                                                                          terminal.run/wait
```

一条主数据流：**POST 只说"开始"，页面读日志**。

```
POST /api/sessions/:id/messages  → 202，后台跑这一轮
GET  /api/sessions/:id/events?since=N → 浏览器 tail append-only 日志
```

所以"流"不是另一套协议，就是会话本身。

## 2. 依赖与不变量

- **pi-durable 版本钉住 `9e6fc89`**（main）。已 clone 到 `~/code/pi-durable`（本机）。
- **不改 pi-durable**。整个仓库只有一个文件 import 它：`src/engine/durable.ts`。
  D0 换依赖方式时，只改这一个文件。
- **不改 `events.jsonl` wire format**。ctrl 的执行坐标写 sidecar `<sessionDir>/ctrl.jsonl`，
  用 `callId` 对齐；sidecar 是派生数据，删掉不影响对话。
- **工具层归 ctrl**。执行类工具（read_file/write_file/list_dir/bash/run_task）ctrl 自己实现，
  只为模型保持与 pi-durable 相同的名字/描述/schema；remember/recall 直接从 pi-durable 取，
  不复制语义。

## 3. 已探明的硬约束（决定实现形状，不是选项）

| 事实 | 来源 | 后果 |
|---|---|---|
| 单个工具调用 **10 s** 上限（不可配置） | `pi-durable/src/core/agent.ts` `TOOL_TIMEOUT_MS` | 可能超 10 s 的命令必须走 `run_task`（terminal），不能走 `exec`；**所以 `run_task` 属于 M2，不是 M4** |
| `machine.exec` ≤ **600 s**；stdin / `file.write` ≤ **8 MB**（base64） | herdr `hc schema` | 大文件分块；构建用终端 |
| `runAgent()` 无 token streaming、无 `signal` 参数；`llm.complete()` **有** `signal` | `agent.ts` / `types.ts` | 日志即流；abort = 包一层 LlmClient，不改引擎 |
| 事件 `seq` 是 dense、0-based | `types.ts` `EventEnvelope` | `?since=` 是数组下标，tail 很便宜 |
| `detectResumePoint()` 只有 `empty/clean/dangling_tool_call/interrupted_turn` | `resume.ts` | UI 的"已恢复"徽章直接映射这四种 |
| `machine.exec` 是 argv、**不过 shell** | herdr `hc schema` | `bash` 工具必须显式发 `["sh","-c",cmd]` |
| herdr 需要 `hello` 握手（generation 1，features: framed/attach/events/status/…） | 实测 | 客户端启动先握手，默认行模式（不请求 framed） |
| 目标机零 agent 是成立的：`hc machine add --install` 会推 hc 过去 | `hc machine add --help` | 远端只需要 sshd + toolchain |
| 实测：`hello` → `machine.exec` → `file.read` 全通，40 行 Node 零依赖 | `/tmp/hc-rpc.mjs` | M2 的技术风险很低 |

## 4. 里程碑（与 CONTRACT §12 一致）

| # | 交付 | 验收（能在页面上看见） | 必测 |
|---|---|---|---|
| **M1** | 页面 + 本地执行：会话/消息/工具卡片、日志 tail、composer、机器 chip | 聊一轮，工具卡片逐条自己冒出来；刷新不丢；两个标签页同一份 | 单测：tail 切片、TurnRegistry 锁、LocalExecutor；e2e：建会话→发消息（假 LLM）→事件递增 |
| **M2** | herdr 后端 + `run_task` + 机器 chip 生效 | 选 `hw-nj`，`go build` 成功，卡片显示 `hw-nj · 42s · exit 0` | 假 core（stdio JSON-RPC）单测；真实 `hw-nj` 手工验收 |
| **M3** | 写穿 + manifest 增量 + tar 分块 + 懒拉取 | 改一个文件只推一个；远端生成的 `go.sum` 本地能读 | 单测：manifest diff、分块边界（6 MB）、懒拉取命中 |
| **M4** | 长任务实时输出 + 停止 | 10 分钟构建有实时 tail，能停，关掉浏览器还在跑 | 单测：read 游标；e2e：spawn→read→stop |
| **M5** | 崩溃恢复 + 终端重连 | `kill -9` 后重开：对话完整、活终端接上、死终端诚实报丢 | e2e：两个终端（活/死）各一条路径 |

每个里程碑的 Definition of Done：`npm run typecheck && npm test && npm run test:e2e` 通过 + 手动走一遍验收 + 一次 commit。

## 5. Worker 拆法（可并行，互不改同一文件）

| Worker | 拥有 | 不许碰 |
|---|---|---|
| **W1 服务端** | `src/server/**`、`src/cli/**`、`tests/unit/turns.test.ts` | `src/engine/**`、`src/web/public/**` |
| **W2 页面** | `src/web/public/**`（index.html / app.js / styles.css） | 服务端路由；只按 §6 的 API 契约写 |
| **W3 执行层** | `src/exec/**`、`src/tools/**`、`tests/unit/exec-*.test.ts` | 服务端；Executor 接口由父会话冻结 |
| **W4 herdr 后端**（M2） | `src/herdr/**`、`tests/unit/herdr-*.test.ts`、`tests/fixtures/fake-core.ts` | 其余全部 |

父会话冻结（worker 只读）：
- `docs/CONTRACT.md`（决策）
- `src/engine/durable.ts`（唯一 import pi-durable 的地方）
- `src/exec/types.ts`（Executor 接口）
- `src/server/routes.ts` 的路由表（§6 列出的就是契约）

## 6. 冻结接口（写进代码前先按这些签名开工）

### Executor

```ts
interface Executor {
  readonly kind: "local" | "herdr"
  readonly machine: string                       // 卡片上显示的名字
  exec(argv: string[], o?: { cwd?; env?; input?; timeoutMs? }): Promise<ExecResult>
  read(path: string, o?: { cwd?; offset?; limit? }): Promise<string>   // 行号，1-based
  write(path: string, data: string, o?: { cwd? }): Promise<void>
  list(path: string, o?: { cwd? }): Promise<string[]>
  spawn(argv: string[], o?: { cwd?; env?; name? }): Promise<{ address: string }>
  readTask(address: string, o?: { lines? }): Promise<string>
  stopTask(address: string): Promise<void>
}
type ExecResult = { code: number | null; stdout: string; stderr: string; ms: number; timedOut: boolean; truncated: boolean }
```

### HTTP API

| 方法 + 路径 | 行为 |
|---|---|
| `GET /api/health` | `{ status, machine, kind }` |
| `GET /api/machines` | M1: 只有 `local`；M2: `machine.list` |
| `GET /api/sessions` | 最近 30 条 + `title`（首条 user_message） |
| `POST /api/sessions` | `{ cwd?, model? }` → 201 `{ session }` |
| `GET /api/sessions/:id` | `{ session, events, resumePoint, turn }` |
| `GET /api/sessions/:id/events?since=N` | `{ events, total, since, turn }` ← **流** |
| `POST /api/sessions/:id/messages` | `{ text }` → 202；已有轮次在跑 → 409 |
| `POST /api/sessions/:id/abort` | 包装 LlmClient 的 signal；返回 `{ aborted }` |
| `GET/POST /api/memory`、`DELETE /api/memory/:id` | 与 pi-durable web 同语义（tombstone 走 `supersededBy`） |

`turn = { running: boolean, startedAt?, error?, aborted? }`，TurnRegistry 直接给出。

## 7. 测试与命令

```bash
npm install
npm run typecheck          # tsc --noEmit
npm test                   # node:test，单测
npm run test:e2e           # 假 core + 假 LLM 的端到端
npm run ctrl -- --port 7333
```

- 假 LLM：直接抄 pi-durable 的 `tests/e2e/fake-llm-server.ts` 思路（脚本化响应）。
- 假 herdr core：`tests/fixtures/fake-core.ts`，一个 stdio JSON-RPC 服务器，应答
  `hello` / `machine.list` / `machine.exec` / `file.*` / `terminal.*`。
- 真实验收环境：`hw-nj`（有 go1.22.12 / node v26），`host-workspace`（只有 node）。

## 8. 待你拍板（CONTRACT §11，带默认值）

| # | 问题 | 默认 |
|---|---|---|
| D0 | 依赖方式 | A：同级 checkout + `file:` + 给 pi-durable 加 `exports`（**注意：这会在 pi-durable 留一个改动；不想动就用现在的相对 import**） |
| D2 | 工作区 | 写穿（本地真相） |
| D3 | 远端目录 | `~/.ctrl/<sessionId>/` |
| D-a | Web 鉴权 | 只绑 127.0.0.1，可选 `--token` |
| D-b | v1 范围 | 只跑命令，不起 agent |
| D-c | 模型 | 与 pi-durable 相同（`workbuddy/hy4-preview-ioa`，key 读 `~/.pi/agent/auth.json`） |
| D-d | M1 起点 | 抄 pi-durable 的页面骨架来改（同作者、MIT） |

## 9. 第一刀（M1，给 W1/W2/W3 同时开工）

1. **父会话**：建 `src/engine/durable.ts`、`src/exec/types.ts`、`src/server/routes.ts` 骨架（只有签名和 501）。
2. **W1**：`src/server/{server,http,turns}.ts` + `src/cli/index.ts`；先把 202 和 tail 跑通（假 turn：只 append 一条 assistant_message 也能验收）。
3. **W2**：页面按 §6 的 API 写，不依赖服务端实现——用假数据先跑起来。
4. **W3**：Executor 接口 + `LocalExecutor` + 四个执行工具；单测只测本机行为。
5. 合起来：接真 LLM（`workbuddy/hy4-preview-ioa`），在 `~/code/ctrl` 里让 agent 读 README 并总结——这就是 M1 的人工验收。

## 10. 记录到的外部事实（备查）

- herdr core 版本 0.1.21；`hc connect` 是 stdin/stdout 上的 JSON-RPC 2.0；`hc schema` 给出 OpenRPC 描述（31 个方法）。
- 机器：`host-workspace`（Linux，node 24，无 go）、`hw-nj`（Linux，go 1.22.12，node 26）。
- 本机 macOS 上 `hc machine ls` 能看到这两台，且都 `connected`。
- 同赛道先例：`lubobill1990/longarm`（每个 worker 必须装 `longarmd`，这正是 ctrl 的差异点）。
