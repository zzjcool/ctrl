# ctrl 实施方案 (v1)

> 契约在 [CONTRACT.md](CONTRACT.md)。这里只说**怎么做、谁做、怎么验收**。
> 目标不是"看起来像产品"，而是：**在页面上说一句，它在远端把 build 跑完。**

## 0. 验收（唯一标准）

1. `npm run typecheck && npm test` 通过。
2. `npm run ctrl -- --machine local --port 7333` → 打开 `http://127.0.0.1:7333`
   能对话，工具卡片随事件逐条出现，刷新不丢。
3. `npm run ctrl -- --machine hw-nj --workspace /home/u/proj` →
   让它 `go build ./...`，卡片显示 `hw-nj · 12s · exit 0`。
4. 远端没有 node、没有 agent，只有 sshd + go。

## 1. 文件所有权

| 路径 | 内容 | 谁写 |
| --- | --- | --- |
| `src/engine/durable.ts` | **唯一** import pi-durable 的文件（re-export） | W1 |
| `src/exec/types.ts` | Executor 接口（契约 §4） | W1（冻结） |
| `src/exec/local.ts` | 本机实现 | W1 |
| `src/exec/ssh.ts` | SSH 实现（ControlMaster、引用转义、任务） | W1 |
| `src/tools/execution.ts` | read_file / write_file / list_dir / bash / run_task / task_output | W1 |
| `src/tools/index.ts` | 上面 6 个 + pi-durable 的 remember/recall | W1 |
| `src/server/turns.ts` | 单会话单轮锁 + abort | W1 |
| `src/server/http.ts` | JSON、静态文件、错误 | W1 |
| `src/server/routes.ts` | 契约 §10 的 9 条路由 | W1 |
| `src/server/server.ts` | node:http 装配 | W1 |
| `src/server/sidecar.ts` | `<sessionDir>/ctrl.json` 读写 | W1 |
| `src/cli/index.ts` | `ctrl [serve] --port --host --workspace --home --machine --allow-bash` | W1 |
| `tests/unit/*.test.ts` | quoting / local exec / turns / since / sidecar | W1 |
| `tests/e2e/*.test.ts` | 假 LLM + local executor 的端到端 | W1 |
| `src/web/public/{index.html,app.js,styles.css}` | 页面 | W2 |
| `package.json` / `tsconfig.json` / `README.md` / `docs/**` | 父会话 | 父会话 |

W1 与 W2 的文件完全不相交，可并行；接口以契约 §4 / §10 为准。

## 2. 关键实现细节（别自己发明）

### 2.1 engine seam

```ts
// src/engine/durable.ts
export { runAgent, asAgentMemory } from "../../../pi-durable/src/core/agent.ts"
export { createSession, openSession, listSessions, continueRecentSession } from "../../../pi-durable/src/core/session.ts"
export { createMemoryStore } from "../../../pi-durable/src/core/memory.ts"
export { resolvePaths } from "../../../pi-durable/src/core/paths.ts"
export { createChatCompletionsClient, DEFAULT_LLM_MODEL } from "../../../pi-durable/src/core/llm.ts"
export { detectResumePoint, repairSession } from "../../../pi-durable/src/core/resume.ts"
export { buildTools } from "../../../pi-durable/src/core/tools.ts"
export { appendRecord } from "../../../pi-durable/src/core/jsonl.ts"
export type { /* types.ts 里用得到的 */ } from "../../../pi-durable/src/core/types.ts"
```

pi-durable 已在 `~/code/pi-durable`；仓库内不复制、不修改。

### 2.2 一轮对话

`POST /messages` 只做三件事：校验、开锁、启动后台任务，然后立刻 `202`。

```ts
const llm = { model: base.model, complete: (req) => base.complete({ ...req, signal }) }
await runAgent({ sessionId, input: text, session, llm, memory, tools, cwd: meta.cwd, maxSteps, allowBash })
```

- `runAgent` 自己会 append `user_message`、`assistant_pending`、工具事件。
- 失败：LLM 失败 pi-durable 已写 `error` 事件；其它异常只记在 `TurnRegistry`
  里（`turn.error`），**不要**往日志里补 error（避免重复）。
- abort：`controller.abort()` 让 fetch 取消；`signal.aborted` 时补一条
  `error: "turn aborted by the user", fatal: false`。

### 2.3 工具

- 名字/描述/schema 与 pi-durable 的 `read_file`/`write_file`/`list_dir`/`bash`
  完全一致（模型换后端无感）；`remember`/`recall` 直接用
  `buildTools().filter(...)` 取 pi-durable 的。
- `bash`：`executor.exec(["sh","-c",cmd], { cwd: ctx.cwd, timeoutMs: ctx.timeoutMs })`。
  外层的 10 s 上限由 pi-durable 的 `executeTool` 施加，不要自己再加。
- `run_task`：`{ command: string }` → `executor.spawn(["sh","-c",command])`，返回
  `"started <address> — poll with task_output"`。**不要**在工具里等。
- `task_output`：`{ address: string, lines?: number, kill?: boolean }`；`kill` 时先
  `stopTask` 再返回"stoped"。输出里若已退出，附 `[exit N]`。
