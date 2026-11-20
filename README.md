# Ctrl

> 写这个项目的时候，我键盘上的 Ctrl 键坏了。
> 所以我做了一个不用一直按着它的东西：**线在这里，活干在别处。**

一个持久的对话 agent：给它起个名字，它就一直活着，记得你们说过的所有事。
**它自己不下场干活**——需要翻代码、跑测试、改文件时，它去调一个 `pi` worker
回来，再把结果讲给你。

```text
浏览器                 ctrl（本地）                         pi worker
┌──────────┐   HTTP   ┌─────────────────────────┐  spawn   ┌──────────────────┐
│ 一个时间线 │ ───────► │ pi-durable              │ ───────► │ pi -p "<task>"   │
│ 一直往下  │ ◄─────── │  append-only 日志 + 记忆 │ ◄─────── │ 读/改/跑，随便它  │
└──────────┘          │ delegate / job_status    │  输出落盘 └──────────────────┘
                      └─────────────────────────┘
```

## 它解决什么

- **记忆不丢**：对话写在本地的 append-only 日志里，进程崩了、标签页关了，回来接着说。
- **脑子和手分开**：ctrl 只负责理解你、记住上下文、把活派出去；脏活累活是 pi 的。
- **派活是异步的**：`delegate` 立刻返回 job id，worker 在后台跑，`job_status` 随时看进度。
- **能看见**：时间线上每张卡片就是一次派活——任务、状态、耗时、输出都在那里。

## 一个 agent = 一个目录

```
~/.ctrl/agents/builder/
  agent.json                  名字、模型、出生时间
  memory/index.jsonl          它自己的记忆
  sessions/main/events.jsonl  它的一生
  jobs/<id>/                  每次派出去的活：task、输出、worker 自己的 pi 会话
```

删掉目录它就不存在了（`ctrl agent rm` 会先移进 `trash/`）；换个名字就是一个
新的、什么都不记得的 agent。没有"会话"，没有"新对话"，没有侧栏。

## 现状

**v3 开发中**（ctrl 从"自己干活"改成"调 pi 干活"）。契约见
[docs/CONTRACT.md](docs/CONTRACT.md)，施工单见 [docs/PLAN.md](docs/PLAN.md)。

- 工具：`delegate` / `job_status` / `job_stop` + `remember` / `recall`
- worker：`pi -p`，每个 job 独立会话目录，输出落盘，最多 3 个并行
- 模型：默认 `workbuddy/deepseek-v4.1-flash`（reasoning `max`）

## 和兄弟项目的关系

| 项目 | 是什么 | ctrl 怎么用它 |
| --- | --- | --- |
| [pi-durable](https://github.com/zzjcool/pi-durable) | append-only 会话、记忆、agent 循环、压缩 | 引擎，唯一 import 处是 `src/engine/durable.ts` |
| pi | 真正会读代码、改文件、跑命令的 agent | 每次派活起一个 `pi -p` 子进程 |
| herdr / kraal | 机器与终端 | 无关（v1 之后再说） |

## 约定

沿用 pi-durable / pi-async / pi-legion 的家规：TypeScript strict、ESM、无构建步骤
（`node --experimental-strip-types` 直接跑 `.ts`）、相对 import 带 `.ts` 后缀、
测试用 `node:test`、零运行时依赖（Node builtins only）。
