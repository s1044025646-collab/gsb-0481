import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  validateConfig, processText, stepWindows, MachineConfig,
} from "../src/enigma.js";
import { EnigmaStore, ApiError } from "../src/db.js";

const base: MachineConfig = { rotors: ["I", "II", "III"], rings: "AAA", positions: "AAA", plugboard: [] };

function cfg(overrides: Partial<MachineConfig> = {}) {
  const v = validateConfig({ ...base, ...overrides });
  assert.ok(v.ok, "config should be valid");
  return v.config;
}

test("已知向量: I,II,III / AAA / AAA / 无插线, AAAAA -> BDZGO", () => {
  const r = processText(cfg(), [0, 0, 0], "AAAAA");
  assert.equal(r.output, "BDZGO");
});

test("双步进: 窗口 ADU 连续三字母 -> ADV, AEW, BFX", () => {
  const c = cfg({ positions: "ADU" });
  let w: [number, number, number] = [0, 3, 20];
  const seen: string[] = [];
  for (let i = 0; i < 3; i++) {
    w = stepWindows(c.rotors, w);
    seen.push(w.map((n) => String.fromCharCode(n + 65)).join(""));
  }
  assert.deepEqual(seen, ["ADV", "AEW", "BFX"]);
  const r = processText(c, [0, 3, 20], "AAA");
  assert.deepEqual(r.entries.map((e) => e.windowAfter), ["ADV", "AEW", "BFX"]);
});

test("非 A 环设置影响输出；环偏移等价于窗口反向偏移", () => {
  const a = processText(cfg(), [0, 0, 0], "AAAAA").output;
  const b = processText(cfg({ rings: "AAB" }), [0, 0, 0], "AAAAA").output;
  assert.notEqual(a, b);
  // 右转子 环B+窗口A 的接线偏移 等价于 环A+窗口Z（未越缺口时）
  const c1 = processText(cfg({ rings: "AAA", positions: "AAZ" }), [0, 0, 25], "AAAAA").output;
  const c2 = processText(cfg({ rings: "AAB", positions: "AAA" }), [0, 0, 0], "AAAAA").output;
  assert.equal(c1, c2);
});

test("转子调序改变输出", () => {
  const a = processText(cfg(), [0, 0, 0], "AAAAA").output;
  const b = processText(cfg({ rotors: ["III", "II", "I"] }), [0, 0, 0], "AAAAA").output;
  assert.notEqual(a, b);
});

test("插线: 影响输出、校验冲突/自配/重复/超量", () => {
  const a = processText(cfg(), [0, 0, 0], "AAAAA").output;
  const b = processText(cfg({ plugboard: ["AB"] }), [0, 0, 0], "AAAAA".slice(0, 0) + "AAAAA").output;
  assert.notEqual(a, b);
  assert.equal(validateConfig({ ...base, plugboard: ["AA"] }).ok, false);
  assert.equal(validateConfig({ ...base, plugboard: ["AB", "AC"] }).ok, false);
  assert.equal(validateConfig({ ...base, plugboard: ["AB", "BA"] }).ok, false);
  assert.equal(validateConfig({ ...base, plugboard: Array.from({ length: 11 }, (_, i) => String.fromCharCode(65 + i) + "Z") }).ok, false);
  assert.equal(validateConfig({ ...base, plugboard: ["AB", "CD", "EF", "GH", "IJ", "KL", "MN", "OP", "QR", "ST"] }).ok, true);
});

test("窗口 Z 回绕: ZZZ 步进后为 ZZA，右转子 Z 之后回到 A", () => {
  const w = stepWindows(cfg().rotors, [25, 25, 25]);
  assert.deepEqual(w, [25, 25, 0]);
});

test("标点不步进、大小写保留、Unicode 原样保留", () => {
  const r = processText(cfg(), [0, 0, 0], "a, B！🙂c");
  const chars = [...r.output];
  assert.equal(chars[1], ",");
  assert.equal(chars[2], " ");
  assert.equal(chars[4], "！");
  assert.equal(chars[5], "🙂");
  assert.equal(r.entries.length, 3);
  assert.ok(/[a-z]/.test(chars[0]));
  assert.ok(/[A-Z]/.test(chars[3]));
  assert.equal(r.entries[2].windowBefore, r.entries[1].windowAfter); // 标点不推进
});

test("空文本返回空输出", () => {
  const r = processText(cfg(), [0, 0, 0], "");
  assert.equal(r.output, "");
  assert.deepEqual(r.endWindows, [0, 0, 0]);
});

test("任何字母都不会加密成自身（多窗口采样）", () => {
  const c = cfg();
  let text = "";
  for (let i = 0; i < 26 * 30; i++) text += String.fromCharCode(65 + (i % 26));
  const r = processText(c, [0, 0, 0], text);
  for (const e of r.entries) assert.notEqual(e.input.toUpperCase(), e.output.toUpperCase());
});

test("往返: 相同初始配置处理密文恢复明文", () => {
  const plain = "HELLO, World! 你好";
  const enc = processText(cfg(), [0, 0, 0], plain).output;
  const dec = processText(cfg(), [0, 0, 0], enc).output;
  assert.equal(dec, plain);
});

