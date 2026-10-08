import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { EnigmaMachine, processText, validateConfig, EnigmaError } from "../src/enigma";
import { Store, oneShot } from "../src/store";

const base = { rotors: ["I", "II", "III"], ring: "AAA", positions: "AAA", plugboard: [] as string[] };
const cfg = (over: Partial<typeof base> = {}) => validateConfig({ ...base, ...over });

test("已知向量: I II III / AAA / AAA 无插线, AAAAA -> BDZGO", () => {
  assert.equal(oneShot(cfg(), "AAAAA").output, "BDZGO");
});

test("双步进: 窗口 ADU 起连续输入, 步进后窗口依次为 ADV, AEW, BFX", () => {
  const r = oneShot(cfg({ positions: "ADU" }), "AAAAA");
  const after = r.steps.map((s) => s.windowAfter);
  assert.deepEqual(after.slice(0, 3), ["ADV", "AEW", "BFX"]);
  // 第三次：中、左都步进（双步进）
  assert.deepEqual(r.steps[2].stepped, { left: true, middle: true, right: true });
  assert.deepEqual(r.steps[0].stepped, { left: false, middle: false, right: true });
});

test("非 A 环设置影响结果且与窗口语义分离", () => {
  const a = oneShot(cfg({ ring: "AAA" }), "AAAAA").output;
  const b = oneShot(cfg({ ring: "BBB" }), "AAAAA").output;
  assert.notEqual(a, b);
  // 环 B + 窗口 A 应等于 环 A + 窗口 Z（对右转子而言），仅作一致性佐证
  const c = oneShot(cfg({ ring: "AAB", positions: "AAA" }), "AAAAA").output;
  const d = oneShot(cfg({ ring: "AAA", positions: "AAZ" }), "AAAAA").output;
  assert.equal(c, d);
});

test("转子调序改变结果且缺口随转子身份走", () => {
  const a = oneShot(cfg(), "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA").output;
  const b = oneShot(cfg({ rotors: ["III", "II", "I"] }), "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA").output;
  assert.notEqual(a, b);
});

test("插线: 生效、自配/重复/冲突/超量被拒绝", () => {
  const a = oneShot(cfg(), "HELLO").output;
  const b = oneShot(cfg({ plugboard: ["HE"] }), "HELLO").output;
  assert.notEqual(a, b);
  assert.throws(() => cfg({ plugboard: ["AA"] }), /自配/);
  assert.throws(() => cfg({ plugboard: ["AB", "BA"] }), /重复/);
  assert.throws(() => cfg({ plugboard: ["AB", "AC"] }), /冲突/);
  assert.throws(() => cfg({ plugboard: Array.from({ length: 11 }, (_, i) => "AB") }), /最多 10 对/);
});

test("窗口 Z 回绕: 右窗 Z 步进后回到 A", () => {
  const r = oneShot(cfg({ positions: "AAZ" }), "A");
  assert.equal(r.steps[0].windowAfter, "AAA");
});

test("标点不步进、大小写保留、空文本", () => {
  const r = oneShot(cfg(), "Hello, 世界!");
  assert.equal(r.output.length, "Hello, 世界!".length);
  assert.equal(r.output[5], ",");
  assert.equal(r.output[7], "世");
  assert.equal(r.steps.length, 5);
  assert.equal(r.windowAfter, "AAF"); // 仅 5 个字母推进
  assert.equal(r.output[0], r.output[0].toUpperCase()); // H 大写 -> 大写
  assert.equal(r.output[1], r.output[1].toLowerCase()); // e 小写 -> 小写
  assert.equal(oneShot(cfg(), "").output, "");
});

test("任何输入字母都不会加密成自身", () => {
  const r = oneShot(cfg(), "ABCDEFGHIJKLMNOPQRSTUVWXYZ");
  for (const s of r.steps) assert.notEqual(s.output.toUpperCase(), s.input.toUpperCase());
});

test("往返恢复: 相同初始配置解密", () => {
  const plain = "THEQUICKBROWNFOXJUMPSOVERTHELAZYDOG";
  const cipher = oneShot(cfg({ positions: "MCK", ring: "BCD", plugboard: ["AB", "CD"] }), plain).output;
  const back = oneShot(cfg({ positions: "MCK", ring: "BCD", plugboard: ["AB", "CD"] }), cipher).output;
  assert.equal(back, plain);
});

