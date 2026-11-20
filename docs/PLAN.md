# 实施方案 v2 — 去掉"会话"

> 契约见 [CONTRACT.md](CONTRACT.md)（v2）。本文件是这次改造的施工单。

## 0. 验收

1. `npm run typecheck && npm test && npm run test:e2e` 通过。
2. `ctrl agent new builder --model ...` → `ctrl --agent builder` → 页面标题就是
   `builder`，没有侧栏、没有"新对话"。
3. 说一句话 → 时间线追加用户行 + 工具卡片 + 回复；刷新后还在。
4. 重启 ctrl：同一个 agent 的日志、记忆、机器、cwd 全部还在，接着说话。
5. `ctrl agent rm builder` → `~/.ctrl/trash/builder-<stamp>/`；再 `ctrl agent new
   builder` 是空的（新记忆、新日志）。

## 1. 改动清单

| 区域 | v1 | v2 |
| --- | --- | --- |
| 身份 | 会话 id（时间戳随机） | **agent 名**（用户起），日志 id 固定 `main` |
| 存储 | `--home` 指向 pi-durable home | `--root ~/.ctrl` + `agents/<name>/` |
| API | `/api/sessions/:id/*` | `/api/agent/*` |
| 页面 | 侧栏 + 会话切换 + 气泡 | 单时间线 + 名字 + 上翻分页 |
| 机器 | `--machine` 进程级 | 不变（v1 阉割掉切换） |
| 删除 | 无 | `agent rm` → `trash/`，`--purge` 真删 |

## 2. 文件所有权

| 路径 | 谁 |
| --- | --- |
| `src/server/**`、`src/cli/**`、`tests/**` | **W1 backend** |
| `src/web/public/{index.html,app.js,styles.css}` | **W2 ui** |
| `src/engine/**`、`src/exec/**`、`src/tools/**`、`docs/**` | 不动 |

W1 不改 exec/tools，只改 server + cli（tools 与 executor 的装配从 `buildContext`
里保留）。W2 只按 §3.3 的 API 写。

## 3. 关键实现

### 3.1 agent 目录

```ts
// 新增 src/server/agents.ts（W1 自己定文件名）
root = flags.root ?? process.env.CTRL_ROOT ?? join(homedir(), ".ctrl")
agentHome = join(root, "agents", name)
agentFile = join(agentHome, "agent.json")   // { name, model, createdAt }
```

- 名字校验 `^[a-z0-9][a-z0-9_-]{0,31}$`，非法直接退出码 2。
- `--agent` 默认 `main`；目录不存在就创建（写 `agent.json` + 建空日志）。
- 日志 id 固定 `"main"`：`createSession({ sessionId: "main", home: agentHome, cwd, model })`。
- 已存在 → `openSession("main", { home: agentHome })`。
- `resolvePaths(agentHome)` 给 pi-durable 的所有路径；`ctrl.json` 仍写在
  `<agentHome>/sessions/main/ctrl.json`。

### 3.2 CLI

```
ctrl [serve] [--agent <name>] [--root <dir>] [--machine <host>]
             [--model <id>] [--reasoning-effort <level>]
             [--workspace <dir>] [--allow-bash] [--port] [--host] [--max-steps]
ctrl agent list
ctrl agent new <name> [--model <id>] [--json]
ctrl agent rm <name> [--purge]
```

- `agent list`：扫描 `<root>/agents/*`，输出 `name  created  events  last活动`。
- `new`：创建目录 + 日志（需要 cwd，默认取当前目录；ssh 机器取 `~`）。
- `rm`：整目录 move 到 `<root>/trash/<name>-<YYYYMMDDHHMMSS>/`；`--purge` 直接删。
  不存在 → 退出码 1 + 明确信息。
- `serve` 启动横幅：`agent: <name> (log 3 events) / machine: ... / model: ...`

### 3.3 路由（契约 §7 的落地细节）

- `GET /api/agent` → 读 `agent.json` + `openSession` 的 meta + `detectResumePoint` +
  `turns.state` + sidecar，一次返回。
- `GET /api/agent/events` 三种模式，优先级 `before` > `tail` > `since`：
  ```
  since=N        → events.filter(e => e.seq >= N).slice(0, 200)
  tail=T         → events.slice(-T)
  before=S&tail=T→ events.filter(e => e.seq < S).slice(-T)
  ```
  响应统一 `{ events, total, since, turn }`，`since` = 返回的第一条的 seq（无事件则 0/不变）。
- 其余：`POST /api/agent/messages`、`POST /api/agent/abort`、`GET /api/machines`、
  健康检查、memory 三件套。**删掉所有 `/api/sessions*` 路由**。
- `runTurn` 传 `systemPrompt`（契约 §6），agent 名 + machine + cwd 每次进 prompt。

### 3.4 删除语义

`agent rm` 用 `renameSync` 到 trash；trash 里同名的再删就带后缀。**不要** rm -rf，
除非 `--purge`。

## 4. 测试

| 文件 | 测什么 |
| --- | --- |
| `tests/unit/agents.test.ts` | 名字校验、目录创建、list 排序、rm 归档、purge |
| `tests/unit/events-page.test.ts` | since / tail / before 三种模式的边界 |
| `tests/e2e/agent.test.ts` | 假 LLM：`--root` 临时目录 → 建 agent → 发消息 → 事件增长 → 重启后仍在 |
| 旧测试 | 删除或改写到新 API（`tests/e2e/chat.test.ts` 里的 sessions 断言） |

## 5. 坑

- pi-durable 的 `createSession` 接受 `sessionId`，固定 `"main"` 即可；不要自己写 jsonl。
- `openSession` 会 replay 整个日志：单一永恒日志会越来越慢。v1 先接受（几千条毫秒级），
  以后加派生索引（契约 M6 提过）。
- 时间线首屏要 `tail=100`，不要一上来 `since=0` 全量。
- 页面上"已经更多历史"用 `before` 判断：`since > 0` 就还有。
- `agent.json` 的 model 只在建日志时用；之后以 `session_created` 里记的为准。
- 不要给页面加 agent 切换器：一个进程一个 agent，契约 §2。

## 6. 派发边界

- W1：§2 表里 backend 的全部，自己跑三条验收命令；不碰 `src/web/public`。
- W2：三个静态文件，按 §3.3 的字段渲染；`node --check app.js` 必须过。
- 父会话：合并后跑 typecheck + 手工起服务，确认页面首屏 `tail` 与时间线都对。
