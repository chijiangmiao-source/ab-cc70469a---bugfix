import { describe, expect, it } from 'vitest';
import { parseScenario } from '../src/crdt/parse';
import { runReplay } from '../src/crdt/replay';
import { SAMPLES } from '../src/samples';
import type {
  AddMessage,
  Message,
  Scenario,
  Step,
  TerminalView,
  Vector,
} from '../src/crdt/types';

/** 取第 4 个内置样例：两级暂存释放链（一次收件级联释放两条） */
function chainScenario(): unknown {
  return SAMPLES[3].data;
}

function parsedChain(): Scenario {
  const r = parseScenario(chainScenario());
  if (!r.ok) throw new Error(`链样例非法：${JSON.stringify(r.errors)}`);
  return r.scenario;
}

function stepsOnOrThrow(r: ReturnType<typeof runReplay>): Step[] {
  if (!r.ok) throw new Error(`回放被拒绝：${JSON.stringify(r.errors)}`);
  return r.steps;
}

function vec(v: TerminalView): Vector {
  return { ...v.vector };
}

/**
 * 独立参考回放器：不引用引擎/回放实现，仅依据规范复算。
 * 规则：按 轮次×终端 消费收件；就绪判据 vector[F]===n-1 且 vector[U]>=ctx[U]；
 * 一次应用后在暂存队列（到达序）上反复扫描，每就绪一条立即释放并记录一个独立步骤。
 */
interface RefState {
  vector: Vector;
  live: Map<string, Map<string, string>>; // zone -> eventId -> dot
  pending: string[];
  done: number;
}

function refReady(s: RefState, m: Message, terminals: string[]): boolean {
  if ((s.vector[m.from] ?? 0) !== m.seq - 1) return false;
  for (const u of terminals) {
    if (u === m.from) continue;
    if ((s.vector[u] ?? 0) < (m.ctx[u] ?? 0)) return false;
  }
  return true;
}

function refApply(s: RefState, m: Message, byId: Record<string, Message>): void {
  if (m.kind === 'add') {
    const z = s.live.get(m.tag.zone) ?? new Map<string, string>();
    z.set(m.id, m.dot);
    s.live.set(m.tag.zone, z);
  } else {
    const z = s.live.get(m.zone);
    if (z) {
      for (const eid of [...z.keys()]) {
        const ev = byId[eid] as AddMessage;
        if ((m.ctx[ev.from] ?? 0) >= ev.seq) z.delete(eid);
      }
      if (z.size === 0) s.live.delete(m.zone);
    }
  }
  s.vector[m.from] = m.seq;
}

interface RefStep {
  terminal: string;
  messageId: string;
  action: 'applied' | 'duplicate' | 'buffered' | 'released';
  state: Record<string, RefState>;
}

/** 深拷贝当前全终端状态：参考回放的每一步都持有一份之后不再变化的快照 */
function refFreeze(state: Record<string, RefState>): Record<string, RefState> {
  const out: Record<string, RefState> = {};
  for (const [t, s] of Object.entries(state)) {
    out[t] = {
      vector: { ...s.vector },
      live: new Map([...s.live].map(([z, dots]) => [z, new Map(dots)])),
      pending: [...s.pending],
      done: s.done,
    };
  }
  return out;
}

function refSnapshotOf(s: RefState, inboxTotal: number): TerminalView {
  return {
    vector: { ...s.vector },
    zones: [...s.live.entries()]
      .map(([zone, dots]) => ({
        zone,
        dots: [...new Set(dots.values())].sort().map((d) => ({ dot: d, events: [] })),
      }))
      .sort((a, b) => a.zone.localeCompare(b.zone)),
    pending: [...s.pending],
    inboxDone: s.done,
    inboxTotal,
  };
}