test("分块拼接等于整段处理", () => {
  const text = "ENIGMAMACHINE".repeat(10);
  const whole = oneShot(cfg(), text).output;
  const m = new EnigmaMachine(cfg());
  let joined = "";
  for (const part of [text.slice(0, 7), text.slice(7, 50), text.slice(50)]) {
    joined += processText(m, part).output;
  }
  assert.equal(joined, whole);
});

test("非法配置无状态变动", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "enigma-"));
  const store = new Store(path.join(dir, "t.db"));
  const exp = store.createExperiment(cfg());
  assert.throws(() => validateConfig({ rotors: ["I", "I", "II"], ring: "AAA", positions: "AAA" }), /只能使用一次/);
  assert.throws(() => store.processChunk(exp.id, "r1", "A", 99, false), /版本不匹配/);
  const after = store.getExperiment(exp.id);
  assert.equal(after.version, 0);
  assert.equal(after.window, "AAA");
  store.close();
});

test("幂等与冲突: 同号同文返回原结果, 同号异文报冲突", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "enigma-"));
  const store = new Store(path.join(dir, "t.db"));
  const exp = store.createExperiment(cfg());
  const r1 = store.processChunk(exp.id, "req-1", "HELLO", 0, false);
  const r2 = store.processChunk(exp.id, "req-1", "HELLO", 0, false);
  assert.equal(r2.idempotent, true);
  assert.equal(r2.output, r1.output);
  assert.throws(() => store.processChunk(exp.id, "req-1", "WORLD", 1, false), /已用于不同文本/);
  // 幂等命中不推进版本
  assert.equal(store.getExperiment(exp.id).version, 1);
  store.close();
});

test("重启后继续流与连续执行一致", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "enigma-"));
  const db = path.join(dir, "t.db");
  const s1 = new Store(db);
  const exp = s1.createExperiment(cfg());
  s1.processChunk(exp.id, "a", "HELLO", 0, false);
  s1.close();
  const s2 = new Store(db); // 模拟重启
  const cont = s2.processChunk(exp.id, "b", "WORLD", 1, false);
  s2.close();
  const whole = oneShot(cfg(), "HELLOWORLD").output;
  const first = oneShot(cfg(), "HELLO").output;
  assert.equal(first + cont.output, whole);
});

test("多实验窗口互不共享", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "enigma-"));
  const store = new Store(path.join(dir, "t.db"));
  const e1 = store.createExperiment(cfg());
  const e2 = store.createExperiment(cfg());
  store.processChunk(e1.id, "x", "AAAAA", 0, false);
  assert.equal(store.getExperiment(e1.id).window, "AAF");
  assert.equal(store.getExperiment(e2.id).window, "AAA");
  store.close();
});

test("逐字符电路路径包含全部阶段", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "enigma-"));
  const store = new Store(path.join(dir, "t.db"));
  const exp = store.createExperiment(cfg());
  store.processChunk(exp.id, "r", "ABC", 0, true);
  const trace = store.getCharTrace(exp.id, 1);
  const stages = trace.trace!.map((t) => t.stage);
  assert.deepEqual(stages, [
    "plugboard-in", "rotor-III-fwd(right)", "rotor-II-fwd(middle)", "rotor-I-fwd(left)",
    "reflector-B", "rotor-I-rev(left)", "rotor-II-rev(middle)", "rotor-III-rev(right)", "plugboard-out",
  ]);
  assert.equal(trace.windowBefore, "AAB");
  assert.equal(trace.windowAfter, "AAC");
  store.close();
});

test("分页日志覆盖全部字母且总数正确", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "enigma-"));
  const store = new Store(path.join(dir, "t.db"));
  const exp = store.createExperiment(cfg());
  store.processChunk(exp.id, "r1", "A".repeat(120), 0, false);
  const p1 = store.getLog(exp.id, 1, 50);
  const p3 = store.getLog(exp.id, 3, 50);
  assert.equal(p1.total, 120);
  assert.equal(p1.items.length, 50);
  assert.equal(p3.items.length, 20);
  assert.equal(p1.items[0].windowAfter, "AAB");
  store.close();
});

test("重置生成同配置新实验", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "enigma-"));
  const store = new Store(path.join(dir, "t.db"));
  const e1 = store.createExperiment(cfg({ positions: "ABC" }));
  store.processChunk(e1.id, "r", "AAAA", 0, false);
  const e2 = store.createExperiment(store.getExperiment(e1.id).config);
  assert.equal(store.getExperiment(e2.id).window, "ABC");
  assert.notEqual(e1.id, e2.id);
  store.close();
});

test("文本超限被拒绝", () => {
  assert.throws(() => oneShot(cfg(), "A".repeat(20001)), /上限/);
});