test("分块追加等于整段处理", () => {
  const c = cfg();
  const whole = processText(c, [0, 0, 0], "ABCDEFGHIJKLMNOP").output;
  const p1 = processText(c, [0, 0, 0], "ABCDE");
  const p2 = processText(c, p1.endWindows, "FGHIJ");
  const p3 = processText(c, p2.endWindows, "KLMNOP");
  assert.equal(p1.output + p2.output + p3.output, whole);
});

test("非法配置被拒绝", () => {
  assert.equal(validateConfig({ ...base, rotors: ["I", "I", "III"] }).ok, false);
  assert.equal(validateConfig({ ...base, rotors: ["I", "II", "IV"] }).ok, false);
  assert.equal(validateConfig({ ...base, rings: "AA" }).ok, false);
  assert.equal(validateConfig({ ...base, positions: "A1A" }).ok, false);
});

// ---------- 持久层 ----------

function tempDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "enigma-")), "test.db");
}

test("实验流: 追加/幂等/冲突/版本/重启恢复/重置/导出", () => {
  const dbPath = tempDb();
  let store = new EnigmaStore(dbPath);
  const exp = store.createExperiment(base);
  assert.equal(exp.windows, "AAA");

  const r1 = store.append(exp.id, "AAAAA", "req-1", 0);
  assert.equal(r1.ciphertext, "BDZGO");
  assert.equal(r1.windowAfter, "AAF");

  // 同号同文 -> 原结果；同号异文 -> 冲突
  const replay = store.append(exp.id, "AAAAA", "req-1", 0);
  assert.equal(replay.replayed, true);
  assert.equal(replay.ciphertext, "BDZGO");
  assert.throws(() => store.append(exp.id, "BBBBB", "req-1", 1), (e: unknown) => e instanceof ApiError && (e as ApiError).code === "CONFLICT");

  // 旧版本追加被拒绝，且状态不变
  assert.throws(() => store.append(exp.id, "CC", "req-2", 0), (e: unknown) => e instanceof ApiError && (e as ApiError).code === "VERSION_MISMATCH");
  assert.equal(store.getExperiment(exp.id).windows, "AAF");

  // 正常追加，分块一致
  const r2 = store.append(exp.id, "AAAAA", "req-2", 1);
  const whole = processText(cfg(), [0, 0, 0], "AAAAAAAAAA").output;
  assert.equal(r1.ciphertext + r2.ciphertext, whole);

  // 逐字符电路路径
  const path0 = store.getCharPath(exp.id, 0);
  assert.equal(path0.input, "A");
  assert.equal(path0.output, "B");
  assert.equal(path0.windowAfter, "AAB");
  assert.equal(path0.trace.plugOut, "B");
  assert.equal(path0.trace.windowsUsed, "AAB");

  // 分页日志
  assert.equal(store.listChars(exp.id, 0, 4, false).length, 4);
  assert.equal(store.listChars(exp.id, 4, 100, true).length, 6);
  assert.equal(store.listChars(exp.id, 0, 1, true)[0].trace.plugOut, "B");

  // 重启后继续流与连续执行一致
  store.close();
  store = new EnigmaStore(dbPath);
  const expAfter = store.getExperiment(exp.id);
  assert.equal(expAfter.windows, "AAK");
  const r3 = store.append(exp.id, "AAAAA", "req-3", expAfter.version);
  const expected = processText(cfg(), [0, 0, 10], "AAAAA").output;
  assert.equal(r3.ciphertext, expected);

  // 多实验窗口互不共享
  const exp2 = store.createExperiment({ ...base, positions: "ZZZ" });
  assert.equal(store.getExperiment(exp2.id).windows, "ZZZ");
  assert.equal(store.getExperiment(exp.id).windows, "AAP");

  // 导出报告
  const report = store.exportReport(exp.id);
  assert.equal(report.blocks.length, 3);
  assert.equal(report.totalEncryptedChars, 15);

  // 重置为新实验状态，旧版本被拒绝
  const reset = store.reset(exp.id);
  assert.equal(reset.windows, "AAA");
  assert.equal(reset.charCount, 0);
  assert.throws(() => store.append(exp.id, "A", "req-x", reset.version - 1), (e: unknown) => e instanceof ApiError && (e as ApiError).code === "VERSION_MISMATCH");
  const r4 = store.append(exp.id, "AAAAA", "req-4", reset.version);
  assert.equal(r4.ciphertext, "BDZGO");
  store.close();
});

test("解密需从相同初始配置重新开始，而非上次结束位置", () => {
  const dbPath = tempDb();
  const store = new EnigmaStore(dbPath);
  const enc = store.createExperiment(base);
  const cipher = store.append(enc.id, "HELLOWORLD", "e1", 0).ciphertext;
  const dec = store.createExperiment(base); // 相同初始配置的新实验
  const plain = store.append(dec.id, cipher, "d1", 0).ciphertext;
  assert.equal(plain, "HELLOWORLD");
  store.close();
});