function referenceReplay(sc: Scenario): RefStep[] {
  const state: Record<string, RefState> = {};
  for (const t of sc.terminals) {
    state[t] = { vector: Object.fromEntries(sc.terminals.map((x) => [x, 0])), live: new Map(), pending: [], done: 0 };
  }
  const out: RefStep[] = [];
  const maxLen = Math.max(...sc.terminals.map((t) => sc.inbox[t].length));
  const record = (terminal: string, messageId: string, action: RefStep['action']): void => {
    out.push({ terminal, messageId, action, state: refFreeze(state) });
  };

  for (let round = 0; round < maxLen; round += 1) {
    for (const t of sc.terminals) {
      const inbox = sc.inbox[t];
      if (round >= inbox.length) continue;
      const m = sc.messagesById[inbox[round]];
      const s = state[t];
      s.done += 1;
      if ((s.vector[m.from] ?? 0) >= m.seq || s.pending.some((p) => p === m.id)) {
        record(t, m.id, 'duplicate');
        continue;
      }
      if (!refReady(s, m, sc.terminals)) {
        s.pending.push(m.id);
        record(t, m.id, 'buffered');
        continue;
      }
      refApply(s, m, sc.messagesById);
      record(t, m.id, 'applied');
      // 关键：释放必须在同一收件处理内、紧邻触发应用逐条记录
      let progressed = true;
      while (progressed) {
        progressed = false;
        for (let i = 0; i < s.pending.length; i += 1) {
          const p = sc.messagesById[s.pending[i]];
          if ((s.vector[p.from] ?? 0) >= p.seq) {
            s.pending.splice(i, 1);
            i -= 1;
            continue;
          }
          if (refReady(s, p, sc.terminals)) {
            s.pending.splice(i, 1);
            i -= 1;
            refApply(s, p, sc.messagesById);
            record(t, p.id, 'released');
            progressed = true;
          }
        }
      }
    }
  }
  return out;
}

/** 终端视图核心字段（忽略参考器不维护的 events 明细） */
function coreView(v: TerminalView) {
  return {
    vector: v.vector,
    pending: v.pending,
    zones: v.zones.map((z) => ({ zone: z.zone, dots: z.dots.map((d) => d.dot).sort() })),
    inboxDone: v.inboxDone,
  };
}

