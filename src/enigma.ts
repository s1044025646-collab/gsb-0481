// Enigma 三转子教学核心：双步进 + 正/反向接线 + 插线 + 反射器 B
export const mod26 = (n: number): number => ((n % 26) + 26) % 26;
export const letterToIndex = (c: string): number => c.toUpperCase().charCodeAt(0) - 65;
export const indexToLetter = (i: number): string => String.fromCharCode(mod26(i) + 65);
export const isAsciiLetter = (c: string): boolean => /^[A-Za-z]$/.test(c);

export interface RotorDef {
  name: string;
  wiring: number[];   // wiring[x] = y（正向）
  inverse: number[];  // inverse[y] = x（反向）
  notch: number;      // 窗口缺口（可见字母，不减环设置）
}

function buildRotor(name: string, wiringStr: string, notchLetter: string): RotorDef {
  const wiring = [...wiringStr].map(letterToIndex);
  const inverse = new Array<number>(26);
  wiring.forEach((y, x) => { inverse[y] = x; });
  return { name, wiring, inverse, notch: letterToIndex(notchLetter) };
}

export const ROTORS: Record<string, RotorDef> = {
  I: buildRotor("I", "EKMFLGDQVZNTOWYHXUSPAIBRCJ", "Q"),
  II: buildRotor("II", "AJDKSIRUXBLHWTMCQGZNPYFVOE", "E"),
  III: buildRotor("III", "BDFHJLCPRTXVZNYEIWGAKMUSQO", "V"),
};
export const ROTOR_NAMES = Object.keys(ROTORS);
export const REFLECTOR_B = [...("YRUHQSLDPXNGOKMIEBFZCWVJAT")].map(letterToIndex);

export const RULES_VERSION = "enigma-m3-teaching-v1";
export const WIRING_TABLE = {
  rotors: {
    I: { wiring: "EKMFLGDQVZNTOWYHXUSPAIBRCJ", notch: "Q" },
    II: { wiring: "AJDKSIRUXBLHWTMCQGZNPYFVOE", notch: "E" },
    III: { wiring: "BDFHJLCPRTXVZNYEIWGAKMUSQO", notch: "V" },
  },
  reflector: "YRUHQSLDPXNGOKMIEBFZCWVJAT",
} as const;

export interface MachineConfig {
  rotors: [string, string, string]; // 左、中、右
  rings: string;                    // 三个字母，A 表示零偏移
  positions: string;                // 初始窗口，三个字母
  plugboard: string[];              // 如 ["AB","CD"]，最多 10 对
}

export interface NormalizedConfig {
  rotors: [RotorDef, RotorDef, RotorDef];
  rings: [number, number, number];
  positions: [number, number, number];
  plugMap: number[]; // 长度 26，-1 表示未接线
  plugboard: string[];
  raw: MachineConfig;
}

