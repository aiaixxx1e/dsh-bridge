# 连接台设计说明（Codex ↔ DeepSeek Harness）

## 你要的形态

```
启动服务  ->  打开网页  ->  看到两端会话 ID  ->  点选连接  ->  两个会话能互相沟通
```

已实现：`start-console.ps1` 启动，浏览器打开 `http://127.0.0.1:8792/`。

页面结构：左栏 Codex 会话、右栏 DSH 会话，各自带过滤框；点一行选中（再点取消）；
下方「连接所选两个会话」；再下面是已建立的连接，可解除。底部可展开**位置诊断**。

---

## 一、安装位置无关性（你最关心的部分）

这是设计重点。**默认路径一个都没用来做判断**，每一层都是"证据链"，并且失败时
把尝试过的路径全部列出来，而不是给个空列表。

### 逐项证据链

| 目标 | 顺序 | 实际命中 |
|---|---|---|
| Codex home | 显式覆盖 → `$CODEX_HOME` → 常规默认 `~/.codex` | `<CODEX_HOME>`〔conventional default〕 |
| Codex 可执行 | 显式覆盖 → `$CODEX_CLI_PATH` → **运行中进程的 exe 路径** → 探测安装根 | `...\bin\5ea220ae823df3d7\codex.exe`〔**running process**〕 |
| Codex 状态库 | **扫描 `*.sqlite` 并探测 `threads` 表** | `state_5.sqlite`（has threads） |
| DSH home | 显式覆盖 → `$DSH_HOME` → 常规默认 `~/.dsh` | `<DSH_HOME>`〔environment variable〕 |
| DSH 安装根 | 显式覆盖 → **运行中主进程的 exe 目录** → 探测常见根 | `...\Programs\DeepSeek Harness`〔**running process**〕 |

### 三个真实的坑（都实测过，不是推测）

**1. `CODEX_HOME` 在普通进程里根本不存在。**
Codex 只把它设给自己的子进程。我在本会话实测：环境变量里**没有** `CODEX_HOME`。
而且它只出现在 `~/.codex/config.toml` 里——那需要先知道 `~/.codex` 才行，是个循环。
所以 `~/.codex` 作为默认值保留，同时把**运行中进程**作为更强证据。

**2. Codex 可执行文件所在目录名是随机哈希，不能按名字排序。**
实测 `bin/` 下有 4 个目录：`26f5cb65bac96647`、`34ab3e1324cc55b5`、`5b9024f90663758b`、
`5ea220ae823df3d7`——**只有 1 个真的含 `codex.exe`**，而且按修改时间排"最新"的那个
恰恰**不含**可执行文件。所以选目录的唯一正确标准是：**里面有没有 `codex.exe`**。

**3. 状态数据库文件名带 schema 版本，会随升级变化。**
`state_5.sqlite` 里的 `5` 是版本号，Codex 升级后可能变成 `state_6`。
硬编码必坏，所以做法是：列出 `*.sqlite`，逐个以**只读**方式打开，
探测是否存在 `threads` 表，命中者胜出。文件名只用来排序优先级，不参与判定。

### 其它稳健性处理

- **路径清理**：命令行里的路径带引号和 `\\?\` 前缀，统一剥离后再判断存在性。
- **主进程识别**：DSH 的多个进程共用同一个 exe（渲染/工具/GPU 子进程），
  通过命令行里有没有 `--type=` 区分主进程，避免把子进程目录当安装根。
- **完全可覆盖**：`--codex-home` / `--dsh-home` / `--codex-exe` / `--dsh-root` / `--dsh-url`
  以及对应环境变量，任何一项都能手工指定；诊断页会显示最终采用了哪一条证据。

---

## 二、服务分工（避免两个进程抢状态）

```
Codex  <──>  broker(8791)  <──>  DSH          broker 独占：中继、任务、去重游标
                  ^
                  | 转发（不是复制实现）
             console(8792)                     连接台：只做会话列举、配对管理、展示
```

**为什么不让连接台自己中继**：broker 已经常驻并持有同一份 `state.json`。
两个进程同时当中继，会互相覆盖投递游标——这正是之前踩到的重复投递 bug。
所以连接台**只写配对**，发消息时**转投 broker 的 `/send-task`**，
由 broker 登记关联任务并负责回传。

连接台发消息时会先探 broker 是否存活：

- broker 在 → 走 `/send-task`，返回 `via: "broker"`, `relayed: true`，**答复会被关联回传**
- broker 不在 → 直投 DSH，返回 `via: "direct"`, `relayed: false` 并**明确警告答复不会被回传**

这个降级是显式告知的，不是静默行为。

---

## 三、连接台 API

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/` | 网页界面 |
| GET | `/api/sessions?filter=` | 两端会话清单（含来源与告警） |
| GET | `/api/diagnostics` | 位置发现结果：每项的路径、来源、尝试过的候选 |
| GET | `/api/pairs` | 已建立的连接 |
| POST | `/api/pairs` | `{codex, dsh, pairId?}` —— **仅精确 ID** |
| DELETE | `/api/pairs/<id>` | 解除连接（不删除任何会话） |
| POST | `/api/send` | `{pairId, text}` —— 经 broker 派活 |
| GET | `/api/broker` | broker 是否存活 |

---

## 四、会话选择规则

- **只接受精确 ID**。标题片段命中会作为候选返回，但**绝不自动选中**。
- DSH 的**子代理会话标记为不可绑定**（`bindable: false`），页面上灰显且点不动。
- 失败时给出候选列表，便于纠正笔误。
- **运行状态**：DSH 有真值（`running`）；**Codex 一律 `unknown`**——
  `threads` 表没有运行状态字段，从时间戳猜"正在运行"是编造。

---

## 五、实测记录

| 项 | 结果 |
|---|---|
| 页面 | HTTP 200，12,482 字节 |
| Codex 会话列举 | **27 条**，来源 `sqlite:state_5.sqlite`（探测命中） |
| DSH 会话列举 | **15 条**，来源 `dsh:session/list`，子代理正确标为不可绑定 |
| Codex exe 定位 | 命中**运行中进程**路径（非默认路径推断） |
| DSH 安装根定位 | 命中**运行中主进程**目录 |
| 无效 DSH ID | 拒绝：`no dsh session with exact id …` |
| 子代理 ID | 拒绝：`is a subagent session and cannot be bound` |
| 无效 Codex ID | 拒绝：`no codex session with exact id …` |
| 建立连接 | 成功，写入配对并出现在列表 |
| 经连接台派活 | 成功 → `via: "broker"`, `relayed: true`，broker 登记 `task-20261006-be5bbeb9` |
| 解除连接 | 成功，仅剩原有 `demo` 配对 |
| 启动器 | 幂等：二次运行识别"已在监听"并复用 |

---

## 六、未做 / 已知限制

- 连接台与 broker 目前都是**本机进程**，未做 Windows 服务/开机自启（broker 有计划任务，连接台没有）。
- 页面**没有**"向 Codex 发消息"的按钮：往 Codex 投递需要 `codex queue`，
  且要遵循任务标记协议，目前走 broker 的 `/to-codex` 与 `codex_send`。
- Codex 的**运行状态恒为 unknown**（数据源限制，非实现遗漏）。
- 会话列表**不做自动刷新**，需点「刷新会话」；会话数量大时未做分页。
- 位置发现依赖 PowerShell 读取进程信息；若该命令被策略禁止，会回退到探测路径，
  并在诊断页显示 `process` 证据缺失。
