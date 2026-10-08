export const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export const ROTOR_DEFS: Record<string, { wiring: string; notch: string }> = {
  I: { wiring: "EKMFLGDQVZNTOWYHXUSPAIBRCJ", notch: "Q" },
  II: { wiring: "AJDKSIRUXBLHWTMCQGZNPYFVOE", notch: "E" },
  III: { wiring: "BDFHJLCPRTXVZNYEIWGAKMUSQO", notch: "V" },
};
export const REFLECTOR_B = "YRUHQSLDPXNGOKMIEBFZCWVJAT";
export const RULESET_VERSION = "enigma-i-m3-v1";

export class EnigmaError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
  }
}

export interface MachineConfig {
  rotors: [string, string, string]; // 左、中、右
  ring: string; // 三个字母，A=0
  positions: string; // 三个字母，初始窗口
  plugboard: string[]; // 形如 ["AB","CD"]，最多 10 对
}

export interface RotorState {
  id: string;
  wiring: number[];
  inverse: number[];
  notch: number;
  ring: number;
  pos: number;
}

export interface StageTrace {
  stage: string;
  value: string;
}

export interface LetterStep {
  seq: number; // 全局字母序号（仅计参与加密的字母）
  input: string;
  output: string;
  windowBefore: string;
  windowAfter: string;
  stepped: { left: boolean; middle: boolean; right: boolean };
  trace?: StageTrace[]; // 仅在请求解释明细时填充
}

const mod26 = (n: number) => ((n % 26) + 26) % 26;
const A = 65;
export const isAsciiLetter = (ch: string) => {
  const c = ch.charCodeAt(0);
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
};

function buildInverse(wiring: number[]): number[] {
  const inv = new Array(26);
  for (let i = 0; i < 26; i++) inv[wiring[i]] = i;
  return inv;
}

export function validateConfig(raw: any): MachineConfig {
  if (raw === null || typeof raw !== "object") {
    throw new EnigmaError("INVALID_CONFIG", "配置必须是对象");
  }
  const { rotors, ring, positions, plugboard } = raw;
  if (!Array.isArray(rotors) || rotors.length !== 3) {
    throw new EnigmaError("INVALID_CONFIG", "rotors 必须是三个转子编号组成的数组，按左、中、右排列");
  }
  for (const r of rotors) {
    if (typeof r !== "string" || !(r in ROTOR_DEFS)) {
      throw new EnigmaError("INVALID_CONFIG", `未知转子: ${String(r)}，仅支持 I、II、III`);
    }
  }
  if (new Set(rotors).size !== 3) {
    throw new EnigmaError("INVALID_CONFIG", "每个转子只能使用一次，禁止重复");
  }
  const letterTriple = (v: any, name: string) => {
    if (typeof v !== "string" || !/^[A-Za-z]{3}$/.test(v)) {
      throw new EnigmaError("INVALID_CONFIG", `${name} 必须是三个 A-Z 字母`);
    }
    return v.toUpperCase();
  };
  const ringS = letterTriple(ring, "ring");
  const posS = letterTriple(positions, "positions");
  let plugs: string[] = [];
  if (plugboard !== undefined) {
    if (!Array.isArray(plugboard)) {
      throw new EnigmaError("INVALID_PLUGBOARD", "plugboard 必须是字母对数组");
    }
    if (plugboard.length > 10) {
      throw new EnigmaError("INVALID_PLUGBOARD", "插线最多 10 对");
    }
    const used = new Set<string>();
    for (const p of plugboard) {
      if (typeof p !== "string" || !/^[A-Za-z]{2}$/.test(p)) {
        throw new EnigmaError("INVALID_PLUGBOARD", `非法插线对: ${String(p)}`);
      }
      const pair = p.toUpperCase();
      if (pair[0] === pair[1]) {
        throw new EnigmaError("INVALID_PLUGBOARD", `禁止自配: ${pair}`);
      }
      const key = [...pair].sort().join("");
      if (plugs.some((q) => [...q].sort().join("") === key)) {
        throw new EnigmaError("INVALID_PLUGBOARD", `重复插线对: ${pair}`);
      }
      for (const ch of pair) {
        if (used.has(ch)) {
          throw new EnigmaError("INVALID_PLUGBOARD", `字母 ${ch} 参与了多对插线（冲突）`);
        }
        used.add(ch);
      }
      plugs.push(pair);
    }
  }
  return { rotors: rotors as any, ring: ringS, positions: posS, plugboard: plugs };
}

export class EnigmaMachine {
  rotors: [RotorState, RotorState, RotorState]; // 左、中、右
  plug: number[];
  reflector: number[];

