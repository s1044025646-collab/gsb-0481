import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  EnigmaError, EnigmaMachine, MachineConfig, ProcessResult, LetterStep,
  RULESET_VERSION, MAX_TRACE_LETTERS, processText, validateConfig,
} from "./enigma";

export interface ExperimentRow {
  id: number;
  config: MachineConfig;
  window: string;
  version: number;
  letterCount: number;
  createdAt: string;
}

export class Store {
  db: DatabaseSync;
  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS experiments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        config TEXT NOT NULL,
        ruleset TEXT NOT NULL,
        window TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 0,
        letter_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        experiment_id INTEGER NOT NULL REFERENCES experiments(id),
        request_id TEXT NOT NULL,
        plaintext TEXT NOT NULL,
        ciphertext TEXT NOT NULL,
        window_before TEXT NOT NULL,
        window_after TEXT NOT NULL,
        steps TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (experiment_id, request_id)
      );
    `);
  }

  close() { this.db.close(); }

  createExperiment(config: MachineConfig): ExperimentRow {
    const stmt = this.db.prepare(
      "INSERT INTO experiments (config, ruleset, window, version, letter_count, created_at) VALUES (?,?,?,0,0,?)"
    );
    const r = stmt.run(JSON.stringify(config), RULESET_VERSION, config.positions, new Date().toISOString());
    return this.getExperiment(Number(r.lastInsertRowid));
  }

  getExperiment(id: number): ExperimentRow {
    const row = this.db.prepare("SELECT * FROM experiments WHERE id = ?").get(id) as any;
    if (!row) throw new EnigmaError("NOT_FOUND", `实验 ${id} 不存在`, 404);
    return {
      id: row.id,
      config: JSON.parse(row.config),
      window: row.window,
      version: row.version,
      letterCount: row.letter_count,
      createdAt: row.created_at,
    };
  }

  listExperiments(): ExperimentRow[] {
    const rows = this.db.prepare("SELECT * FROM experiments ORDER BY id").all() as any[];
    return rows.map((row) => ({
      id: row.id, config: JSON.parse(row.config), window: row.window,
      version: row.version, letterCount: row.letter_count, createdAt: row.created_at,
    }));
  }

  /**
   * 追加处理一个文本块。幂等：同 requestId 同文本返回原结果；同号异文报冲突。
   * version 不匹配（旧版本追加）拒绝。窗口推进与保存同事务，失败不产生副作用。
   */
  processChunk(expId: number, requestId: string, text: string, expectedVersion: number, explain: boolean) {
    if (!requestId || typeof requestId !== "string") {
      throw new EnigmaError("INVALID_REQUEST", "requestId 必须是非空字符串");
    }
    const exp = this.getExperiment(expId);

    const existing = this.db.prepare(
      "SELECT * FROM chunks WHERE experiment_id = ? AND request_id = ?"
    ).get(expId, requestId) as any;
    if (existing) {
      if (existing.plaintext !== text) {
        throw new EnigmaError("REQUEST_CONFLICT", `请求号 ${requestId} 已用于不同文本`, 409);
      }
      return {
        idempotent: true,
        output: existing.ciphertext as string,
        windowBefore: existing.window_before as string,
        windowAfter: existing.window_after as string,
        version: exp.version,
        steps: explain ? (JSON.parse(existing.steps) as LetterStep[]) : undefined,
      };
    }
    if (expectedVersion !== exp.version) {
      throw new EnigmaError(
        "VERSION_CONFLICT",
        `版本不匹配：期望 ${expectedVersion}，当前 ${exp.version}，请刷新后重试`,
        409
      );
    }

    const machine = new EnigmaMachine({ ...exp.config, positions: exp.window });
    const result: ProcessResult = processText(machine, text, {
      explain,
      startSeq: exp.letterCount,
    });
    // 解释明细限量：超出后仍完整记录步进与窗口，仅省略逐阶段明细
    if (result.steps.length > MAX_TRACE_LETTERS) {
      for (const s of result.steps) delete s.trace;
    }
    const stepsJson = JSON.stringify(result.steps);
    const now = new Date().toISOString();

    this.db.exec("BEGIN IMMEDIATE");
    try {
      // 事务内再校验版本，防止并发追加
      const cur = this.db.prepare("SELECT version FROM experiments WHERE id = ?").get(expId) as any;
      if (cur.version !== exp.version) {
        throw new EnigmaError("VERSION_CONFLICT", "实验已被其他请求更新", 409);
      }
      this.db.prepare(
        "INSERT INTO chunks (experiment_id, request_id, plaintext, ciphertext, window_before, window_after, steps, created_at) VALUES (?,?,?,?,?,?,?,?)"
      ).run(expId, requestId, text, result.output, result.windowBefore, result.windowAfter, stepsJson, now);
      this.db.prepare(
        "UPDATE experiments SET window = ?, version = version + 1, letter_count = letter_count + ? WHERE id = ?"
      ).run(result.windowAfter, result.steps.length, expId);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return {
      idempotent: false,
      output: result.output,
      windowBefore: result.windowBefore,
      windowAfter: result.windowAfter,
      version: exp.version + 1,
      steps: explain ? result.steps : undefined,
    };
  }

  /** 查询全局第 seq 个字母（从 0 计）的完整电路路径 */
  getCharTrace(expId: number, seq: number): LetterStep {
    this.getExperiment(expId);
    const rows = this.db.prepare(
      "SELECT steps FROM chunks WHERE experiment_id = ? ORDER BY id"
    ).all(expId) as any[];
    for (const row of rows) {
      const steps = JSON.parse(row.steps) as LetterStep[];
      for (const s of steps) {
        if (s.seq === seq) return s;
      }
    }
    throw new EnigmaError("NOT_FOUND", `实验 ${expId} 中不存在序号 ${seq} 的字母`, 404);
  }

  /** 分页日志：每页若干字母的步进记录（不含解释明细时仍有窗口变化） */
  getLog(expId: number, page: number, size: number) {
    const exp = this.getExperiment(expId);
    const p = Math.max(1, page | 0);
    const s = Math.min(200, Math.max(1, size | 0));
    const offset = (p - 1) * s;
    const out: LetterStep[] = [];
    const rows = this.db.prepare(
      "SELECT steps FROM chunks WHERE experiment_id = ? ORDER BY id"
    ).all(expId) as any[];
    outer: for (const row of rows) {
      const steps = JSON.parse(row.steps) as LetterStep[];
      for (const st of steps) {
        if (st.seq >= offset && st.seq < offset + s) {
          const { trace, ...rest } = st;
          out.push(rest);
          if (out.length >= s) break outer;
        }
      }
    }
    return { page: p, size: s, total: exp.letterCount, items: out };
  }

  getReport(expId: number) {
    const exp = this.getExperiment(expId);
    const chunks = this.db.prepare(
      "SELECT request_id, plaintext, ciphertext, window_before, window_after, created_at FROM chunks WHERE experiment_id = ? ORDER BY id"
    ).all(expId) as any[];
    return {
      experiment: exp,
      ruleset: RULESET_VERSION,
      chunks: chunks.map((c) => ({
        requestId: c.request_id,
        plaintext: c.plaintext,
        ciphertext: c.ciphertext,
        windowBefore: c.window_before,
        windowAfter: c.window_after,
        createdAt: c.created_at,
      })),
    };
  }
}

export function oneShot(config: MachineConfig, text: string, explain = false) {
  const cfg = validateConfig(config);
  const machine = new EnigmaMachine(cfg);
  return processText(machine, text, { explain });
}
