# 实施方案 v3 — ctrl 说话，pi 干活

> 契约见 [CONTRACT.md](CONTRACT.md)（v3）。这是这次改造的施工单。

## 0. 验收

1. `npm run typecheck && npm test && npm run test:e2e` 全绿。
2. `ctrl --agent scout` → 页面上说「让 pi 统计一下仓库里有多少个 .ts 文件」：
   agent 调 `delegate` → 卡片出现 `job <id> running` → 过一会儿变 `exited 0`，
   卡片里能看到 worker 的输出，agent 把结论复述给你。
3. 关掉标签页再打开：对话、记忆、那个 job 的最终状态都还在。
4. ctrl 进程里**没有**任何 read/bash/edit 工具，也没有 ssh/机器概念。

## 1. 改动清单

| 动作 | 路径 |
| --- | --- |
| **删除** | `src/exec/**`（local + ssh + types）、`src/tools/execution.ts`、`tests/unit/local-exec.test.ts`、`tests/unit/ssh-quote.test.ts` |
| **新增** | `src/jobs/store.ts`（目录、meta、状态）、`src/jobs/runner.ts`（spawn pi / 停止）、`src/jobs/tools.ts`（3 个工具） |
| **重写** | `src/tools/index.ts`（jobs + remember/recall） |
| **修改** | `src/server/server.ts`（去 machine/executor，加 jobs 配置）、`src/server/routes.ts`（+`/api/jobs`，system prompt，去 machine）、`src/server/sidecar.ts`（只剩 cwd）、`src/cli/index.ts`（去 `--machine`，加 `--pi-bin` `--max-workers`） |
| **改测试** | 删 exec 两组；新增 `tests/unit/jobs.test.ts`（用假 pi 脚本）；改 `tests/e2e/agent.test.ts` 的工具断言 |

页面只改 `src/web/public/*`（W2）。

## 2. 文件所有权

| 谁 | 拥有 |
| --- | --- |
| **W1 backend** | `src/jobs/**`、`src/tools/**`、`src/server/**`、`src/cli/**`、`tests/**`；删除 `src/exec/**` |
| **W2 ui** | `src/web/public/{index.html,app.js,styles.css}` |
| 父会话 | `docs/**`、`README.md`、`package.json` |

## 3. 关键实现

### 3.1 job 目录

```
<agentHome>/jobs/<id>/
  meta.json   { id, task, cwd, model, thinking, startedAt, pid, exitedAt?, code?, signal? }
  out.log     worker 的 stdout+stderr
  pi/         --session-dir，worker 自己的会话
```

- `id` = `YYYYMMDDTHHMMSSZ-<6 位随机>`。
- 状态**只从磁盘读**：`meta.exitedAt` 有值即结束；否则 `kill(pid, 0)` 探活，
  探不到且没有 exitedAt → 标 `lost`（ctrl 崩过），不要假装还在跑。
- `elapsedMs` = `(exitedAt ?? now) - startedAt`。

### 3.2 启动 worker

```
pi -p <task>
   --provider <provider> --model <model> --thinking <thinking>
   --session-dir <job>/pi --session-id <id>
```

- `spawn(..., { detached: true, cwd: job.cwd, stdio: ["ignore", out, out] })`，
  `unref()`；pid 写 meta。
- 默认取 ctrl 自己的 `--provider/--model/--reasoning-effort`（provider 允许空，
  空就不传——本机 pi 的默认 provider 可能歧义，所以默认传 `any-endpoint`，
  可用 `--pi-provider` 覆盖）。
- 退出时由父进程 `on("exit")` 或轮询写 `exitedAt/code`；两种都做（重启后靠磁盘）。
- 并发上限默认 3（`--max-workers`）；超了 `delegate` 返回
  `{ ok:false, output:"3 workers already running; poll them with job_status" }`。

### 3.3 工具

| 工具 | 参数 | 返回 |
| --- | --- | --- |
| `delegate` | `{ task, cwd?, model?, thinking? }` | `started job <id> — poll with job_status` |
| `job_status` | `{ id?, lines=40, full? }` | 单个：`state/elapsed/exit` + 输出尾部；无 id：列出最近 10 个 job |
| `job_stop` | `{ id }` | `stopped <id>` / 错误 |

- 全部返回 `{ ok, output }`，不抛异常。
- `full` 时整份日志，但截到 20 000 字符并注明截断。
- `job_status` 无 id 时输出一行一个：`<id> <state> <elapsed> <task 前 60 字>`。

### 3.4 `/api/jobs`

`GET /api/jobs` → `{ jobs: [{ id, state, task, startedAt, elapsedMs, code? }] }`，
按 startedAt 倒序，最近 20 个。页面用它更新 delegate 卡片和状态条的 worker 计数。

### 3.5 system prompt 与 system 事件

- prompt 按契约 §6 那句，`<cwd>` 用 sidecar 里的 workspace。
- `delegate` 的结果只是工具卡片；**不要**往日志里补自定义事件。

## 4. 测试

| 文件 | 测什么 |
| --- | --- |
| `tests/unit/jobs.test.ts` | 假 pi（临时 `.sh` 脚本：echo + sleep + exit 7）→ 状态 running→exited 7、输出尾部、并发上限、stop、磁盘状态（删进程后仍能读） |
| `tests/e2e/agent.test.ts` | 假 LLM 脚本化：第一轮调 delegate（用假 pi），第二轮 job_status，断言 tool_call/tool_result 里出现 job id 与 `exited 0` |
| 其余 | 保持通过；删掉 exec 相关 |

假 pi 通过 `--pi-bin /tmp/xxx.sh` 注入，不要真的调 pi。

## 5. 坑

- `pi -p` 在模型歧义时会报错退出：默认要带 `--provider any-endpoint`。
- `spawn` 的 `detached` + `unref` 才能让 job 活过这一轮；stdout 必须落文件。
- 探活用 `process.kill(pid, 0)`，`EPERM` 视为活着。
- `job_status` 读日志要处理文件不存在（刚 spawn 还没写）。
- 删 `src/exec` 后 `package.json` 的 test 脚本别引用不存在的目录。
- 页面的 delegate 卡片要在 turn 结束后继续更新（轮询 `/api/jobs`，按 job id 合并）。

## 6. 派发边界

- W1：§2 表里 backend 的全部 + 三条验收命令；删除 exec 时连带删它的测试；
  不要碰 `src/web/public`。
- W2：只改三个静态文件；接口用契约 §7（含 `/api/jobs`）；`node --check` 必过。
- 父会话：合并后跑全套 + 用真 pi 跑一次 `delegate` 验收。