  constructor(public config: MachineConfig) {
    this.rotors = config.rotors.map((id, i) => {
      const def = ROTOR_DEFS[id];
      const wiring = [...def.wiring].map((c) => c.charCodeAt(0) - A);
      return {
        id,
        wiring,
        inverse: buildInverse(wiring),
        notch: def.notch.charCodeAt(0) - A,
        ring: config.ring.charCodeAt(i) - A,
        pos: config.positions.charCodeAt(i) - A,
      };
    }) as any;
    this.plug = Array.from({ length: 26 }, (_, i) => i);
    for (const pair of config.plugboard) {
      const x = pair.charCodeAt(0) - A;
      const y = pair.charCodeAt(1) - A;
      this.plug[x] = y;
      this.plug[y] = x;
    }
    this.reflector = [...REFLECTOR_B].map((c) => c.charCodeAt(0) - A);
  }

  window(): string {
    return this.rotors.map((r) => String.fromCharCode(r.pos + A)).join("");
  }

  // 双步进：所有判断基于步进前的旧窗口，先算好整套新窗口再赋值
  step(): { left: boolean; middle: boolean; right: boolean } {
    const [l, m, r] = this.rotors;
    const midAtNotch = m.pos === m.notch;
    const rightAtNotch = r.pos === r.notch;
    const stepped = {
      left: midAtNotch,
      middle: midAtNotch || rightAtNotch,
      right: true,
    };
    if (stepped.left) l.pos = mod26(l.pos + 1);
    if (stepped.middle) m.pos = mod26(m.pos + 1);
    r.pos = mod26(r.pos + 1);
    return stepped;
  }

  private forward(rotor: RotorState, x: number): number {
    const s = rotor.pos - rotor.ring;
    return mod26(rotor.wiring[mod26(x + s)] - s);
  }
  private backward(rotor: RotorState, x: number): number {
    const s = rotor.pos - rotor.ring;
    return mod26(rotor.inverse[mod26(x + s)] - s);
  }

  encryptLetter(x: number, collect?: StageTrace[]): number {
    const push = (stage: string, v: number) => {
      if (collect) collect.push({ stage, value: String.fromCharCode(v + A) });
    };
    const [l, m, r] = this.rotors;
    let v = this.plug[x];
    push("plugboard-in", v);
    v = this.forward(r, v); push(`rotor-${r.id}-fwd(right)` , v);
    v = this.forward(m, v); push(`rotor-${m.id}-fwd(middle)`, v);
    v = this.forward(l, v); push(`rotor-${l.id}-fwd(left)`, v);
    v = this.reflector[v]; push("reflector-B", v);
    v = this.backward(l, v); push(`rotor-${l.id}-rev(left)`, v);
    v = this.backward(m, v); push(`rotor-${m.id}-rev(middle)`, v);
    v = this.backward(r, v); push(`rotor-${r.id}-rev(right)`, v);
    v = this.plug[v];
    push("plugboard-out", v);
    return v;
  }
}

export const MAX_TEXT_LENGTH = 20000;
export const MAX_TRACE_LETTERS = 5000;

export interface ProcessOptions {
  explain?: boolean;
  startSeq?: number;
}

export interface ProcessResult {
  output: string;
  windowBefore: string;
  windowAfter: string;
  steps: LetterStep[];
  traceIncluded: boolean;
}

export function processText(machine: EnigmaMachine, text: string, opts: ProcessOptions = {}): ProcessResult {
  if (typeof text !== "string") {
    throw new EnigmaError("INVALID_TEXT", "text 必须是字符串");
  }
  if (text.length > MAX_TEXT_LENGTH) {
    throw new EnigmaError("TEXT_TOO_LARGE", `文本超过 ${MAX_TEXT_LENGTH} 字符上限`, 413);
  }
  const wantTrace = !!opts.explain;
  const windowBefore = machine.window();
  const steps: LetterStep[] = [];
  let out = "";
  let seq = opts.startSeq ?? 0;
  for (const ch of text) {
    if (!isAsciiLetter(ch)) {
      out += ch; // 非 ASCII 字母原样保留，不推进窗口
      continue;
    }
    const wBefore = machine.window();
    const stepped = machine.step();
    const upper = ch.toUpperCase();
    const trace: StageTrace[] | undefined = wantTrace ? [] : undefined;
    const enc = machine.encryptLetter(upper.charCodeAt(0) - A, trace);
    let encCh = String.fromCharCode(enc + A);
    if (ch >= "a" && ch <= "z") encCh = encCh.toLowerCase();
    out += encCh;
    steps.push({
      seq: seq++,
      input: ch,
      output: encCh,
      windowBefore: wBefore,
      windowAfter: machine.window(),
      stepped,
      trace,
    });
  }
  return {
    output: out,
    windowBefore,
    windowAfter: machine.window(),
    steps,
    traceIncluded: wantTrace,
  };
}