describe('多级暂存释放链：释放步骤紧邻触发收件且逐步可独立复算', () => {
  it('样例拓扑：B 先暂存更晚撤销 A#3 与中间新增 A#2，A#1 到达后连续释放', () => {
    const sc = parsedChain();
    expect(sc.terminals).toEqual(['A', 'B']);
    // 前置事实：A#2 同时缺发送方前序 A#1 与跨终端依赖 B#1；A#3 缺 A#1..A#2
    const byId = sc.messagesById;
    expect(byId['A#2'].ctx).toMatchObject({ A: 2, B: 1 });
    expect(byId['A#3'].ctx).toMatchObject({ A: 3 });

    const r = runReplay(chainScenario());
    const steps = stepsOnOrThrow(r);

    // B 上：先缓冲 A#3，再缓冲 A#2
    const bBuf3 = steps.find((s) => s.terminal === 'B' && s.messageId === 'A#3' && s.action === 'buffered');
    const bBuf2 = steps.find((s) => s.terminal === 'B' && s.messageId === 'A#2' && s.action === 'buffered');
    expect(bBuf3).toBeDefined();
    expect(bBuf2).toBeDefined();
    expect(bBuf3!.index).toBeLessThan(bBuf2!.index);

    // 触发收件：B 收到最早前序 A#1
    const trigger = steps.find((s) => s.terminal === 'B' && s.messageId === 'A#1' && s.action === 'applied');
    expect(trigger).toBeDefined();
    const k = trigger!.index;

    // 紧邻的两步必须且只能是：释放中间新增 A#2 → 释放更晚撤销 A#3
    expect(steps[k + 1]).toMatchObject({ terminal: 'B', messageId: 'A#2', action: 'released' });
    expect(steps[k + 2]).toMatchObject({ terminal: 'B', messageId: 'A#3', action: 'released' });
    // 释放链末端之后不再是同一收件的释放
    const after = steps[k + 3];
    expect(after === undefined || after.terminal !== 'B' || after.action !== 'released').toBe(true);
  });

  it('触发收件的快照只反映触发消息：释放前 A#2/A#3 的效果不得提前出现', () => {
    const r = runReplay(chainScenario());
    const steps = stepsOnOrThrow(r);
    const trigger = steps.find((s) => s.terminal === 'B' && s.messageId === 'A#1' && s.action === 'applied')!;
    const b = trigger.stateAfter.B;
    expect(vec(b)).toEqual({ A: 1, B: 1 }); // B#1 此前已应用；A 仅推进到 A#1
    expect(b.pending).toEqual(['A#3', 'A#2']); // 两条仍在暂存（保持到达序）
    expect(b.zones.map((z) => z.zone).sort()).toEqual(['Z-A', 'Z-B']); // 中间新增 Z-C 尚未出现
    expect(b.zones.find((z) => z.zone === 'Z-A')!.dots.map((d) => d.dot)).toEqual(['D-31']);
    expect(b.inboxDone).toBe(4);
  });

  it('第一级释放（中间新增 A#2）的快照只推进这一条，且因果依据可复算', () => {
    const r = runReplay(chainScenario());
    const steps = stepsOnOrThrow(r);
    const trigger = steps.find((s) => s.terminal === 'B' && s.messageId === 'A#1')!;
    const rel2 = steps[trigger.index + 1];
    expect(rel2.messageId).toBe('A#2');
    const b = rel2.stateAfter.B;
    expect(vec(b)).toEqual({ A: 2, B: 1 });
    expect(b.pending).toEqual(['A#3']); // A#2 已出队，A#3 仍暂存
    expect(b.zones.map((z) => z.zone).sort()).toEqual(['Z-A', 'Z-B', 'Z-C']);
    // 因果依据：紧邻 A#1 触发；发送方前序 A#1 已应用；跨终端依赖 B≥1 已满足
    expect(rel2.reason).toContain('紧邻触发收件 A#1');
    expect(rel2.reason).toContain('发送方前序 A#1 已应用');
    expect(rel2.reason).toContain('B≥1（本机 B=1）');
    // 此刻 A#3 尚不可应用的独立判据：vector[A]=2 达到前序要求但本步尚未处理它
    expect(b.pending).toContain('A#3');
  });

  it('第二级释放（更晚撤销 A#3）紧接其后，清除已观测点并清空暂存', () => {
    const r = runReplay(chainScenario());
    const steps = stepsOnOrThrow(r);
    const trigger = steps.find((s) => s.terminal === 'B' && s.messageId === 'A#1')!;
    const rel3 = steps[trigger.index + 2];
    expect(rel3.messageId).toBe('A#3');
    const b = rel3.stateAfter.B;
    expect(vec(b)).toEqual({ A: 3, B: 1 });
    expect(b.pending).toEqual([]);
    // A#3 的 ctx={A:3} 覆盖 A#1 的点 D-31：Z-A 被撤销；Z-B、Z-C 存活
    expect(b.zones.map((z) => z.zone).sort()).toEqual(['Z-B', 'Z-C']);
    expect(rel3.effect).toContain('D-31');
    expect(rel3.reason).toContain('紧邻触发收件 A#1');
    expect(rel3.reason).toContain('发送方前序 A#2 已应用');
  });

  it('释放步骤与触发收件之间不得插入任何后续收件（相对顺序）', () => {
    const r = runReplay(chainScenario());
    const steps = stepsOnOrThrow(r);
    for (const s of steps) {
      if (s.action !== 'released') continue;
      // 每条释放都必须能沿同终端回溯到最近的外部 applied，中间只允许出现 released
      let j = s.index - 1;
      while (j >= 0 && steps[j].terminal === s.terminal && steps[j].action === 'released') j -= 1;
      expect(j).toBeGreaterThanOrEqual(0);
      const triggerStep = steps[j];
      expect(triggerStep.terminal).toBe(s.terminal);
      expect(triggerStep.action).toBe('applied');
      // 触发收件的轮次必须与释放相同（同一收件处理内完成）
      expect(triggerStep.round).toBe(s.round);
    }
    // 链样例 B 的收件轮次：A#1 是其第 4 条收件（round 3）
    const trigger = steps.find((s) => s.terminal === 'B' && s.messageId === 'A#1' && s.action === 'applied')!;
    expect(trigger.round).toBe(3);
    expect(steps[trigger.index + 1].round).toBe(3);
    expect(steps[trigger.index + 2].round).toBe(3);
  });

  it('与独立参考回放器逐步一致：动作、终端、版本向量、暂存队列、标签结果全相同', () => {
    const sc = parsedChain();
    const r = runReplay(sc);
    const steps = stepsOnOrThrow(r);
    const ref = referenceReplay(sc);
    expect(steps.length).toBe(ref.length);
    for (let i = 0; i < ref.length; i += 1) {
      const got = steps[i];
      const want = ref[i];
      expect({ i, terminal: got.terminal, messageId: got.messageId, action: got.action }).toEqual({
        i,
        terminal: want.terminal,
        messageId: want.messageId,
        action: want.action,
      });
      for (const t of sc.terminals) {
        const g = coreView(got.stateAfter[t]);
        const w = coreView(refSnapshotOf(want.state[t], sc.inbox[t].length));
        expect(g, `步骤 ${i} 终端 ${t} 的状态须与参考复算一致`).toEqual(w);
      }
    }
  });

  it('全部终端收敛到同一 add-wins 结果', () => {
    const r = runReplay(chainScenario());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.converged).toBe(true);
    expect(r.finalZones).toEqual(['Z-B', 'Z-C']);
  });
});

