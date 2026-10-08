import * as path from "node:path";
import { validateConfig, MachineConfig } from "./enigma";
import { Store, oneShot } from "./store";

const DATA_DIR = process.env.ENIGMA_DATA_DIR || path.join(process.cwd(), "data");
const DB_PATH = process.env.ENIGMA_DB || path.join(DATA_DIR, "enigma.db");

function parseConfig(args: Record<string, string>): MachineConfig {
  return validateConfig({
    rotors: (args.rotors || "I,II,III").split(",").map((s) => s.trim()),
    ring: args.ring || "AAA",
    positions: args.positions || "AAA",
    plugboard: args.plugboard ? args.plugboard.split(",").map((s) => s.trim()) : [],
  });
}

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const kv: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      kv[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
    } else positional.push(argv[i]);
  }
  return { positional, kv };
}

function show(x: any) { console.log(JSON.stringify(x, null, 2)); }

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { positional, kv } = parseArgs(rest);

  switch (cmd) {
    case "validate": {
      show({ ok: true, config: parseConfig(kv) });
      break;
    }
    case "encrypt": {
      const cfg = parseConfig(kv);
      const text = positional.join(" ") ?? "";
      const r = oneShot(cfg, text, kv.explain === "true");
      console.log(r.output);
      if (kv.explain === "true") show(r.steps);
      break;
    }
    case "new": {
      const store = new Store(DB_PATH);
      show(store.createExperiment(parseConfig(kv)));
      store.close();
      break;
    }
    case "append": {
      // append <id> <requestId> <text...> [--version N] [--explain]
      const store = new Store(DB_PATH);
      const id = Number(positional[0]);
      const exp = store.getExperiment(id);
      const version = kv.version !== undefined ? Number(kv.version) : exp.version;
      const r = store.processChunk(id, positional[1], positional.slice(2).join(" "), version, kv.explain === "true");
      show(r);
      store.close();
      break;
    }
    case "state": {
      const store = new Store(DB_PATH);
      show(store.getExperiment(Number(positional[0])));
      store.close();
      break;
    }
    case "trace": {
      const store = new Store(DB_PATH);
      show(store.getCharTrace(Number(positional[0]), Number(positional[1])));
      store.close();
      break;
    }
    case "log": {
      const store = new Store(DB_PATH);
      show(store.getLog(Number(positional[0]), Number(kv.page || 1), Number(kv.size || 50)));
      store.close();
      break;
    }
    case "reset": {
      const store = new Store(DB_PATH);
      const old = store.getExperiment(Number(positional[0]));
      show(store.createExperiment(old.config));
      store.close();
      break;
    }
    case "report": {
      const store = new Store(DB_PATH);
      show(store.getReport(Number(positional[0])));
      store.close();
      break;
    }
    case "demo": {
      const cfg = validateConfig({ rotors: ["I", "II", "III"], ring: "AAA", positions: "AAA", plugboard: [] });
      const r1 = oneShot(cfg, "AAAAA");
      console.log(`已知向量: AAAAA -> ${r1.output}（期望 BDZGO）`);
      const cfg2 = validateConfig({ rotors: ["I", "II", "III"], ring: "AAA", positions: "ADU", plugboard: [] });
      const m = new (require("./enigma").EnigmaMachine)(cfg2);
      const { processText } = require("./enigma");
      const r2 = processText(m, "AAA");
      console.log("双步进演示（窗口 ADU 起，输入 AAA）:");
      for (const s of r2.steps) {
        console.log(`  ${s.input} -> ${s.output}  窗口 ${s.windowBefore} -> ${s.windowAfter}`);
      }
      console.log("期望窗口序列: ADV, AEW, BFX");
      break;
    }
    default:
      console.log(`用法: node dist/src/cli.js <命令>
  validate  --rotors I,II,III --ring AAA --positions AAA [--plugboard AB,CD]
  encrypt   [--rotors ...] [--ring ...] [--positions ...] [--plugboard ...] [--explain] <文本>
  new       同上参数，新建实验
  append    <实验id> <请求号> <文本> [--version N] [--explain]
  state     <实验id>
  trace     <实验id> <字母序号>
  log       <实验id> [--page N] [--size N]
  reset     <实验id>            以相同配置新建实验
  report    <实验id>
  demo      已知向量与双步进演示`);
  }
}

main().catch((e) => {
  console.error(e.code ? `[${e.code}] ${e.message}` : e);
  process.exit(1);
});
