import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import {
  MachineConfig, NormalizedConfig, ProcessResult, CharEntry,
  validateConfig, processText, letterToIndex, RULES_VERSION, WIRING_TABLE,
} from "./enigma.js";

export const MAX_TEXT_LENGTH = 10000;
export const MAX_BATCH_CHARS = 5000;   // 单次请求最多参与加密的字母数
export const MAX_EXPLAIN = 1000;       // 单次返回最多附带电路明细的字符数

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export interface ExperimentRow {
  id: string;
  config: MachineConfig;
  version: number;
  windows: string;
  charCount: number;
  createdAt: string;
}

export class EnigmaStore {
  private db: DatabaseSync;
  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS experiments (
        id TEXT PRIMARY KEY,
        config TEXT NOT NULL,
        rules_version TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 0,
        windows TEXT NOT NULL,
        char_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS blocks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        exp_id TEXT NOT NULL REFERENCES experiments(id),
        request_id TEXT NOT NULL,
        plaintext TEXT NOT NULL,
        ciphertext TEXT NOT NULL,
        window_before TEXT NOT NULL,
        window_after TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(exp_id, request_id)
      );
      CREATE TABLE IF NOT EXISTS chars (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        exp_id TEXT NOT NULL REFERENCES experiments(id),
        char_index INTEGER NOT NULL,
        input TEXT NOT NULL,
        output TEXT NOT NULL,
        window_before TEXT NOT NULL,
        window_after TEXT NOT NULL,
        trace TEXT NOT NULL,
        UNIQUE(exp_id, char_index)
      );
    `);
  }
  close() { this.db.close(); }

  private getRow(id: string) {
    const row = this.db.prepare("SELECT * FROM experiments WHERE id = ?").get(id) as any;
    if (!row) throw new ApiError(404, "NOT_FOUND", `实验 ${id} 不存在`);
    return row;
  }

  getExperiment(id: string): ExperimentRow {
    const r = this.getRow(id);
    return { id: r.id, config: JSON.parse(r.config), version: r.version, windows: r.windows, charCount: r.char_count, createdAt: r.created_at };
  }

  listExperiments(): ExperimentRow[] {
    const rows = this.db.prepare("SELECT * FROM experiments ORDER BY created_at").all() as any[];
    return rows.map((r) => ({ id: r.id, config: JSON.parse(r.config), version: r.version, windows: r.windows, charCount: r.char_count, createdAt: r.created_at }));
  }

  createExperiment(rawConfig: unknown): ExperimentRow {
    const v = validateConfig(rawConfig);
    if (!v.ok) throw new ApiError(400, "INVALID_CONFIG", v.errors.join("；"));
    const id = randomUUID();
    this.db.prepare(
      "INSERT INTO experiments (id, config, rules_version, version, windows, char_count, created_at) VALUES (?,?,?,0,?,0,?)"
    ).run(id, JSON.stringify(v.config.raw), RULES_VERSION, v.config.raw.positions, new Date().toISOString());
    return this.getExperiment(id);
  }

  // 追加分块：幂等 + 乐观版本 + 事务原子保存
  append(id: string, text: unknown, requestId: unknown, version: unknown): {
    experiment: ExperimentRow; ciphertext: string; windowBefore: string; windowAfter: string;
    encryptedChars: number; requestId: string; replayed: boolean;
  } {
    if (typeof text !== "string") throw new ApiError(400, "INVALID_REQUEST", "text 必须是字符串");
    if (text.length > MAX_TEXT_LENGTH) throw new ApiError(413, "PAYLOAD_TOO_LARGE", `文本长度超过限制 ${MAX_TEXT_LENGTH}`);
    if (typeof requestId !== "string" || requestId.length === 0 || requestId.length > 128)
      throw new ApiError(400, "INVALID_REQUEST", "requestId 必须是 1-128 字符的字符串");
    if (typeof version !== "number" || !Number.isInteger(version) || version < 0)
      throw new ApiError(400, "INVALID_REQUEST", "version 必须是非负整数");

    const exp = this.getExperiment(id);
    const existing = this.db.prepare("SELECT * FROM blocks WHERE exp_id = ? AND request_id = ?").get(id, requestId) as any;
    if (existing) {
      if (existing.plaintext !== text) throw new ApiError(409, "CONFLICT", `请求号 ${requestId} 已用于不同文本`);
      return {
        experiment: this.getExperiment(id), ciphertext: existing.ciphertext,
        windowBefore: existing.window_before, windowAfter: existing.window_after,
        encryptedChars: [...text].filter((c) => /^[A-Za-z]$/.test(c)).length,
        requestId, replayed: true,
      };
    }
    if (version !== exp.version)
      throw new ApiError(409, "VERSION_MISMATCH", `实验版本已变为 ${exp.version}，请重新读取后再追加`);

    const v = validateConfig(exp.config);
    if (!v.ok) throw new ApiError(500, "INTERNAL", "存储的配置无效");
    const cfg: NormalizedConfig = v.config;
    const startW = [...exp.windows].map(letterToIndex) as [number, number, number];
    const result: ProcessResult = processText(cfg, startW, text);
    if (result.entries.length > MAX_BATCH_CHARS)
      throw new ApiError(413, "PAYLOAD_TOO_LARGE", `单块参与加密的字母数超过限制 ${MAX_BATCH_CHARS}`);

    const windowAfter = result.endWindows.map((i) => String.fromCharCode(i + 65)).join("");
    const now = new Date().toISOString();
    this.db.exec("BEGIN");
    try {
      this.db.prepare(
        "INSERT INTO blocks (exp_id, request_id, plaintext, ciphertext, window_before, window_after, created_at) VALUES (?,?,?,?,?,?,?)"
      ).run(id, requestId, text, result.output, exp.windows, windowAfter, now);
      const ins = this.db.prepare(
        "INSERT INTO chars (exp_id, char_index, input, output, window_before, window_after, trace) VALUES (?,?,?,?,?,?,?)"
      );
      result.entries.forEach((e: CharEntry, i: number) => {
        ins.run(id, exp.charCount + i, e.input, e.output, e.windowBefore, e.windowAfter, JSON.stringify(e.trace));
      });
      const upd = this.db.prepare(
        "UPDATE experiments SET windows = ?, char_count = ?, version = version + 1 WHERE id = ? AND version = ?"
      ).run(windowAfter, exp.charCount + result.entries.length, id, exp.version);
      if (Number(upd.changes) !== 1) throw new ApiError(409, "VERSION_MISMATCH", "实验被并发修改，请重试");
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return {
      experiment: this.getExperiment(id), ciphertext: result.output,
      windowBefore: exp.windows, windowAfter, encryptedChars: result.entries.length,
      requestId, replayed: false,
    };
  }

  listChars(id: string, offset: number, limit: number, explain: boolean) {
    this.getRow(id);
    const capped = Math.min(limit, MAX_EXPLAIN);
    const rows = this.db.prepare(
      "SELECT * FROM chars WHERE exp_id = ? ORDER BY char_index LIMIT ? OFFSET ?"
    ).all(id, capped, offset) as any[];
    return rows.map((r) => ({
      index: r.char_index, input: r.input, output: r.output,
      windowBefore: r.window_before, windowAfter: r.window_after,
      ...(explain ? { trace: JSON.parse(r.trace) } : {}),
    }));
  }

  getCharPath(id: string, index: number) {
    this.getRow(id);
    const r = this.db.prepare("SELECT * FROM chars WHERE exp_id = ? AND char_index = ?").get(id, index) as any;
    if (!r) throw new ApiError(404, "NOT_FOUND", `实验 ${id} 中不存在第 ${index} 个加密字符`);
    return {
      index: r.char_index, input: r.input, output: r.output,
      windowBefore: r.window_before, windowAfter: r.window_after,
      trace: JSON.parse(r.trace),
    };
  }

  reset(id: string, rawConfig?: unknown): ExperimentRow {
    const exp = this.getExperiment(id);
    let windows = exp.config.positions;
    let configJson = JSON.stringify(exp.config);
    if (rawConfig !== undefined) {
      const v = validateConfig(rawConfig);
      if (!v.ok) throw new ApiError(400, "INVALID_CONFIG", v.errors.join("；"));
      windows = v.config.raw.positions;
      configJson = JSON.stringify(v.config.raw);
    }
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM blocks WHERE exp_id = ?").run(id);
      this.db.prepare("DELETE FROM chars WHERE exp_id = ?").run(id);
      this.db.prepare(
        "UPDATE experiments SET config = ?, windows = ?, char_count = 0, version = version + 1 WHERE id = ?"
      ).run(configJson, windows, id);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return this.getExperiment(id);
  }

  exportReport(id: string) {
    const exp = this.getExperiment(id);
    const blocks = this.db.prepare("SELECT * FROM blocks WHERE exp_id = ? ORDER BY id").all(id) as any[];
    return {
      experiment: exp,
      rulesVersion: RULES_VERSION,
      wiringTable: WIRING_TABLE,
      blocks: blocks.map((b) => ({
        requestId: b.request_id, plaintext: b.plaintext, ciphertext: b.ciphertext,
        windowBefore: b.window_before, windowAfter: b.window_after, createdAt: b.created_at,
      })),
      totalEncryptedChars: exp.charCount,
    };
  }
}

export function defaultDbPath(): string {
  return path.join(process.cwd(), "data", "enigma.db");
}