describe('所有内置样例：逐步状态仅由截至该动作的事件独立复算', () => {
  /** 依据截至某步的日志独立复算指定终端的版本向量 */
  function recomputeVector(steps: Step[], terminal: string, upto: number, terminals: string[]): Vector {
    const v: Vector = Object.fromEntries(terminals.map((t) => [t, 0]));
    for (let i = 0; i <= upto; i += 1) {
      const s = steps[i];
      if (s.terminal !== terminal) continue;
      if (s.action === 'applied' || s.action === 'released') {
        const [from, n] = [s.messageId.split('#')[0], Number(s.messageId.split('#')[1])];
        v[from] = Math.max(v[from] ?? 0, n);
      }
    }
    return v;
  }

  /** 依据截至某步的日志独立复算暂存队列（到达序） */
  function recomputePending(steps: Step[], terminal: string, upto: number): string[] {
    const pending: string[] = [];
    for (let i = 0; i <= upto; i += 1) {
      const s = steps[i];
      if (s.terminal !== terminal) continue;
      if (s.action === 'buffered') pending.push(s.messageId);
      if (s.action === 'released') {
        const idx = pending.indexOf(s.messageId);
        if (idx >= 0) pending.splice(idx, 1);
      }
    }
    return pending;
  }

  /** 依据截至某步已应用/释放的事件独立复算 OR-Set 有效标签（zone -> dots） */
  function recomputeZones(steps: Step[], terminal: string, upto: number, sc: Scenario) {
    const live = new Map<string, Map<string, string>>();
    for (let i = 0; i <= upto; i += 1) {
      const s = steps[i];
      if (s.terminal !== terminal) continue;
      if (s.action !== 'applied' && s.action !== 'released') continue;
      const m = sc.messagesById[s.messageId];
      if (m.kind === 'add') {
        const z = live.get(m.tag.zone) ?? new Map<string, string>();
        z.set(m.id, m.dot);
        live.set(m.tag.zone, z);
      } else {
        const z = live.get(m.zone);
        if (z) {
          for (const eid of [...z.keys()]) {
            const add = sc.messagesById[eid] as AddMessage;
            if ((m.ctx[add.from] ?? 0) >= add.seq) z.delete(eid);
          }
          if (z.size === 0) live.delete(m.zone);
        }
      }
    }
    return [...live.entries()]
      .map(([zone, dots]) => ({ zone, dots: [...new Set(dots.values())].sort() }))
      .sort((a, b) => a.zone.localeCompare(b.zone));
  }

  for (const sample of SAMPLES) {
    it(`样例「${sample.name}」每一步的向量/暂存/标签均可独立复算且非动作终端不变`, () => {
      const parsed = parseScenario(sample.data);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      const sc = parsed.scenario;
      const r = runReplay(sample.data);
      const steps = stepsOnOrThrow(r);

      for (let i = 0; i < steps.length; i += 1) {
        const s = steps[i];
        for (const t of sc.terminals) {
          const v = s.stateAfter[t];
          expect(vec(v), `步${i} 终端${t} 版本向量`).toEqual(
            recomputeVector(steps, t, i, sc.terminals),
          );
          expect(v.pending, `步${i} 终端${t} 暂存队列`).toEqual(recomputePending(steps, t, i));
          expect(
            v.zones.map((z) => ({ zone: z.zone, dots: z.dots.map((d) => d.dot).sort() })),
            `步${i} 终端${t} 有效标签`,
          ).toEqual(recomputeZones(steps, t, i, sc));
        }
        // 除动作终端外，其他终端快照必须与上一步完全一致（单步隔离）
        if (i > 0) {
          for (const t of sc.terminals) {
            if (t === s.terminal) continue;
            expect(coreView(s.stateAfter[t]), `步${i} 非动作终端 ${t} 不应变化`).toEqual(
              coreView(steps[i - 1].stateAfter[t]),
            );
          }
          // 动作终端的收件计数：外部收件 +1，释放步不变
          const before = steps[i - 1].stateAfter[s.terminal].inboxDone;
          const now = s.stateAfter[s.terminal].inboxDone;
          if (s.action === 'released') expect(now).toBe(before);
          else expect(now).toBe(before + 1);
        }
      }

      // 全部样例最终收敛、暂存清空
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.converged, `样例应收敛：${r.ok ? r.convergenceDetail : ''}`).toBe(true);
        const last = steps[steps.length - 1].stateAfter;
        for (const t of sc.terminals) expect(last[t].pending).toEqual([]);
      }
    });
  }
});