- 所有工具返回 `{ ok, output }`，异常不要往外抛（pi-durable 会兜底，但会给模型
  一个难看的堆栈）。

### 2.4 SSH executor

| 方法 | 命令 |
| --- | --- |
| 连接 | `ssh -M -S <tmp>/ctrl-<host>.sock -N -f -o ControlPersist=60 <host>`（首次，失败则退化） |
| exec | `ssh -S <sock> <host> -- sh -c <quoted>`，`spawn` 捕获 stdout/stderr/exit |
| read | `ssh … cat <path>`，行切片本地做 |
| write | `ssh … 'mkdir -p <dir> && cat > <path>'` + stdin |
| list | `ssh … ls -1Ap <path>` |
| 引用 | POSIX 单引号：`'` → `'\''`；路径只做参数，不做字符串拼接 |
| spawn | `ssh … 'mkdir -p ~/.ctrl/tasks && setsid sh -c <cmd> > ~/.ctrl/tasks/<id>.log 2>&1 < /dev/null; echo $? > ~/.ctrl/tasks/<id>.code' & echo $!`（id 由 ctrl 生成，地址 `<host>/<id>`） |
| readTask | `ssh … 'tail -n <lines> ~/.ctrl/tasks/<id>.log; cat ~/.ctrl/tasks/<id>.code 2>/dev/null'` |
| stopTask | `ssh … 'kill -TERM -<pid> 2>/dev/null || kill -TERM <pid>'`（pid 存 `<id>.pid`） |
| 错误改写 | 去掉 `ssh:`/host 前缀；超时 → `command timed out after Ns` |

本机 `LocalExecutor.spawn` 用 `child_process.spawn(detached:true)` + 日志文件 +
内存表（**本机任务随 ctrl 退出而消失**，文档里写清楚即可）。

### 2.5 页面（W2）

- 只依赖 `/api/*`，不 import 任何库，不用构建。
- 事件 → DOM：`user_message`（右侧气泡）、`assistant_message`（全文）、
  `assistant_pending`（转圈）、`tool_call`+`tool_result`（同 `callId` 合并成一张卡）、
  `error`（红色行）、`compaction`（灰色一行）。
- 卡片：工具名 + 机器 + 耗时（`tool_call.ts` → `tool_result.ts`）+ `ok/fail` +
  可折叠输出。
- 轮询：`running` 时 700 ms，空闲 2500 ms；`since` 用返回的 `total` 推进。
- 发送：POST → 202；409 显示"上一轮还在跑"；停止按钮 → `/abort`。
- 安全：所有文本用 `textContent`，不拼 `innerHTML`。
- 断线/刷新：重新拉 `GET /api/sessions/:id` 并重画。

### 2.6 sidecar

`<sessionDir>/ctrl.json`（pi-durable 的 paths 里没有这个文件，ctrl 自己拼
`resolvePaths(home).sessionDir(id) + "/ctrl.json"`）：

```json
{ "machine": "hw-nj", "remoteCwd": "/home/u/proj", "createdAt": "…" }
```

会话创建时写一次；`GET /api/sessions/:id` 读它补到响应里。

## 3. 测试

| 文件 | 测什么 |
| --- | --- |
| `tests/unit/ssh-quote.test.ts` | 单引号、路径带空格、`'` 本身、换行 |
| `tests/unit/local-exec.test.ts` | exit code、stderr、超时杀进程组、stdin |
| `tests/unit/turns.test.ts` | 同一会话第二次 409、abort 状态、错误不冲掉日志 |
| `tests/unit/events-tail.test.ts` | `since` 切片边界（0 / 中间 / 超界） |
| `tests/unit/sidecar.test.ts` | 写入/损坏文件不致命 |
| `tests/e2e/chat.test.ts` | 假 LLM：建会话 → POST → 事件增长 → 工具卡片数据齐全 |

假 LLM 抄 pi-durable `tests/e2e/fake-llm-server.ts` 的做法（脚本化响应）。

## 4. 已知坑（别踩）

- macOS 没有 `setsid`：SSH 侧有（远端 Linux），本机侧用 Node 的 `detached`。
- `ssh` 首次连接会问 host key：CLI 加 `-o StrictHostKeyChecking=accept-new`。
- 远端 `sh` 可能是 dash：别用 `[[ ]]`、`pipefail`。
- 10 s 上限是外层给的：`bash` 里 `sleep 30` 会被判超时并杀进程组，这是对的。
- 大输出：pi-durable 的 `executeTool` 会截断（8000 字符）；别再截一次。
- `--machine` 的合法性：`local` 或 `~/.ssh/config` 里的 Host；不做探测（第一次
  真调用才知道通不通）。
- 端口默认 7333；被占用时报错要清晰。

## 5. 本次派发

- **W1 backend**：§1 表里 W1 的全部文件 + 单测 + e2e。验收命令
  `npm run typecheck && npm test && npm run test:e2e`。
- **W2 ui**：`src/web/public/*` 三个文件。验收：`node --check src/web/public/app.js`
  通过；页面按契约 §10 的字段渲染，不引用不存在的接口。
- 两个 worker 不碰对方的目录；父会话最后跑 typecheck + 手工验收。
