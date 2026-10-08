import * as http from "node:http";
import * as path from "node:path";
import { EnigmaError, validateConfig } from "./enigma";
import { Store, oneShot } from "./store";

const DATA_DIR = process.env.ENIGMA_DATA_DIR || path.join(process.cwd(), "data");
const DB_PATH = process.env.ENIGMA_DB || path.join(DATA_DIR, "enigma.db");

function send(res: http.ServerResponse, status: number, body: any) {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(json);
}

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1_000_000) reject(new EnigmaError("TEXT_TOO_LARGE", "请求体过大", 413));
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); }
      catch { reject(new EnigmaError("INVALID_JSON", "请求体不是合法 JSON")); }
    });
    req.on("error", reject);
  });
}

export function createServer(store: Store) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const body = req.method === "POST" ? await readBody(req) : {};

      // POST /api/validate
      if (req.method === "POST" && url.pathname === "/api/validate") {
        const cfg = validateConfig(body.config ?? body);
        return send(res, 200, { ok: true, config: cfg });
      }
      // POST /api/encrypt 一次性计算
      if (req.method === "POST" && url.pathname === "/api/encrypt") {
        const cfg = validateConfig(body.config);
        if (typeof body.text !== "string") throw new EnigmaError("INVALID_TEXT", "缺少 text");
        const r = oneShot(cfg, body.text, !!body.explain);
        return send(res, 200, r);
      }
      // POST /api/experiments 新建实验
      if (req.method === "POST" && url.pathname === "/api/experiments") {
        const cfg = validateConfig(body.config ?? body);
        const exp = store.createExperiment(cfg);
        return send(res, 201, exp);
      }
      // GET /api/experiments
      if (req.method === "GET" && url.pathname === "/api/experiments") {
        return send(res, 200, store.listExperiments());
      }
      if (parts[0] === "api" && parts[1] === "experiments" && parts[2]) {
        const id = Number(parts[2]);
        if (!Number.isInteger(id)) throw new EnigmaError("INVALID_ID", "实验 id 非法");
        const sub = parts[3];
        // GET /api/experiments/:id
        if (req.method === "GET" && !sub) return send(res, 200, store.getExperiment(id));
        // POST /api/experiments/:id/process 追加文本块
        if (req.method === "POST" && sub === "process") {
          const exp = store.getExperiment(id);
          const version = body.version ?? exp.version;
          const r = store.processChunk(id, String(body.requestId ?? ""), String(body.text ?? ""), Number(version), !!body.explain);
          return send(res, 200, r);
        }
        // POST /api/experiments/:id/reset 以相同配置新建实验
        if (req.method === "POST" && sub === "reset") {
          const old = store.getExperiment(id);
          const fresh = store.createExperiment(old.config);
          return send(res, 201, fresh);
        }
        // GET /api/experiments/:id/chars/:seq
        if (req.method === "GET" && sub === "chars" && parts[4] !== undefined) {
          return send(res, 200, store.getCharTrace(id, Number(parts[4])));
        }
        // GET /api/experiments/:id/log?page=&size=
        if (req.method === "GET" && sub === "log") {
          return send(res, 200, store.getLog(id, Number(url.searchParams.get("page") || 1), Number(url.searchParams.get("size") || 50)));
        }
        // GET /api/experiments/:id/report
        if (req.method === "GET" && sub === "report") {
          return send(res, 200, store.getReport(id));
        }
      }
      throw new EnigmaError("NOT_FOUND", `未知路由 ${req.method} ${url.pathname}`, 404);
    } catch (e: any) {
      if (e instanceof EnigmaError) {
        return send(res, e.status, { error: { code: e.code, message: e.message } });
      }
      send(res, 500, { error: { code: "INTERNAL", message: String(e?.message || e) } });
    }
  });
}

if (require.main === module) {
  const store = new Store(DB_PATH);
  const server = createServer(store);
  const portArg = process.env.PORT ? Number(process.env.PORT) : 0; // 默认选择空闲端口
  server.listen(portArg, "127.0.0.1", () => {
    const addr = server.address() as any;
    console.log(`Enigma 服务已启动: http://127.0.0.1:${addr.port}  (数据库: ${DB_PATH})`);
  });
}