export function validateConfig(input: unknown): { ok: true; config: NormalizedConfig } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const c = input as Partial<MachineConfig> | null;
  if (typeof c !== "object" || c === null) return { ok: false, errors: ["配置必须是对象"] };

  const rotors = c.rotors;
  if (!Array.isArray(rotors) || rotors.length !== 3 || rotors.some((r) => typeof r !== "string" || !ROTORS[r.toUpperCase()])) {
    errors.push("rotors 必须是 I、II、III 中三个转子名，按左、中、右排列");
  } else if (new Set(rotors.map((r) => r.toUpperCase())).size !== 3) {
    errors.push("每个转子（I、II、III）只能使用一次");
  }

  const tripleOk = (v: unknown) => typeof v === "string" && /^[A-Za-z]{3}$/.test(v);
  if (!tripleOk(c.rings)) errors.push("rings 必须是三个 A-Z 字母（环设置，A 表示零偏移）");
  if (!tripleOk(c.positions)) errors.push("positions 必须是三个 A-Z 字母（初始窗口位置）");

  const plugs = c.plugboard ?? [];
  if (!Array.isArray(plugs) || plugs.some((p) => typeof p !== "string" || !/^[A-Za-z]{2}$/.test(p))) {
    errors.push("plugboard 必须是形如 [\"AB\",\"CD\"] 的字母对数组");
  } else {
    if (plugs.length > 10) errors.push("插线最多 10 对");
    const used = new Map<number, string>();
    for (const p of plugs) {
      const a = letterToIndex(p[0]); const b = letterToIndex(p[1]);
      if (a === b) errors.push(`插线对 ${p} 不允许自配`);
      for (const x of [a, b]) {
        if (used.has(x)) errors.push(`字母 ${indexToLetter(x)} 在插线对 ${p} 与 ${used.get(x)} 之间冲突/重复`);
        else used.set(x, p.toUpperCase());
      }
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  const rotorDefs = (rotors as string[]).map((r) => ROTORS[r.toUpperCase()]) as [RotorDef, RotorDef, RotorDef];
  const plugMap = new Array<number>(26).fill(-1);
  const normPlugs: string[] = [];
  for (const p of plugs as string[]) {
    const a = letterToIndex(p[0]); const b = letterToIndex(p[1]);
    plugMap[a] = b; plugMap[b] = a;
    normPlugs.push(indexToLetter(a) + indexToLetter(b));
  }
  return {
    ok: true,
    config: {
      rotors: rotorDefs,
      rings: [...(c.rings as string)].map(letterToIndex) as [number, number, number],
      positions: [...(c.positions as string)].map(letterToIndex) as [number, number, number],
      plugMap,
      plugboard: normPlugs,
      raw: {
        rotors: rotorDefs.map((r) => r.name) as [string, string, string],
        rings: (c.rings as string).toUpperCase(),
        positions: (c.positions as string).toUpperCase(),
        plugboard: normPlugs,
      },
    },
  };
}

// 双步进：所有判断基于同一旧窗口，先形成整套新窗口再放行信号
export function stepWindows(rotors: [RotorDef, RotorDef, RotorDef], w: [number, number, number]): [number, number, number] {
  const [left, middle, right] = rotors;
  const atNotch = (rotor: RotorDef, pos: number) => pos === rotor.notch;
  const stepLeft = atNotch(middle, w[1]);
  const stepMiddle = atNotch(right, w[2]) || atNotch(middle, w[1]);
  return [mod26(w[0] + (stepLeft ? 1 : 0)), mod26(w[1] + (stepMiddle ? 1 : 0)), mod26(w[2] + 1)];
}

function forward(rotor: RotorDef, p: number, r: number, x: number): number {
  const s = p - r;
  return mod26(rotor.wiring[mod26(x + s)] - s);
}
function backward(rotor: RotorDef, p: number, r: number, x: number): number {
  const s = p - r;
  return mod26(rotor.inverse[mod26(x + s)] - s);
}

export interface CircuitTrace {
  windowsUsed: string; // 本字符加密时所用窗口（步进后）
  plugIn: string;
  fwdRight: string;
  fwdMiddle: string;
  fwdLeft: string;
  reflector: string;
  bwdLeft: string;
  bwdMiddle: string;
  bwdRight: string;
  plugOut: string;
}

export function encodeLetter(cfg: NormalizedConfig, w: [number, number, number], x: number): { out: number; trace: CircuitTrace } {
  const { rotors, rings, plugMap } = cfg;
  const plug = (v: number) => (plugMap[v] === -1 ? v : plugMap[v]);
  const s0 = plug(x);
  const s1 = forward(rotors[2], w[2], rings[2], s0);
  const s2 = forward(rotors[1], w[1], rings[1], s1);
  const s3 = forward(rotors[0], w[0], rings[0], s2);
  const s4 = REFLECTOR_B[s3];
  const s5 = backward(rotors[0], w[0], rings[0], s4);
  const s6 = backward(rotors[1], w[1], rings[1], s5);
  const s7 = backward(rotors[2], w[2], rings[2], s6);
  const s8 = plug(s7);
  return {
    out: s8,
    trace: {
      windowsUsed: w.map(indexToLetter).join(""),
      plugIn: indexToLetter(s0),
      fwdRight: indexToLetter(s1),
      fwdMiddle: indexToLetter(s2),
      fwdLeft: indexToLetter(s3),
      reflector: indexToLetter(s4),
      bwdLeft: indexToLetter(s5),
      bwdMiddle: indexToLetter(s6),
      bwdRight: indexToLetter(s7),
      plugOut: indexToLetter(s8),
    },
  };
}

export interface CharEntry {
  input: string;          // 原始字符（保留大小写）
  output: string;
  windowBefore: string;   // 步进前窗口
  windowAfter: string;    // 步进后窗口（即加密所用窗口）
  trace: CircuitTrace;
}

export interface ProcessResult {
  output: string;
  endWindows: [number, number, number];
  entries: CharEntry[]; // 仅参与加密的 ASCII 字母
}

export function processText(cfg: NormalizedConfig, startWindows: [number, number, number], text: string): ProcessResult {
  let w: [number, number, number] = [...startWindows];
  const entries: CharEntry[] = [];
  let output = "";
  for (const ch of text) {
    if (!isAsciiLetter(ch)) { output += ch; continue; }
    const before = w.map(indexToLetter).join("");
    w = stepWindows(cfg.rotors, w);
    const { out, trace } = encodeLetter(cfg, w, letterToIndex(ch));
    const outChar = indexToLetter(out);
    output += ch === ch.toLowerCase() ? outChar.toLowerCase() : outChar;
    entries.push({ input: ch, output: ch === ch.toLowerCase() ? outChar.toLowerCase() : outChar, windowBefore: before, windowAfter: w.map(indexToLetter).join(""), trace });
  }
  return { output, endWindows: w, entries };
}
