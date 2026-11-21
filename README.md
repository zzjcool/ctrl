# Ctrl

> 写这个项目的时候，我键盘上的 Ctrl 键坏了。
> 所以我做了一个不用一直按着它的东西：**线在这里，活干在别处。**

一个持久的对话 agent：给它起个名字，它就一直活着，记得你们说过的所有事。
**它自己不下场干活**——需要翻代码、跑测试、改文件时，它去调一个 `pi` worker
回来，再把结果讲给你。

```text
浏览器                 ctrl（本地）                         pi worker
┌──────────┐   HTTP   ┌─────────────────────────┐  spawn   ┌──────────────────┐
│ 一个时间线 │ ───────► │ 官方 pi SDK             │ ───────► │ pi -p "<task>"   │
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

**v4**：会说话、会派活、会记事。

- **记忆**：全部事件增量镜像进 `<agent>/memory.db`（SQLite + FTS5）；
  对话窗口只留最近约 4 万字符，更早的压成摘要，原文靠 `search_context` 翻。
- **做梦**：空闲 10 分钟或手动 `POST /api/dream`，抽事实、去重、矛盾 supersede、
  整理 focus、必要时重写 `profile.md`；每次都有 `dream_runs` 记录。
- **面板**：右侧 focus（doing/open/blocked）、运行中的 worker、上次做梦时间；
  「记忆」抽屉可搜索、可删除。
- **工具**：`delegate` / `job_status` / `job_stop` / `search_context` / `focus_set` / `remember` / `recall`
- **worker**：`pi -p`，每个 job 独立会话目录，输出落盘，最多 3 个并行
- **模型**：默认 `workbuddy/deepseek-v4.1-flash`（reasoning `max`）

## 和兄弟项目的关系

| 项目 | 是什么 | ctrl 怎么用它 |
| --- | --- | --- |
| [pi-coding-agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) | 会话、上下文、压缩、agent 循环 | 引擎，唯一出口是 `src/engine/durable.ts` |
| pi | 真正会读代码、改文件、跑命令的 agent | 每次派活起一个 `pi -p` 子进程 |
| herdr / kraal | 机器与终端 | 无关（v1 之后再说） |

## 约定

沿用 pi-durable / pi-async / pi-legion 的家规：TypeScript strict、ESM、无构建步骤
（`node --experimental-strip-types` 直接跑 `.ts`）、相对 import 带 `.ts` 后缀、
测试用 `node:test`、运行时依赖只有官方 pi SDK。

## 运行

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.ctrl.serve.plist   # 起
launchctl kickstart -k gui/$(id -u)/dev.ctrl.serve                              # 重启
launchctl bootout   gui/$(id -u)/dev.ctrl.serve                                 # 停
```

launchd 调的是 `~/.local/bin/ctrl-supervise.sh`（不在仓库里）：起服务、20 秒内
`/api/health` 不通就丢掉未提交改动重试，还不行回滚到 `~/.ctrl/known-good`，
再不行就停下。日志：`~/Library/Logs/ctrl-serve.log`。

## 三条规矩

1. **代码是唯一的事实**。文档只在施工期存在，实现完成即删除；设计决定留在
   commit message 和测试里，不留 spec 文档。
2. **不写注释**。意图靠命名、拆小函数和测试表达；一个坑值得记住，就写一个测试，
   而不是写一行注释。
3. **文档会过时，用测试和代码表达**。仓库只留这份 README 里的运行与交互说明；
   设计文档、接口文档、架构说明一律不写，行为由 `tests/` 固定——想知道某个接口
   怎么工作，就看对应测试。
