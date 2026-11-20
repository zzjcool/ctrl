# Ctrl

> 写这个项目的时候，我键盘上的 Ctrl 键坏了。
> 所以我做了一个不用一直按着它的东西：**线在这里，活干在别处。**

我自己用的一个 agent：**给它起个名字，它就一直活着；页面是它，不是一段对话。**
工具跑在我另外几台机器上。

远端只要有 `sshd`——不用装 node、不用装 agent、不用装任何运行时。AI 不会知道自己不在本地：工具名、输出格式、工作目录语义都一样，只是命令落在 ssh 那头的机器上。

```text
本地 Mac（控制机）                          远端（hw-nj / 任何 ssh 能到的机器）
┌──────────────────────────────┐          ┌──────────────────────────────────┐
│ 浏览器：一个对话页            │          │  go build / npm test / rg / git   │
│   │                          │          │        ▲                          │
│   ▼                          │          │        │  sh -c（经 ssh）          │
│ ctrl                         │          │                                  │
│  ├─ pi-durable：会话 + 记忆   │          │  远端就是工作目录（不镜像、不同步）│
│  └─ Executor ── ssh ─────────┼──────────┘                                  │
└──────────────────────────────┘          └──────────────────────────────────┘
```

## 它解决什么

- **笔记本不再烤手**：build、测试、`rg` 都在有核的那台机器上跑。
- **远端零安装**：只要 sshd（和你要用的 toolchain）。没有 daemon，没有 agent。
- **对话不死**：会话写在本地 append-only 日志里；进程崩了、标签页关了，回来接着说。
- **知道自己站在哪**：每张工具卡片都写着机器名和耗时，副作用落在哪一目了然。

## 一个 agent = 一个目录

```
~/.ctrl/agents/builder/
  agent.json                  名字、模型、出生时间
  memory/index.jsonl          它自己的记忆（新 agent 是空的）
  sessions/main/events.jsonl  它的一生（一条 append-only 日志）
```

删掉目录它就不存在了（`ctrl agent rm` 会先移进 `trash/`）；换个名字就是一个
新的、什么都不记得的 agent。没有"会话"，没有"新对话"，没有侧栏。

## 现状

**v2 开发中**（正在把"会话"从产品里删掉）。契约见
[docs/CONTRACT.md](docs/CONTRACT.md)，施工单见 [docs/PLAN.md](docs/PLAN.md)。

- 工具集：`read_file` / `write_file` / `list_dir` / `bash` / `run_task` / `task_output` + `remember` / `recall`
- 后端：`local`、`ssh`
- 工作区：**远端即工作目录**（不做同步、不做镜像）
- 页面：一条时间线（没有会话列表、没有新对话）
- 模型：默认 `workbuddy/deepseek-v4.1-flash`（reasoning `max`），可用 `--model` / `--reasoning-effort` 覆盖

## 和兄弟项目的关系

| 项目 | 是什么 | ctrl 怎么用它 |
| --- | --- | --- |
| [pi-durable](https://github.com/zzjcool/pi-durable) | append-only 会话、记忆、agent 循环、压缩 | 引擎，唯一 import 处是 `src/engine/durable.ts` |
| herdr core | 机器 + 持久终端 + attach | **v1 不用**；以后要"派人接管/调度 agent"再接 |
| kraal | Herdr 的 Swift 客户端 | 无关 |

## 约定

沿用 pi-durable / pi-async / pi-legion 的家规：TypeScript strict、ESM、无构建步骤
（`node --experimental-strip-types` 直接跑 `.ts`）、相对 import 带 `.ts` 后缀、
测试用 `node:test`、零运行时依赖（Node builtins only）。
