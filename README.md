# Enigma 三转子教学后端（TypeScript + Node.js + SQLite）

教学用 Enigma M3 三转子密码机后端：输入机器配置与文本，输出加密文本、窗口位置变化，以及任意一个字符的完整电路路径。仅提供 **HTTP API 与 CLI**，无前端。

## 教学边界（明确不做什么）

- 只支持转子 I、II、III 各用一次、固定反射器 B、最多 10 对插线。
- 不做密钥搜索、频率分析/破解，不做真实通信，不依赖 Docker/WSL/外部在线服务。
- 本工具仅用于演示双步进与正/反向接线原理，不具备任何现实安全性。

## 环境与命令

要求：Windows 本地、Node.js ≥ 22.5（使用内置 `node:sqlite`，目前为实验特性，会有一条无害警告）。除开发依赖 `typescript` / `@types/node` 外**零运行时依赖**。

```powershell
npm install        # 安装开发依赖
npm run build      # 编译 TypeScript 到 dist/
npm test           # 构建并运行全部测试（node:test）
npm start          # 启动 HTTP API（默认自动选择空闲端口）
npm run demo       # 运行内置演示（BDZGO 已知向量 + 双步进 ADV/AEW/BFX）
npm run cli -- <命令>   # 其他 CLI 命令
```

数据目录固定为项目内 `data/`（`data/enigma.db`），可用 `--db` 覆盖；不会把明文或演示数据写到项目外。

## 机器模型

- 字母 A–Z 对应 0–25。固定接线：
  - 转子 I：`EKMFLGDQVZNTOWYHXUSPAIBRCJ`，缺口 Q
  - 转子 II：`AJDKSIRUXBLHWTMCQGZNPYFVOE`，缺口 E
  - 转子 III：`BDFHJLCPRTXVZNYEIWGAKMUSQO`，缺口 V
  - 反射器 B：`YRUHQSLDPXNGOKMIEBFZCWVJAT`
- 配置按**左、中、右**排列：`rotors: ["I","II","III"]`；`rings` 与 `positions` 都是三个字母（环 A 表示零偏移）。接线表与规则版本（`enigma-m3-teaching-v1`）随每次导出报告保存。
- **双步进**（每处理一个字母前执行，全部判断基于同一旧窗口，先形成整套新窗口再放行信号）：
  1. 中转子正在自己的缺口 → 左转子前进一步；
  2. 右转子在缺口 **或** 中转子在缺口 → 中转子前进一步；
  3. 右转子每次都前进一步。
  因此中转子可能连续两步（窗口 ADU 连续输入 3 字母 → ADV、AEW、BFX）。缺口判断使用窗口可见字母，**不**再减环设置。
- **转子变换**：位置 p、环 r，偏移 s = p − r；正向 `W[(x+s) mod 26] − s`（再规范到 0–25），反向用 W 的逆置换、偏移处理相同。信号路径：插线 → 右中左正向 → 反射器 → 左中右反向 → 插线。
- **插线**：最多 10 对，禁止自配、重复与冲突（同一字母最多参与一对）。
- 文本中 ASCII 字母参与加密并保留原大小写；其他 Unicode 字符原样保留且**不推进窗口**；空文本返回空输出。
- 解密：用**相同初始配置**重新处理密文（新建/重置实验），而不是从上次结束位置继续。

## HTTP API

默认监听 `127.0.0.1`，`--port 0`（默认）自动选择空闲端口，启动时打印实际端口。所有错误返回 `{"error":{"code","message"}}`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 规则版本、接线表、限制值 |
| POST | `/api/validate` | 验证配置 `{config}` |
| POST | `/api/process` | 一次性计算 `{config, text}`，不落库 |
| POST | `/api/experiments` | 新建实验 `{config}`，返回 `id` 与 `version` |
| GET | `/api/experiments` / `/api/experiments/:id` | 列出 / 查询实验 |
| POST | `/api/experiments/:id/append` | 追加分块 `{text, requestId, version}` |
| GET | `/api/experiments/:id/chars?offset&limit&explain=true` | 字符日志分页（`explain` 附电路明细） |
| GET | `/api/experiments/:id/chars/:index` | 第 index 个加密字符的完整电路路径 |
| POST | `/api/experiments/:id/reset` | 重置为新实验状态（可带新 `config`），版本 +1 |
| GET | `/api/experiments/:id/export` | 导出报告（配置、规则版本、接线表、全部分块） |

错误码：`INVALID_CONFIG`(400)、`INVALID_REQUEST`(400)、`NOT_FOUND`(404)、`CONFLICT`(409，同请求号不同文本)、`VERSION_MISMATCH`(409，旧版本追加)、`PAYLOAD_TOO_LARGE`(413)、`INTERNAL`(500)。

限制：单次文本 ≤ 10000 字符、单块参与加密字母 ≤ 5000、单次返回电路明细 ≤ 1000 条（分页不影响实际步进与保存）。

## 持久化与一致性

- SQLite（WAL）原子保存：原文块、密文、初/末窗口、配置、请求号、逐字符轨迹，全部在一个事务内提交——**失败不会只推进窗口而丢输出**。
- 幂等：同一实验内 `requestId` 唯一；同号同文返回原结果（`replayed: true`），同号异文返回 `CONFLICT`。
- 乐观并发：`append` 必须携带当前 `version`，旧版本被拒绝且状态不变。
- 重启后继续流与连续执行完全一致；多个实验的窗口互不共享。

## CLI

```powershell
node dist/src/cli.js serve --port 0            # 启动 API
node dist/src/cli.js validate --rotors I,II,III --rings AAA --positions AAA --plugs AB,CD
node dist/src/cli.js once --positions ADU --text "AAAAA"
node dist/src/cli.js create --rotors I,II,III --rings AAA --positions AAA
node dist/src/cli.js append --exp <id> --text "AAAAA" --request-id r1 --version 0
node dist/src/cli.js chars --exp <id> --offset 0 --limit 10 --explain
node dist/src/cli.js path --exp <id> --index 0
node dist/src/cli.js reset --exp <id>
node dist/src/cli.js export --exp <id>
node dist/src/cli.js list
node dist/src/cli.js demo
```

## 已知向量与测试

`npm test` 覆盖：I,II,III / AAA / AAA / 无插线时 `AAAAA → BDZGO`；窗口 ADU 双步进序列 `ADV → AEW → BFX`；非 A 环设置、转子调序、插线、窗口 Z 回绕、标点不步进、大小写保留、无自加密、往返恢复、分块一致、非法配置无状态变动、重启恢复、逐字符电路路径、幂等与版本冲突。

## 项目结构

```
src/enigma.ts   # 核心：转子/反射器/双步进/正反向变换/逐字符轨迹
src/db.ts       # SQLite 持久层：实验、分块、字符日志、幂等与事务
src/server.ts   # node:http API
src/cli.ts      # 命令行入口
test/enigma.test.ts
```