describe('多级释放链在任意乱序（含重复投递）下仍与参考复算一致并收敛', () => {
  function mulberry32(seed: number) {
    let a = seed >>> 0;
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it('20 组随机收件顺序：逐步对齐参考实现，终态一致', () => {
    for (let iter = 0; iter < 20; iter += 1) {
      const rnd = mulberry32(iter + 100);
      const raw = structuredClone(chainScenario()) as {
        terminals: string[];
        inbox: Record<string, string[]>;
      };
      for (const t of raw.terminals) {
        const ids = raw.inbox[t];
        for (let k = ids.length - 1; k > 0; k -= 1) {
          const j = Math.floor(rnd() * (k + 1));
          [ids[k], ids[j]] = [ids[j], ids[k]];
        }
        // 插入一条重复投递（幂等不应改变状态与收敛）
        ids.splice(Math.floor(rnd() * ids.length), 0, ids[Math.floor(rnd() * ids.length)]);
      }
      const parsed = parseScenario(raw);
      expect(parsed.ok, `第 ${iter} 轮随机场景应合法`).toBe(true);
      if (!parsed.ok) continue;
      const sc = parsed.scenario;
      const r = runReplay(sc);
      const steps = stepsOnOrThrow(r);
      const ref = referenceReplay(sc);
      expect(steps.length, `第 ${iter} 轮步数`).toBe(ref.length);
      for (let i = 0; i < ref.length; i += 1) {
        expect({
          terminal: steps[i].terminal,
          messageId: steps[i].messageId,
          action: steps[i].action,
        }).toEqual({ terminal: ref[i].terminal, messageId: ref[i].messageId, action: ref[i].action });
        for (const t of sc.terminals) {
          expect(coreView(steps[i].stateAfter[t])).toEqual(
            coreView(refSnapshotOf(ref[i].state[t], sc.inbox[t].length)),
          );
        }
      }
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.converged, `第 ${iter} 轮应收敛`).toBe(true);
        expect(r.finalZones).toEqual(['Z-B', 'Z-C']);
      }
    }
  });
});
