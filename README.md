# Enigma 教学实验后端

教学用 Enigma 三转子密码机服务：输入机器配置与文本，输出加密文本、窗口位置变化与任意字符的完整电路路径。仅提供 **HTTP API 与 CLI**，无前端。

## 教学边界

- 只支持转子 I、II、III（各用一次）、固定反射器 B、最多 10 对插线。
- 不做密钥搜索、频率破解或真实通信，仅用于演示双步进与正反向接线原理。
- 明文与实验数据只写入项目内 `data/` 目录，不依赖 Docker、WSL 或任何在线服务。

## 环境要求

- Windows 本地，Node.js ≥ 22.5（使用内置 `node:sqlite`，零原生依赖）。
- 首次使用执行 `npm install`（仅安装 TypeScript 与类型定义）。

## 常用命令

```powershell
npm run build    # 编译 TypeScript 到 dist/
npm test         # 构建并运行全部测试（含已知向量与双步进向量）
npm start        # 启动 HTTP 服务（默认自动选择空闲端口，PORT=8080 可指定）
npm run cli -- demo   # 已知向量 + 双步进演示
```

## 机器模型

- 字母 A–Z 对应 0–25。转子接线：I=`EKMFLGDQVZNTOWYHXUSPAIBRCJ`，II=`AJDKSIRUXBLHWTMCQGZNPYFVOE`，III=`BDFHJLCPRTXVZNYEIWGAKMUSQO`；反射器 B=`YRUHQSLDPXNGOKMIEBFZCWVJAT`。
- 窗口缺口：I=Q、II=E、III=V。缺口判断使用可见窗口字母，**不减去环设置**。
- 配置顺序：`rotors` 按 **左、中、右** 排列；`ring` 与 `positions` 均为三个字母（A 表示 0 偏移），与转子一一对应。
- 转子顺序可变（如 `["III","I","II"]`），缺口与接线随转子身份走。

### 双步进规则（每个字母输入前）

所有判断基于**步进前的同一旧窗口**，先形成整套新窗口再通电：

1. 中转子在缺口 → 左转子前进一步；
2. 右转子在缺口 **或** 中转子在缺口 → 中转子前进一步；
3. 右转子每次都前进一步。

因此中转子可能连续两步步进。验证向量：窗口 `ADU` 起连续输入，步进后窗口依次为 `ADV`、`AEW`、`BFX`。

### 电路路径

对位置 p、环设置 r 的转子，偏移 s=p−r：

- 正向：`W[(x+s) mod 26] − s`（规范到 0–25）
- 反向：使用 W 的**逆置换**，偏移处理相同（不是再套一次正向）

信号顺序：插线 → 右中左正向 → 反射器 → 左中右反向 → 插线。

### 文本规则

- 仅 ASCII 英文字母参与加密，保留原大小写；其他 Unicode 字符原样保留且**不推进窗口**。
- 空文本返回空输出。单块文本上限 20000 字符。
- 解密：用**相同初始配置**重新处理密文（往返），不从上次结束位置继续。

## HTTP API

默认监听 `127.0.0.1` 空闲端口（启动日志打印实际端口），`PORT` 环境变量可指定。所有响应为 JSON，错误形如 `{"error":{"code":"...","message":"..."}}`。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/validate` | 校验配置 `{config}` |
| POST | `/api/encrypt` | 一次性计算 `{config, text, explain?}` |
| POST | `/api/experiments` | 新建实验 `{config}`，返回 `{id, version, window, ...}` |
| GET | `/api/experiments` / `/:id` | 列出 / 查询实验状态 |
| POST | `/api/experiments/:id/process` | 追加文本块 `{requestId, text, version, explain?}` |
| POST | `/api/experiments/:id/reset` | 以相同配置新建实验（重置） |
| GET | `/api/experiments/:id/chars/:seq` | 第 seq 个字母（0 起）的完整电路路径 |
| GET | `/api/experiments/:id/log?page=1&size=50` | 按字符分页的步进日志 |
| GET | `/api/experiments/:id/report` | 导出报告（配置、各块原文/密文、初末窗口） |

### 实验流与一致性

- 每个实验独立窗口，互不共享；分块追加不重置窗口，拼接结果等于整段处理。
- 每块须带 `requestId` 与 `version`：**同号同文**返回原结果（幂等），**同号异文**返回 `REQUEST_CONFLICT`（409），**旧版本追加**返回 `VERSION_CONFLICT`（409）。
- SQLite 事务原子保存原文块、密文、初末窗口、配置与请求号；失败不会只推进窗口而不保存输出。重启后继续流与连续执行一致。
- 解释明细（`explain`）按块限量（5000 字母），超出后仍完整记录步进与窗口，仅省略逐阶段明细。

### 错误码

`INVALID_CONFIG`、`INVALID_PLUGBOARD`、`INVALID_TEXT`、`TEXT_TOO_LARGE`、`INVALID_REQUEST`、`NOT_FOUND`、`REQUEST_CONFLICT`、`VERSION_CONFLICT`、`INVALID_JSON`、`INTERNAL`。

## CLI

```powershell
node dist/src/cli.js validate --rotors I,II,III --ring AAA --positions AAA --plugboard AB,CD
node dist/src/cli.js encrypt --positions MCK "Hello, World!"     # 一次性计算
node dist/src/cli.js new --rotors III,I,II --ring BCD --positions XYZ
node dist/src/cli.js append <实验id> <请求号> "文本" [--version N] [--explain]
node dist/src/cli.js state <实验id>
node dist/src/cli.js trace <实验id> <字母序号>     # 逐字符电路
node dist/src/cli.js log <实验id> --page 1 --size 50
node dist/src/cli.js reset <实验id>
node dist/src/cli.js report <实验id>
node dist/src/cli.js demo
```

## 已知验证向量

- 左中右 I、II、III，环 `AAA`，窗口 `AAA`，无插线：`AAAAA` → `BDZGO`。
- 窗口 `ADU` 起连续输入三字母，步进后窗口依次为 `ADV`、`AEW`、`BFX`（双步进）。

测试另覆盖：非 A 环设置、转子调序、插线校验（自配/重复/冲突/超量）、窗口 Z 回绕、标点不步进、大小写保留、不自加密、往返恢复、分块一致、非法配置无状态变动、重启恢复、多实验隔离、逐字符电路与分页日志。

## 数据目录

默认 `data/enigma.db`（项目内）。可用环境变量 `ENIGMA_DATA_DIR` 或 `ENIGMA_DB` 覆盖。

## 限制

- `node:sqlite` 在 Node 25 仍标记为实验性 API（启动时有 ExperimentalWarning，不影响功能）。
- 服务监听本机回环地址，无认证，仅供本地教学使用。
- 单块文本 20000 字符、插线 10 对、日志每页最多 200 条。
