# DSH Bridge — Codex ↔ DeepSeek Harness 会话互联桥

把 **Codex 的一个已有会话**和 **DeepSeek Harness 的一个已有会话**连起来，让两端能互相派活、
回传结果、多轮往返。不改动 Codex，也不改动 DSH。

- 打开一个网页，看到两端所有会话，点选两个，建立连接
- 之后 Codex 可以派任务给 DSH，DSH 完成后结果自动回传
- 角色可互换：谁当产品经理、谁当执行者只取决于你往哪边发

> **本项目绝大部分代码由 AI 编写。** 具体分工见[作者与来源](#作者与来源)。
> 请把它当作**经过测试但仍在演进**的工具使用，不要直接用在不可回退的生产任务上。

---

## 目录

- [它解决什么问题](#它解决什么问题)
- [工作原理](#工作原理)
- [环境要求](#环境要求)
- [快速开始](#快速开始)
- [网页连接台](#网页连接台)
- [命令行接口](#命令行接口)
- [HTTP 接口](#http-接口)
- [任务协议](#任务协议)
- [主要参数](#主要参数)
- [安装位置无关性](#安装位置无关性)
- [投递语义](#投递语义)
- [测试](#测试)
- [已知限制](#已知限制)
- [后续开发](#后续开发)
- [作者与来源](#作者与来源)
- [许可](#许可)

---

## 它解决什么问题

Codex 和 DeepSeek Harness 各自都是好用的编码代理，但它们是两个孤岛：各自的会话有各自的上下文，
你只能人工在两边复制粘贴。本项目在两个**已经存在的**会话之间架一条双向通道：

| 能力 | 说明 |
|---|---|
| 绑定已有会话 | 用精确 ID 指定，不新建、不切换、不猜 |
| 双向派活 | Codex → DSH，DSH → Codex |
| 自动回传 | DSH 完成一轮后，结果自动回到 Codex 会话 |
| 多轮往返 | 上下文各自保留，可连续协作 |
| 角色互换 | 两端对称，方向只取决于你发给谁 |

**它不是**：不是聊天记录同步器，不是把两个会话合并成一个，也不是让两个模型互相聊天的玩具。
每次投递都是一次真实的任务派发。

---

## 工作原理

```
┌─────────┐                    ┌──────────────────┐                    ┌──────────┐
│  Codex  │ ←── codex queue ── │  broker (8791)   │ ── session/prompt →│   DSH    │
│  会话    │ ── rollout 读取 ─→ │  配对 / 中继 /    │ ←─ 会话日志 ────── │   会话    │
└─────────┘                    │  去重 / 任务状态   │                    └──────────┘
      ↑                        └──────────────────┘                          ↑
      │                                 ↑                                    │
      │                        ┌──────────────────┐                          │
      └──── 浏览器 ────────────│ console (8792)   │──────── 浏览器 ───────────┘
                               │ 会话列举 / 配对管理 │
                               └──────────────────┘
```

两个进程，职责分离：

- **broker（8791）**：唯一的中继所有者。持有配对状态、轮询 DSH 回合边界、按任务关联回传、
  维护去重游标。必须只有一个实例——两个实例会互相覆盖游标，导致重复投递。
- **console（8792）**：网页界面。只做会话列举和配对管理，**不当中继**。
  发消息时转投 broker 的 `/send-task`，让 broker 登记关联任务并负责回传。

两端各自用的官方机制：

| 方向 | 机制 | 依据 |
|---|---|---|
| Codex → DSH | DSH 自己的 JSON RPC 信道 `POST /api/session/prompt` | Web 客户端用的同一个接口 |
| DSH → Codex | Codex 官方 CLI `codex queue --thread <UUID> --message <TEXT>` | CLI 自带的既有会话投递原语 |
| 读 DSH 答复 | 会话日志 `session.vN.jsonl.zstd`（多帧 zstd） | DSH 的持久化格式 |
| 读 Codex 会话 | `<CODEX_HOME>/state_*.sqlite` 的 `threads` 表（只读） | Codex 的本地状态库 |
| 判断消费 | Codex rollout JSONL 里是否出现消息 ID | 接收方的持久化证据 |

**没有为 Codex 或 DSH 写任何协议适配器**：两端本来就有可编程接口，本项目只是把它们连起来。

---

## 环境要求

| 项 | 要求 |
|---|---|
| 操作系统 | Windows 10/11（当前实现依赖 Windows 进程查询与 `codex.exe` 路径约定） |
| Node.js | **≥ 22**（`node:sqlite` 与 `node:zlib` 的 zstd 支持需要 22+，实测 24.20） |
| Python | 可选，仅启动脚本需要。实测 3.12 |
| Codex | 桌面版或 CLI，需已登录并使用过（产生 `state_*.sqlite` 与 rollout） |
| DeepSeek Harness | 桌面版正在运行（Web 服务监听 `127.0.0.1:19387`） |

**不需要**给 Codex 或 DSH 安装任何插件。DSH 原生工具插件（`plugin/`）是可选的快捷入口。

---

## 快速开始

```powershell
git clone https://github.com/aiaixxx1e/dsh-bridge.git
cd dsh-bridge

# 方式一：双击（Windows）
scripts\start-bridge.bat

# 方式二：Python
python scripts\start-bridge.py --open

# 方式三：PowerShell（无需 Python）
pwsh -NoProfile -File scripts\start-console.ps1 -Open
```

启动后会打印：

```
broker  8791: started
console 8792: started

  open this: http://127.0.0.1:8792/
  sessions : codex=27, dsh=15
```

打开 `http://127.0.0.1:8792/` 即可。

---

## 网页连接台

页面结构：

```
┌─ Codex 会话 ─────────────┐  ┌─ DSH 会话 ──────────────┐
│ [过滤框]                 │  │ [过滤框]                 │
│ 00000000… 查找Codex与…   │  │ session-0000… [top-level]│
│ 00000001… 将图片表格…    │  │ 00000002…     [subagent] │
└──────────────────────────┘  └──────────────────────────┘
        [ 连接所选两个会话 ]
┌─ 已建立的连接 ──────────────────────────────────────┐
│ pair-1  Codex 00000000… ↔ DSH session-0000…  [解除] │
└─────────────────────────────────────────────────────┘
▸ 位置诊断（安装位置无关性）
```

规则：

- **只接受精确 ID。** 过滤框只过滤显示，**不会**替你自动选中任何会话。
- 点一行选中（高亮），再点取消。
- DSH 的**子代理会话灰显不可选**（`bindable: false`）。
- 连接前会二次确认，明确列出将要绑定的两个 ID 与标题。
- 解除连接**不会**删除任何会话，只解除配对。
- 底部「位置诊断」显示每个路径**实际采用了哪条证据、还试过哪些**。

---

## 命令行接口

```powershell
node src\broker.mjs sessions [codex|dsh|both] [--filter TEXT]   # 列会话
node src\broker.mjs bind <pairId> --codex <exactId> --dsh <exactId>
node src\broker.mjs send-task <pairId> (--body-file F | --stdin | <text...>) [--task-id ID] [--steer]
node src\broker.mjs status [taskId]        # 任务与消息状态
node src\broker.mjs reconcile              # 处理中断的投递
node src\broker.mjs confirm [messageId]    # 有消费证据才转 completed
node src\broker.mjs read-body <messageId>  # 带 sha256 校验读回正文
node src\broker.mjs serve [--port 8791] [--interval-ms 3000] [--log FILE]

# 旧版整轮中继（默认关闭，需配对显式开启）
node src\broker.mjs init | list | threads | send | to-codex | tick | backfill
```

---

## HTTP 接口

默认只听 `127.0.0.1`。

### broker（8791）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/status` | 配对与计数 |
| GET | `/sessions?side=codex\|dsh\|both&filter=` | 两端会话清单 |
| POST | `/bind` | `{pairId, codex, dsh}`，**仅精确 ID** |
| POST | `/send-task` | `{pairId, text, taskId?, mode?}`，长正文走 JSON |
| GET | `/tasks` | 任务与消息状态 |
| POST | `/reconcile` | 处理中断投递 |
| POST | `/confirm` | `{messageId?}`，有证据才 completed |
| POST | `/to-dsh` | `{pairId, text, mode?}`，直投 DSH |
| POST | `/to-codex` | `{pairId, text}`，直投 Codex |
| POST | `/tick` | 手动触发一次中继 |

### console（8792）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 网页 |
| GET | `/api/sessions?filter=` | 两端会话 + 来源 + 告警 |
| GET | `/api/diagnostics` | 位置发现结果与尝试过的候选 |
| GET | `/api/pairs` | 已建立的连接 |
| POST | `/api/pairs` | `{codex, dsh, pairId?}` |
| DELETE | `/api/pairs/<id>` | 解除连接 |
| POST | `/api/send` | `{pairId, text}`，经 broker 派活 |
| GET | `/api/broker` | broker 是否存活 |

---

## 任务协议

### 消息信封

```jsonc
{
  "messageId": "…",        // 稳定身份，接收侧据此幂等去重
  "taskId":    "…",        // 所属任务
  "replyTo":   "…",        // 回复哪条消息
  "pairId":    "…",        // 走哪条配对
  "sender":    "codex" | "dsh",
  "kind":      "task" | "result" | "question" | "status" | "ack",
  "body":      { "path": "…", "bytes": 0, "chars": 0, "sha256": "…" }
}
```

正文**不进状态文件**，存在 `bodies/<messageId>.txt`，带 sha256。

### 回传必须显式标记

任务下行时正文自带一行：

```
[bridge-task <taskId>]
```

回传**必须同时满足**：

1. 回合已完成，且晚于任务发出时间
2. 正文**显式包含** `[bridge-task <同一 taskId>]`
3. 不是纯确认

因此：手工发出的内容、过程说明、点头式回复都**不会**被回传。
标记指向别的任务、或只有 `ack`，也不回传。回传成功后任务转 `answered`。

> 这条规则是踩坑后加的。早期实现是"存在 open 任务就回传任何已完成回合"，
> 结果同一份内容到对端两遍。见 `test/test-v2.mjs` 用例 i / j。

### 长消息

`codex queue` **只接受 `--message <TEXT>`**，无 stdin/文件入口。
实测 Windows `CreateProcess` 命令行上限：

```
8 KiB OK · 24 KiB OK · 30 KiB OK · 32 KiB FAIL (ENAMETOOLONG)
```

`execFile` 能避开 shell 转义，但**绕不过这个上限**。所以：

- 正文一律存文件（带 sha256）
- 超过内联阈值（默认 24000 字符）时**按序分片投递**，每片带
  `(messageId, part/total)`、字符总数、文件路径与哈希前缀
- **不截断**

DSH 方向无此限制：正文走 JSON over loopback HTTP，整段投递。

---

## 主要参数

### 启动器

| 参数 | 默认 | 说明 |
|---|---|---|
| `--port` | `8792` | 连接台端口 |
| `--broker-port` | `8791` | broker 端口 |
| `--state` | `./state.json` | 配对状态文件 |
| `--codex-home` | 自动发现 | Codex home（`~/.codex`） |
| `--dsh-home` | 自动发现 | DSH home（`~/.dsh`） |
| `--dsh-url` | `http://127.0.0.1:19387` | DSH Web 服务地址 |
| `--open` | 关 | 启动后开浏览器 |
| `--console-only` | 关 | 只启连接台 |
| `--status` / `--stop` | — | 查看状态 / 停止 |

### broker

| 参数 | 默认 | 说明 |
|---|---|---|
| `--port` | `8791` | 监听端口 |
| `--interval-ms` | `3000` | 轮询 DSH 回合边界的间隔 |
| `--log` | stdout | 追加日志文件 |
| `--replay` | 关 | 新建配对时回放历史（默认从当前回合开始） |

### 环境变量

| 变量 | 说明 |
|---|---|
| `CODEX_HOME` | Codex home；未设时用 `~/.codex` |
| `CODEX_CLI_PATH` | `codex.exe` 路径；未设时从运行中进程或安装目录发现 |
| `DSH_HOME` | DSH home；未设时用 `~/.dsh` |
| `DSH_WEB_URL` | DSH Web 地址 |
| `DSH_BRIDGE_STATE` | 状态文件路径 |
| `DSH_BRIDGE_BROKER_URL` | broker 地址（连接台用） |

### 代码内常量

| 常量 | 位置 | 默认 | 说明 |
|---|---|---|---|
| `INLINE_LIMIT` | `src/body-store.mjs` | `24000` | 单条内联投递的字符上限；超过则分片 |
| `DEFAULT_PORT` | `src/session-server.mjs` | `8792` | 连接台默认端口 |
| `DEFAULT_BROKER_PORT` | `src/session-server.mjs` | `8791` | broker 默认端口 |

broker 启动时会写一份发现文件 `$DSH_HOME/dsh-bridge.json`，让插件与连接台在
**不配置任何环境变量**的情况下找到它（记录 `brokerUrl` 与 `stateFile`）。

---

## 安装位置无关性

**默认路径一个都没用来做判断**，每个位置都走证据链，失败时列出所有尝试过的路径。

| 目标 | 顺序 | 实测命中 |
|---|---|---|
| Codex home | 覆盖 → `$CODEX_HOME` → `~/.codex` | `~/.codex`〔conventional default〕 |
| Codex 可执行 | 覆盖 → `$CODEX_CLI_PATH` → **运行中进程的 exe** → 探测安装根 | 运行中进程 |
| Codex 状态库 | **扫描 `*.sqlite` 探测 `threads` 表** | `state_5.sqlite` |
| DSH home | 覆盖 → `$DSH_HOME` → `~/.dsh` | 环境变量 |
| DSH 安装根 | 覆盖 → **运行中主进程的 exe 目录** → 探测常见根 | 运行中进程 |

### 三个真实的坑

**1. `CODEX_HOME` 在普通进程里不存在。** Codex 只把它设给自己的子进程。
它只出现在 `~/.codex/config.toml` 里——而那需要先知道 `~/.codex`，是循环依赖。

**2. Codex 可执行文件所在目录名是随机哈希，不能按名字或时间排序。**
实测 `bin/` 下有 4 个目录，**只有 1 个真含 `codex.exe`**；
按修改时间排"最新"的那个**恰恰不含**。唯一正确标准：里面有没有 `codex.exe`。

**3. 状态数据库文件名带 schema 版本**（`state_5.sqlite` 里的 `5`），升级后会变。
硬编码必坏，所以做法是列出 `*.sqlite`、逐个**只读**打开、探测 `threads` 表是否存在。

另外：DSH 的多个进程共用同一个 exe（渲染/工具/GPU 子进程），通过命令行里有没有
`--type=` 区分主进程，避免把子进程目录当安装根。

---

## 投递语义

**不宣称 exactly-once。**

| 状态 | 含义 |
|---|---|
| `pending` | 已登记，未投递 |
| `delivered` | 传输已受理（DSH `accepted:true` / `codex queue` 回执） |
| `completed` | **有消费证据**：回执 ID 出现在接收方自己的持久化日志里 |
| `uncertain` | 投递与落盘之间中断。必须先对账，**绝不当 completed** |
| `failed` | 未受理 |

- 接收侧按稳定 `messageId` 幂等去重
- 发送侧**先查落地记录再决定是否重试**
- 投递前先写 `delivering` 意图；崩溃后 `reconcile` 去接收方日志找证据，
  找到→`delivered`，找不到→`uncertain`，由人决定
- 跨进程写状态文件用文件锁（`wx` 创建 + pid 接管），并且**持锁重读再写**

---

## 测试

```powershell
node test\test-v2.mjs        # 10 个用例，注入传输 + 隔离状态
node test\test-relay.mjs     # 去重与并发
node test\probe-argv-limit.mjs <codexThreadId>   # 实测命令行上限
```

验收套件**严格区分真实与模拟**：

**真实**
- 命令行上限：30 KiB 通过 / 32 KiB `ENAMETOOLONG`
- 会话列举与精确选会话：真实查询
- `/send-task` 真实投递：`accepted=true` 并落入 DSH inbox，正文 sha256 逐字节校验

**模拟**（注入传输，隔离状态，不消耗对端额度、不污染真实会话）

| 用例 | 断言 |
|---|---|
| a | 5 个独立进程并发**首次**投递 → 恰好 1 次（不是靠已有去重键跳过） |
| b | 游标回退后不重发 |
| c | 投递/落盘窗口中断 → `uncertain`，绝不记 `completed` |
| d | 精确 ID 解析；失效 ID、子代理被拒 |
| e | 40,030 字符正文逐字节校验通过 |
| f | `ack` 终止；以 ack 开头的真实答复不被误吞 |
| g | 信封校验接受合规、拒绝违规 |
| h | 配对/任务持久化，且正文不写入状态文件 |
| i | 无标记不回传、任务保持 open；有标记回传一次、任务转 answered |
| j | 标记指向别的任务被拒 |

---

## 已知限制

1. **仅 Windows。** 依赖 Win32 进程查询与 `codex.exe` 路径约定。
2. **Codex 运行状态恒为 `unknown`。** `threads` 表没有这个字段；
   从时间戳猜"正在运行"是编造，所以不猜。
3. **全自动无人值守连续多轮未长跑。** 逻辑与验收都通过，长时间稳定性未观察。
4. **broker 是单实例设计。** 多实例会互相覆盖投递游标，脚本层面用"端口占用即复用"规避，
   但没有跨机器/跨用户的分布式锁。
5. **连接台不自动刷新**，需点「刷新会话」；会话多时未分页。
6. **MCP 未实现**（见后续开发）。
7. **会话选择依赖本地状态库可读。** 库被独占锁定时会回退到 `session_index.jsonl`，
   此时工作区等字段标 `unknown`。
8. **没有对 DSH 会话内容做脱敏**：中继会把整轮答复投给 Codex。请自行确认内容可外发。

---

## 后续开发

按优先级排列。

### P0 — 让它更通用

- **跨平台**：把 `src/resolvers.mjs` 里的进程查询与路径探测抽象成平台适配层
  （macOS `ps`、Linux `/proc`）。目前 `--stop` 与进程发现是 Windows 专属。
- **MCP 接入**：暴露 `list_sessions` / `list_pairs` / `bind_pair` / `send_task` /
  `get_task` / `reply_task`，复用同一 broker。注意 MCP 通常需**新会话或重启**才能加载，
  当前会话不会自动长出工具。
- **数据库版本无关性再加固**：目前靠探测 `threads` 表；若 Codex 改列名会退化到索引回退，
  建议增加列级探测并按可用列构造查询。

### P1 — 让它更省心

- **连接台开机自启**：broker 已有计划任务，连接台还没有。
- **连接台的"向 Codex 发消息"入口**：目前只能经 broker `/to-codex` 或 DSH 插件。
- **状态文件迁移**：`state.json` schema 变更时的版本迁移工具。
- **失败重试策略可配**：目前是下一轮中继重试，没有退避上限。

### P2 — 让它更可靠

- **长跑观测**：连续多轮往返的稳定性、内存增长、日志轮转。
- **正文仓库清理**：`bodies/` 目前只增不删，需要保留策略。
- **`uncertain` 的人工处置界面**：现在只有 CLI，建议进连接台。
- **多配对并发压测**：当前测试主要覆盖单配对。

### 代码结构（给后续开发者）

```
src/resolvers.mjs       位置发现：证据链，无默认路径假设。改这里做跨平台
src/adapters.mjs        两端会话列举 + 消费证据查询。加新元数据源改这里
src/envelope.mjs        消息信封、kind 语义、ack 判定、任务标记。改协议改这里
src/tasks.mjs           任务状态机、投递语义、对账、回传决策
src/body-store.mjs      正文存储与分片。改内联阈值改这里
src/broker.mjs          配对、中继、HTTP/CLI 入口
src/session-server.mjs  连接台（网页 + 管理 API），故意不当中继
src/client.mjs          DSH HTTP 客户端（含本地 cookie 签发）
src/session-log.mjs     多帧 zstd 会话日志解码
src/extract.mjs         回合边界提取
plugin/                 DSH 原生工具插件（codex_send / codex_pairs），可选
test/                   验收套件
scripts/                启动脚本
docs/                   设计文档
```

**改动时请守住几条不变量**（都对应真实踩过的坑）：

1. 中继只有一个所有者。
2. 回传必须由显式任务标记驱动，不做关键词推断。
3. 状态文件写入必须持锁重读。
4. 拿不到消费证据就不能标 `completed`。
5. 长正文不截断。
6. 只按精确 ID 绑定会话。

---

## 作者与来源

| 角色 | 贡献 |
|---|---|
| **DeepSeek**（AI，主要开发） | 架构落地、全部代码实现、实测与调试、踩坑定位与修复 |
| **ChatGPT / Codex**（AI，需求与评审） | 需求澄清与方案确认、设计评审、派活协议设计；实测中发现并指出两个真实缺陷（`DSH_HOME` 回退缺失、跨进程游标回退导致重复投递） |
| **项目发起人与人类维护者** | 提出需求与最终形态、提供测试环境与授权、功能验收；隐私清理与发布决策 |

**如实说明：本项目的代码与文档绝大部分由 AI（DeepSeek 与 ChatGPT/Codex）生成**，
人类作者负责需求、验收与发布。AI 生成内容可能存在错误或过时信息，
本仓库中的"实测"结论均标注了具体命令与数值，但**不构成任何担保**。

上游依赖与参考：

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — 会话服务、插件体系、
  会话日志格式、Web RPC 信道
- Codex CLI — `queue` / `resume` / `app-server` 等既有会话接口；本地状态库与 rollout 格式

本项目不包含上述任何项目的代码，仅通过它们的公开接口与本地文件交互。

---

## 许可

**PolyForm Noncommercial License 1.0.0 + 强著佐权附加条款。**

- ✅ 允许非商业用途、允许修改、允许分发
- ❌ 禁止任何商业用途
- ⚠️ **二次修改必须开源**，必须署名，不得附加更严格限制

详见 [LICENSE](LICENSE)。商业授权需另行联系。
