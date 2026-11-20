# Ctrl

> 写这个项目的时候，我键盘上的 Ctrl 键坏了。
> 所以我做了一个不用一直按着它的东西：**线在这里，执行随便去哪。**

**Ctrl 是一个持久对话的 agent 控制台。** 对话、记忆、会话日志留在本地；文件读写和命令执行发生在 herdr core 能到达的任何机器上——目标机不需要 node、不需要 agent、不需要装任何运行时。

```text
本地 Mac                                   远端机器（hw-nj / 临时沙箱 / 任何 herdr 能到的）
┌─────────────────────────────┐            ┌──────────────────────────────┐
│ 浏览器                       │            │  go build / npm test / dev   │
│   │                          │            │        ▲                     │
│   ▼                          │            │        │                     │
│ ctrl  ── 对话 / 记忆 / 事件   │            │   machine.exec               │
│   │      (pi-durable)        │            │   file.read / file.write     │
│   └── Executor ──── hc connect ── JSON-RPC ──►  terminal.run / wait / read │
└─────────────────────────────┘            └──────────────────────────────┘
```

## 它解决什么

- **笔记本不再烤手**：`go build`、测试、dev server 都在有核的那台机器上跑。
- **目标机零安装**：只要能 ssh（`hc` 会被 core 推过去），不需要 node / pi / 沙箱运行时。
- **对话不死**：会话是 append-only 的本地日志，进程崩了、机器重启了，回来接着说。
- **可以有人接管**：你在 herdr 里 `attach` 同一个终端，看着 agent 在跑什么。

## 现状

**M0：立项。** 契约草案在 [docs/CONTRACT.md](docs/CONTRACT.md)，还有几个待确认的决策（标 🔴）。代码尚未开始。

## 和兄弟项目的关系

| 项目 | 是什么 |
| --- | --- |
| [herdr core](https://herdr.dev) | 牧人：机器 + 持久终端 + 文件/执行 API（`hc connect`，JSON-RPC） |
| [kraal](https://github.com/zzjcool/kraal) | 畜栏：Swift 写的 Herdr 客户端，给 agent 群一个随身窗口 |
| **ctrl** | 控制面：持久对话 + 调度，把执行放到牧人的牧场上 |
| [pi-durable](https://github.com/zzjcool/pi-durable) | 引擎：append-only 会话、记忆、agent 循环、压缩 |

## 约定

沿用 pi-durable / pi-async / pi-legion 的家规：TypeScript strict、ESM、无构建步骤（`node --experimental-strip-types` 直接跑 `.ts`）、相对 import 带 `.ts` 后缀、测试用 `node:test`、零运行时依赖（Node builtins only）。
