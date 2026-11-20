# 记忆系统设计（v4 提案）

> 目标不是"多存一点"，是让 agent **在需要时能把很久以前的事找回来**，
> 并且在空闲时自己整理。pi-durable 的 `remember/recall` 不够，这一层要重做。

## 1. 你的想法（原话拆解）

1. 所有上下文进 SQLite。
2. 给 agent 一个**搜索工具**，让它自己找记录。
3. 主对话窗口只留最新的，更早的只在库里。
4. 定时/空闲时自动压缩持久化——**做梦机制**。
5. 一个 **focus 面板**：它在干什么、有什么待办。
6. agent 的上下文也要自动梳理。

这和 2024–2026 年几个主流方案撞在同一条线上，而且撞得很准。

## 2. 外部先例（都查过）

| 方案 | 做法 | 对我们的意义 |
| --- | --- | --- |
| **MemGPT / Letta** | 把上下文当 RAM：system + core memory（persona/human）+ 最近消息 FIFO；溢出时**换页**到 archival storage，靠工具搜索取回 | 这正是"窗口只留最新 + 搜索工具"的原始论文。DMR 基准：**搜索检索 93.4%，递归摘要只有 35.3%** —— 摘要不是记忆 |
| **Letta sleep-time compute**（2025-04） | 空闲时让 agent 继续"想"：重排记忆、建立新连接、巩固最近交互 | "做梦"在学术上就是这个，且有 Pareto 提升的数据 |
| **OpenAI Dreaming**（2026-06） | 后台进程跨对话整合记忆、自动淘汰过时项，并提供**可审阅/编辑**的面板 | 做梦不是附属功能，是记忆系统的主体；而且必须可审阅 |
| **Generative Agents**（Stanford） | memory stream + 按 recency/relevance/importance 检索 + 周期性 reflection 生成高阶结论 | 检索打分和"反思"层，是我们打分和摘要的参照 |
| **Mem0 / Zep(Graphiti)** | 写时判定 ADD/UPDATE/DELETE；双时态图，旧事实失效而不删除 | 记忆要能**改**，不能只追加 |
| **现成 SQLite memory MCP**（agentmem / local-memory-mcp / memory-mcp） | 单文件 SQLite + FTS5/BM25，部分带向量与矛盾检测 | 说明单文件 SQLite 够用；也说明"只存笔记"会退化成 RAG |

一句话结论：**存全量 + 给搜索工具 + 窗口只留热的 + 空闲巩固**，是被反复验证过的形状；
pi-durable 只做到了"存全量"的一半。

## 3. 四条原则

1. **原文永不删**：日志是真相，SQLite 是它的索引和记忆层；DB 坏了可以重建。
2. **检索是 agent 的动作**，不是外部黑盒：有 `search_context` 工具，它自己决定搜什么。
3. **记忆可改**：新事实 supersede 旧事实（保留旧行 + 指向新行），不物理删除。
4. **巩固在空闲时做，且可审阅**：每次"做梦"有记录，能看见它改了什么。

## 4. 数据模型（`<agent>/memory.db`）

```sql
-- 原文镜像（由 events.jsonl 增量导入，可重建）
events(seq INTEGER PRIMARY KEY, ts TEXT, type TEXT, data TEXT NOT NULL);
turns(id INTEGER PRIMARY KEY, started_at TEXT, ended_at TEXT, user_text TEXT, assistant_text TEXT);

-- 记忆（权威，不在日志里）
memories(
  id TEXT PRIMARY KEY, kind TEXT,          -- fact|preference|decision|event|skill
  text TEXT NOT NULL, tags TEXT,           -- JSON array
  importance REAL DEFAULT 0.5,             -- 做梦时打分，召回时加权
  confidence REAL DEFAULT 0.8,
  created_at TEXT, updated_at TEXT,
  superseded_by TEXT,                      -- 非空 = 已过时
  source_from INTEGER, source_to INTEGER   -- 来自哪些 event seq（溯源）
);
memory_edges(from_id TEXT, to_id TEXT, kind TEXT);   -- supports|contradicts|derives

-- 分层摘要（自动梳理）
summaries(id TEXT PRIMARY KEY, level TEXT,  -- turn|day|topic
  from_seq INTEGER, to_seq INTEGER, text TEXT,
  created_at TEXT, supersedes TEXT);

-- focus / 待办
focus(id TEXT PRIMARY KEY, text TEXT,
  state TEXT,                              -- open|doing|blocked|done
  updated_at TEXT, source TEXT,            -- agent|dream|user
  seq INTEGER);                            -- 引出它的那一条

-- 检索
CREATE VIRTUAL TABLE events_fts USING fts5(body, tokenize='trigram');
CREATE VIRTUAL TABLE memories_fts USING fts5(text, tokenize='trigram');

-- 元数据
meta(key TEXT PRIMARY KEY, value TEXT);    -- schema_version, last_dream_seq, last_dream_at
dream_runs(id, started_at, ended_at, from_seq, to_seq, added, merged, superseded, summary_id, error);
```

**中文搜索的现实**（实测过，Node 22 自带 `node:sqlite` 支持 FTS5）：

