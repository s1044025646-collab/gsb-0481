import http from "node:http";
import { EnigmaStore, ApiError, MAX_TEXT_LENGTH, MAX_BATCH_CHARS, MAX_EXPLAIN } from "./db.js";
import { validateConfig, processText, RULES_VERSION, WIRING_TABLE } from "./enigma.js";

const MAX_BODY = 1024 * 1024;

function send(res: http.ServerResponse, status: number, body: unknown) {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(json);
}
function sendError(res: http.ServerResponse, err: unknown) {
  if (err instanceof ApiError) return send(res, err.status, { error: { code: err.code, message: err.message } });
  send(res, 500, { error: { code: "INTERNAL", message: err instanceof Error ? err.message : String(err) } });
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new ApiError(413, "PAYLOAD_TOO_LARGE", "请求体超过 1MB 限制");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new ApiError(400, "INVALID_REQUEST", "请求体必须是合法 JSON"); }
}

export function createServer(store: EnigmaStore): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean); // e.g. ["api","experiments",":id","append"]
      const method = req.method ?? "GET";
      const body = method === "POST" || method === "PUT" ? await readBody(req) : {};

      if (method === "GET" && url.pathname === "/api/health") {
        return send(res, 200, { ok: true, rulesVersion: RULES_VERSION, wiringTable: WIRING_TABLE, limits: { MAX_TEXT_LENGTH, MAX_BATCH_CHARS, MAX_EXPLAIN } });
      }
      if (method === "POST" && url.pathname === "/api/validate") {
        const v = validateConfig((body as any).config);
        return v.ok
          ? send(res, 200, { valid: true, config: v.config.raw })
          : send(res, 200, { valid: false, errors: v.errors });
      }
      if (method === "POST" && url.pathname === "/api/process") {
        // 一次性计算：不落库、不影响任何实验状态
        const v = validateConfig((body as any).config);
        if (!v.ok) throw new ApiError(400, "INVALID_CONFIG", v.errors.join("；"));
        const text = (body as any).text;
        if (typeof text !== "string") throw new ApiError(400, "INVALID_REQUEST", "text 必须是字符串");
        if (text.length > MAX_TEXT_LENGTH) throw new ApiError(413, "PAYLOAD_TOO_LARGE", `文本长度超过限制 ${MAX_TEXT_LENGTH}`);
        const result = processText(v.config, v.config.positions, text);
        if (result.entries.length > MAX_BATCH_CHARS) throw new ApiError(413, "PAYLOAD_TOO_LARGE", `参与加密的字母数超过限制 ${MAX_BATCH_CHARS}`);
        return send(res, 200, {
          ciphertext: result.output,
          windowBefore: v.config.raw.positions,
          windowAfter: result.endWindows.map((i) => String.fromCharCode(i + 65)).join(""),
          encryptedChars: result.entries.length,
        });
      }
      if (method === "POST" && url.pathname === "/api/experiments") {
        return send(res, 201, { experiment: store.createExperiment((body as any).config) });
      }
      if (method === "GET" && url.pathname === "/api/experiments") {
        return send(res, 200, { experiments: store.listExperiments() });
      }
      if (parts[0] === "api" && parts[1] === "experiments" && parts[2]) {
        const id = parts[2];
        if (method === "GET" && parts.length === 3) return send(res, 200, { experiment: store.getExperiment(id) });
        if (method === "POST" && parts[3] === "append" && parts.length === 4) {
          const b = body as any;
          return send(res, 200, store.append(id, b.text, b.requestId, b.version));
        }
        if (method === "POST" && parts[3] === "reset" && parts.length === 4) {
          return send(res, 200, { experiment: store.reset(id, (body as any).config) });
        }
        if (method === "GET" && parts[3] === "chars" && parts.length === 4) {
          const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
          const limit = Math.max(1, Number(url.searchParams.get("limit") ?? 100) || 100);
          const explain = url.searchParams.get("explain") === "true";
          return send(res, 200, { chars: store.listChars(id, offset, limit, explain), offset, limit: Math.min(limit, MAX_EXPLAIN) });
        }
        if (method === "GET" && parts[3] === "chars" && parts[4] === undefined) { /* unreachable */ }
        if (method === "GET" && parts[3] === "chars" && parts.length === 5) {
          return send(res, 200, store.getCharPath(id, Number(parts[4])));
        }
        if (method === "GET" && parts[3] === "export" && parts.length === 4) {
          return send(res, 200, store.exportReport(id));
        }
      }
      throw new ApiError(404, "NOT_FOUND", `路由不存在：${method} ${url.pathname}`);
    } catch (err) {
      sendError(res, err);
    }
  });
}

export function startServer(store: EnigmaStore, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer(store);
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : port);
    });
  });
}
