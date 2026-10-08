import { parseArgs } from "node:util";
import { EnigmaStore, defaultDbPath, ApiError } from "./db.js";
import { validateConfig, processText, MachineConfig } from "./enigma.js";
import { startServer } from "./server.js";

function configFromFlags(values: Record<string, unknown>): MachineConfig {
  const rotors = String(values.rotors ?? "I,II,III").split(",").map((s) => s.trim().toUpperCase());
  const plugsRaw = String(values.plugs ?? "").trim();
  return {
    rotors: rotors as [string, string, string],
    rings: String(values.rings ?? "AAA").toUpperCase(),
    positions: String(values.positions ?? "AAA").toUpperCase(),
    plugboard: plugsRaw ? plugsRaw.split(",").map((s) => s.trim().toUpperCase()) : [],
  };
}

const USAGE = `用法: node dist/src/cli.js <命令> [选项]

命令:
  serve      启动 HTTP API（--port N，默认 0 表示自动选择空闲端口；--db 路径）
  validate   验证配置（--rotors I,II,III --rings AAA --positions AAA --plugs AB,CD）
  once       一次性加解密（配置选项 + --text 文本）
  create     新建实验（配置选项），输出实验 id
  append     追加分块（--exp id --text 文本 --request-id 号 --version n）
  chars      查看字符日志（--exp id [--offset n] [--limit n] [--explain]）
  path       查询第 n 个加密字符的完整电路路径（--exp id --index n）
  reset      重置实验为新状态（--exp id，可选新配置选项）
  export     导出实验报告 JSON（--exp id）
  list       列出全部实验
  demo       运行内置演示（已知向量 BDZGO + 双步进 ADV/AEW/BFX）
`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "--help") { console.log(USAGE); return; }
  const { values } = parseArgs({
    args: rest,
    options: {
      port: { type: "string" }, db: { type: "string" },
      rotors: { type: "string" }, rings: { type: "string" }, positions: { type: "string" }, plugs: { type: "string" },
      text: { type: "string" }, exp: { type: "string" }, "request-id": { type: "string" },
      version: { type: "string" }, index: { type: "string" },
      offset: { type: "string" }, limit: { type: "string" }, explain: { type: "boolean" },
    },
    strict: false,
  });
  const dbPath = (values.db as string) ?? defaultDbPath();

  if (cmd === "demo") { runDemo(); return; }
  if (cmd === "validate") {
    const v = validateConfig(configFromFlags(values));
    console.log(JSON.stringify(v.ok ? { valid: true, config: v.config.raw } : { valid: false, errors: v.errors }, null, 2));
    process.exitCode = v.ok ? 0 : 1;
    return;
  }
  if (cmd === "once") {
    const v = validateConfig(configFromFlags(values));
    if (!v.ok) { console.error("配置无效: " + v.errors.join("；")); process.exitCode = 1; return; }
    const text = String(values.text ?? "");
    const r = processText(v.config, v.config.positions, text);
    console.log(JSON.stringify({
      ciphertext: r.output,
      windowBefore: v.config.raw.positions,
      windowAfter: r.endWindows.map((i) => String.fromCharCode(i + 65)).join(""),
    }, null, 2));
    return;
  }

  const store = new EnigmaStore(dbPath);
  try {
    switch (cmd) {
      case "serve": {
        const port = values.port !== undefined ? Number(values.port) : 0;
        const actual = await startServer(store, port);
        console.log(`Enigma API 已启动: http://127.0.0.1:${actual} （数据库: ${dbPath}）`);
        return; // 保持进程运行
      }
      case "create":
        console.log(JSON.stringify(store.createExperiment(configFromFlags(values)), null, 2));
        break;
      case "list":
        console.log(JSON.stringify(store.listExperiments(), null, 2));
        break;
      case "append": {
        const out = store.append(
          String(values.exp ?? ""), values.text !== undefined ? String(values.text) : undefined,
          values["request-id"] !== undefined ? String(values["request-id"]) : undefined,
          values.version !== undefined ? Number(values.version) : undefined,
        );
        console.log(JSON.stringify(out, null, 2));
        break;
      }
      case "chars":
        console.log(JSON.stringify(store.listChars(String(values.exp ?? ""),
          Number(values.offset ?? 0), Number(values.limit ?? 100), Boolean(values.explain)), null, 2));
        break;
      case "path":
        console.log(JSON.stringify(store.getCharPath(String(values.exp ?? ""), Number(values.index ?? 0)), null, 2));
        break;
      case "reset":
        console.log(JSON.stringify(store.reset(String(values.exp ?? ""), values.rotors !== undefined ? configFromFlags(values) : undefined), null, 2));
        break;
      case "export":
        console.log(JSON.stringify(store.exportReport(String(values.exp ?? "")), null, 2));
        break;
      default:
        console.error(`未知命令: ${cmd}\n${USAGE}`);
        process.exitCode = 1;
    }
  } finally {
    if (cmd !== "serve") store.close();
  }
}

function runDemo() {
  const v = validateConfig({ rotors: ["I", "II", "III"], rings: "AAA", positions: "AAA", plugboard: [] });
  if (!v.ok) throw new Error("内置配置无效");
  const r1 = processText(v.config, v.config.positions, "AAAAA");
  console.log(`[已知向量] I,II,III / AAA / AAA / 无插线，输入 AAAAA -> ${r1.output}（期望 BDZGO）`);
  const v2 = validateConfig({ rotors: ["I", "II", "III"], rings: "AAA", positions: "ADU", plugboard: [] });
  if (!v2.ok) throw new Error("内置配置无效");
  const r2 = processText(v2.config, v2.config.positions, "AAA");
  console.log("[双步进] 窗口 ADU 连续输入 3 字母，步进后窗口依次为: " +
    r2.entries.map((e) => e.windowAfter).join(" -> ") + "（期望 ADV -> AEW -> BFX）");
  console.log(`[双步进] 密文: ${r2.output}`);
  console.log(`[电路示例] 第 1 个字符路径: ${JSON.stringify(r2.entries[0].trace)}`);
}

main().catch((err) => {
  if (err instanceof ApiError) {
    console.error(`错误 [${err.code}] ${err.message}`);
  } else {
    console.error(err instanceof Error ? err.message : String(err));
  }
  process.exitCode = 1;
});