- `tokenize='trigram'` 对中文**只支持 ≥3 字的查询**；`编译` 两字查不到，`上编译` 能查到。
- 所以：查询 ≥3 字走 FTS5，1–2 字回退 `LIKE '%q%'`（个人规模几千到几万条，毫秒级）。
- FTS5 的 MATCH 查询**必须转义**（`hw-` 会语法错误），统一包成 `"..."`。
- 网关没有 embeddings 接口（`/v1/embeddings` 404），所以 v1 是词法 + 时间/重要度加权；
  语义检索等有本地模型再说。

## 5. 每轮上下文怎么装配

```
system  = profile.md            （常驻画像，手工/做梦可改，几十行）
        + focus 里 open/doing 的前 5 条
        + memories 检索命中的前 8 条（按 关键词分 × 时间衰减 × importance）
        + "你有 search_context，可以从历史里找东西"
messages= 最近 K 轮原文（按字符预算，默认 ~40k）
        + 更早的只有一条 rolling summary（来自 summaries 表）
```

超过预算时：把最老的一段换成 summary（写 `compaction` 事件，`firstKeptSeq` 指向新窗口
起点——pi-durable 的 compaction 本来就是这个形状，我们只是自己决定何时压、压什么）。
**原文仍在 DB 里，agent 想得起就去搜。**

## 6. 工具（在现有 5 个上 +2）

| 工具 | 作用 |
| --- | --- |
| `search_context` | `{ query, limit?, kind?, after?, before? }` → 带时间戳和 seq 的片段，可继续 `before=` 翻页 |
| `remember` | 写一条记忆（kind/tags/importance），立即生效 |
| `focus_set` | 加/改/结一条 focus |
| `delegate` / `job_status` / `job_stop` / `recall` | 不变（`recall` 保留为快速路径） |

`search_context` 的返回要给足信息让模型判断相关性：`[2026-11-20 07:52 seq 41] …text…`
以及命中来自 memory 还是原文。

## 7. 做梦（idle consolidation）

**触发**：距上一轮 ≥10 分钟，或累计 ≥20 轮未整理；进程内定时器 + 启动时补一次。

**一次做梦做什么**（用便宜模型，JSON 输出，全程可回滚）：

1. 取 `seq > last_dream_seq` 的新事件，切成 10–20 条一批。
2. 抽候选事实/偏好/决定（带原文 seq 范围）。
3. **合并**：与既有记忆做相似判定——重复丢弃、补充则更新、矛盾则旧行 `superseded_by` 指向新行。
4. 更新 **focus**：过期项标 `done/blocked`，新出现的待办加进去。
5. 生成/刷新**分层摘要**（turn → day → topic），旧摘要可被新摘要 supersede。
6. 如果发现稳定的偏好/习惯变化，改写 `profile.md`（带 diff 记录）。
7. 写 `dream_runs`（做了几条、改了什么），失败只记错误，不动数据。

**不做的事**：不删原文、不重写历史事件、不做不可逆合并（合并=supersede，原文永远在）。

## 8. focus 面板

- 数据：`focus` 表 + `/api/focus`；页面右侧一列（窄屏折叠），显示 `doing` / `open` / 运行中的 worker。
- 谁写：agent 自己（`focus_set`）、做梦（整理/收尾）、你（点一下标 done）。
- 它不是 todo app：只放"它现在认为重要的事"，最多 10 条，超了由做梦合并。

## 9. 自动梳理（hierarchical summaries）

三层：`turn`（一轮一句）→ `day`（一天一段）→ `topic`（同一件事的多天合并）。
每个 summary 都带 `from_seq..to_seq`，能反查到原文。检索命中摘要时，可以顺着指针把原文捞出来。

## 10. 接缝

- `src/engine/durable.ts` 仍是唯一 import pi-durable 的文件；记忆层替换 `createMemoryStore`。
- `events.jsonl` 继续 append-only（真相）；`memory.db` 由它派生 + 存记忆/摘要/focus。
- 压缩通过写 `compaction` 事件实现，不改引擎。
- 老 agent 目录第一次升级时自动建库并回填全量事件（一次性迁移，可重复执行）。

## 11. 落地顺序

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| **M1 库与搜索** | SQLite schema、事件增量导入、`search_context`、`/api/search` 调试口 | 让它"找一下上周我们讨论过的 X"，它能搜到并引用 seq |
| **M2 窗口** | 预算装配 + 写 compaction + rolling summary | 关掉压缩也能聊；开着时窗口稳定在预算内，老话题靠搜索 |
| **M3 做梦** | 空闲触发、抽取/合并/supersede、focus 更新、dream_runs | 闲置 10 分钟后 `dream_runs` 有记录，focus 自己动了 |
| **M4 面板** | `/api/focus` + 右侧面板 + 记忆审阅（改/删/置顶） | 你能看见它在干什么，并纠正一条错记忆 |
| **M5 语义** | 本地 embedding 或外部 API，词法+向量混合 | 换个说法也能搜到（"编译慢" → "build 很久"） |

## 12. 风险与取舍

- **分词**：中文 <3 字只能 LIKE 扫描。个人规模可接受；涨到 10 万条再加 bigram 索引表。
- **成本**：做梦要调模型，用 flash + 小批量；一次做梦控制在几万 token 内。
- **过度整理**：做梦可能把细节压没。对策：只读摘要、细节靠搜索，且原文永不删。
- **记忆污染**：错误事实会被反复召回。对策：importance/confidence + 可审阅面板 + supersede 链。
- **确定性**：每轮到底注入了哪些记忆要可查（`context_manifest`），否则出了问题没法复盘。
