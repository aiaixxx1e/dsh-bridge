# 怎么启动

三种入口任选一种，效果相同：拉起 **连接台**（网页 8792）和 **broker**（中继 8791），然后打开页面。

## 方式一：双击（最简单）

打开文件夹 `.\`，**双击 `start-bridge.bat`**。

会自动开浏览器。窗口停在那不用管，可以最小化。

## 方式二：Python

```powershell
cd .
python start-bridge.py --open
```

不加 `--open` 就只打印网址，不弹浏览器。

## 方式三：PowerShell（无需 Python）

```powershell
pwsh -NoProfile -File .\start-console.ps1 -Open
```

`start-console.ps1` **只启连接台**；broker 一般不用手动启（已注册登录自启的计划任务），
要手动启就用 `start-broker.ps1`。

---

## 常用参数（Python 与 bat 通用）

| 命令 | 作用 |
|---|---|
| `--status` | 只看状态，什么都不改 |
| `--stop` | 停掉两个服务 |
| `--console-only` | 只启连接台，不启 broker |
| `--port 8899` | 换连接台端口 |
| `--broker-port 8898` | 换 broker 端口 |
| `--open` | 顺带打开浏览器 |

bat 的用法一样，例如 `start-bridge.bat --status`。
**只有在不带任何参数时** bat 才会自动加 `--open`，所以诊断类命令不会乱弹浏览器。

非默认安装位置的机器，发现失败时手动指定：

```powershell
python start-bridge.py --codex-home D:\x\.codex --dsh-home D:\x\.dsh --dsh-url http://127.0.0.1:19387 --open
```

---

## 幂等性

重复运行**安全**：已在监听的端口会被复用，不会起第二个实例。
两个中继共用同一份状态文件会互相覆盖投递游标（这是之前踩过的重复投递 bug），
所以脚本刻意保证每样只有一个。

```
broker  8791: already running
console 8792: already running
```

## 选择顺序

- `start-bridge.bat`：`py` → `python` → PowerShell 兜底
- 会挡住 Microsoft Store 的 `python3` 占位符（那个只会打开商店，不会执行脚本）

## 日志

- 连接台：`dsh-bridge\console.log`
- broker：`dsh-bridge\broker.log`

启动失败时看这两个文件。

## 实测记录

| 项 | 结果 |
|---|---|
| 冷启动（先停后启） | 成功，**3.35 秒**，页面 HTTP 200，会话 `codex=27, dsh=15` |
| 重复运行 | 复用，未产生第二个实例（各端口仍只 1 个监听） |
| `--status` | 正确报告状态 |
| `--stop` | 正确停止两个端口 |
| bat 无参数 | 走复用路径并打开浏览器 |
| bat `--status` | 只报状态，**未**打开浏览器 |
| PowerShell 兜底 | 正常 |
| `python -m py_compile` | 通过 |
