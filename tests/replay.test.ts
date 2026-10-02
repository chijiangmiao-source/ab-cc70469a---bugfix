import { describe, expect, it } from 'vitest';
import { runReplay } from '../src/crdt/replay';
import type {
  AddMessage,
  Message,
  Step,
  TerminalView,
  Vector,
} from '../src/crdt/types';
import { SAMPLES } from '../src/samples';

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

function shuffle<T>(arr: T[], rnd: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** 独立复核：末步快照中所有终端的有效标签一致且暂存清空 */
function assertConvergedIndependently(
  terminals: string[],
  stateAfter: Record<string, TerminalView>,
) {
  const zoneSets = terminals.map((t) => JSON.stringify(stateAfter[t].zones.map((z) => z.zone)));
  expect(new Set(zoneSets).size).toBe(1);
  for (const t of terminals) expect(stateAfter[t].pending).toEqual([]);
}

describe('回放：收敛、暂存释放、重复幂等', () => {
  it('样例1：并发新增与撤销收敛（add-wins）', () => {
    const r = runReplay(SAMPLES[0].data);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.converged).toBe(true);
    expect(r.finalZones).toEqual(['Z-ALPHA', 'Z-BETA']);
    // A#2 的撤销只见过 A#1：B#1 的并发点 D-02 必须存活
    const last = r.steps[r.steps.length - 1].stateAfter;
    for (const t of r.terminals) {
      const alpha = last[t].zones.find((z) => z.zone === 'Z-ALPHA');
      expect(alpha?.dots.map((d) => d.dot)).toEqual(['D-02']);
    }
    assertConvergedIndependently(r.terminals, last);
    // 该样例中 B、C 均出现乱序暂存并随后释放
    expect(r.steps.some((s) => s.action === 'buffered' && s.messageId === 'A#2')).toBe(true);
    expect(r.steps.some((s) => s.action === 'released' && s.messageId === 'A#2')).toBe(true);
    expect(r.steps.some((s) => s.action === 'released' && s.messageId === 'C#1')).toBe(true);
  });

  it('样例2：乱序暂存释放后收敛', () => {
    const r = runReplay(SAMPLES[1].data);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.converged).toBe(true);
    expect(r.finalZones).toEqual(['Z-SOUTH']);
    // B#2 在 A、B 两台都先缺前序被暂存，随后被释放
    for (const t of ['A', 'B']) {
      const buffered = r.steps.find(
        (s) => s.terminal === t && s.messageId === 'B#2' && s.action === 'buffered',
      );
      const released = r.steps.find(
        (s) => s.terminal === t && s.messageId === 'B#2' && s.action === 'released',
      );
      expect(buffered, `终端 ${t} 应暂存 B#2`).toBeDefined();
      expect(released, `终端 ${t} 应释放 B#2`).toBeDefined();
      expect(released!.index).toBeGreaterThan(buffered!.index);
    }
    assertConvergedIndependently(r.terminals, r.steps[r.steps.length - 1].stateAfter);
  });

  it('样例3：重复投递幂等且四终端收敛', () => {
    const r = runReplay(SAMPLES[2].data);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.converged).toBe(true);
    expect(r.finalZones).toEqual(['Z-1', 'Z-2']);
    const dups = r.steps.filter((s) => s.action === 'duplicate');
    expect(dups.length).toBeGreaterThanOrEqual(3);
    // 每个重复步骤前后，版本向量 / 有效标签 / 暂存队列完全不变
    const pick = (snap: Record<string, TerminalView>) =>
      Object.fromEntries(
        Object.entries(snap).map(([k, v]) => [
          k,
          { vector: v.vector, zones: v.zones, pending: v.pending },
        ]),
      );
    for (const d of dups) {
      const prev = r.steps[d.index - 1];
      expect(prev, '重复步骤之前应已有其他步骤').toBeDefined();
      expect(pick(d.stateAfter)).toEqual(pick(prev.stateAfter));
    }
    assertConvergedIndependently(r.terminals, r.steps[r.steps.length - 1].stateAfter);
  });

  it('任意乱序收件（含重复）均收敛到同一结果', () => {
    for (let iter = 0; iter < 20; iter += 1) {
      const rnd = mulberry32(iter + 1);
      const clone = structuredClone(SAMPLES[2].data) as {
        terminals: string[];
        inbox: Record<string, string[]>;
      };
      for (const t of clone.terminals) clone.inbox[t] = shuffle(clone.inbox[t], rnd);
      const r = runReplay(clone);
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(r.converged, `第 ${iter} 轮乱序应收敛`).toBe(true);
      expect(r.finalZones).toEqual(['Z-1', 'Z-2']);
    }
  });

  it('回放是确定性的：同一场景两次运行结果一致', () => {
    const a = runReplay(SAMPLES[0].data);
    const b = runReplay(SAMPLES[0].data);
    expect(a).toEqual(b);
  });

  it('非法场景整体拒绝且不产生步骤', () => {
    const bad = structuredClone(SAMPLES[0].data) as {
      messages: Array<{ id: string; dot?: string }>;
    };
    bad.messages[1].dot = 'D-01'; // B#1 复用 A#1 的点标识，但载荷（Z-ALPHA 不同坐标）不同
    const r = runReplay(bad);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some((e) => e.message.includes('点标识复用'))).toBe(true);
    expect('steps' in r).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 独立复核模型：完全不引用 src/crdt/engine，只按规格从原始场景重放，
// 逐动作计算点集、版本向量、暂存队列与有效标签，用于独立复算每个步骤。
// ---------------------------------------------------------------------------

interface RawScenario {
  terminals: string[];
  messages: Array<Record<string, unknown>>;
  inbox: Record<string, string[]>;
}

interface RefStep {
  terminal: string;
  messageId: string;
  action: Step['action'];
}

/** 一份独立实现的参考副本：规则与 README 所述逐条对应 */
class RefReplica {
  vector: Vector;
  pending: Message[] = [];
  /** 存活点集：zone -> 事件id -> add 消息 */
  live = new Map<string, Map<string, AddMessage>>();

  constructor(private terminals: string[]) {
    this.vector = Object.fromEntries(terminals.map((t) => [t, 0]));
  }

  private missing(m: Message): boolean {
    if ((this.vector[m.from] ?? 0) !== m.seq - 1) return true;
    return this.terminals.some(
      (u) => u !== m.from && (this.vector[u] ?? 0) < (m.ctx[u] ?? 0),
    );
  }

  private apply(m: Message): void {
    if (m.kind === 'add') {
      let z = this.live.get(m.tag.zone);
      if (!z) {
        z = new Map();
        this.live.set(m.tag.zone, z);
      }
      z.set(m.id, m);
      return;
    }
    const z = this.live.get(m.zone);
    if (z) {
      for (const eid of [...z.keys()]) {
        const src = eid.split('#')[0];
        const n = Number(eid.split('#')[1]);
        if ((m.ctx[src] ?? 0) >= n) z.delete(eid);
      }
      if (z.size === 0) this.live.delete(m.zone);
    }
  }

  /** 外部收件：返回该收件这一个动作（不在内部展开释放） */
  deliver(m: Message): RefStep['action'] {
    if ((this.vector[m.from] ?? 0) >= m.seq) return 'duplicate';
    if (this.pending.some((p) => p.id === m.id)) return 'duplicate';
    if (this.missing(m)) {
      this.pending.push(m);
      return 'buffered';
    }
    this.apply(m);
    this.vector[m.from] = m.seq;
    return 'applied';
  }

  /** 释放恰好一条就绪的暂存消息；无就绪消息返回 null */
  releaseOnce(): Message | null {
    for (let i = 0; i < this.pending.length; i += 1) {
      const p = this.pending[i];
      if (!this.missing(p)) {
        this.pending.splice(i, 1);
        this.apply(p);
        this.vector[p.from] = p.seq;
        return p;
      }
    }
    return null;
  }

  zoneDots(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const [zone, adds] of this.live) {
      out[zone] = [...adds.values()]
        .map((a) => a.dot)
        .sort((a, b) => a.localeCompare(b));
    }
    return out;
  }
}

function indexMessages(raw: RawScenario): Record<string, Message> {
  const byId: Record<string, Message> = {};
  for (const rm of raw.messages) {
    const id = rm.id as string;
    const [from, seqStr] = id.split('#');
    const seq = Number(seqStr);
    const ctx: Vector = Object.fromEntries(raw.terminals.map((t) => [t, 0]));
    for (const [k, v] of Object.entries(rm.ctx as Record<string, number>)) ctx[k] = v;
    if (rm.kind === 'add') {
      byId[id] = {
        kind: 'add',
        id,
        from,
        seq,
        dot: rm.dot as string,
        tag: rm.tag as AddMessage['tag'],
        ctx,
      };
    } else {
      byId[id] = { kind: 'remove', id, from, seq, zone: rm.zone as string, ctx };
    }
  }
  return byId;
}

/**
 * 按规格独立生成“应当的动作序列”（终端 × 收件，紧随各自的释放链），
 * 并返回每个动作之后每个终端的向量、暂存队列、有效标签，供逐步比对。
 */
function referenceReplay(raw: RawScenario) {
  const byId = indexMessages(raw);
  const reps = Object.fromEntries(
    raw.terminals.map((t) => [t, new RefReplica(raw.terminals)]),
  );
  const expected: Array<{
    action: RefStep;
    snapshot: Record<
      string,
      { vector: Vector; pending: string[]; zones: Record<string, string[]> }
    >;
  }> = [];
  const done = Object.fromEntries(raw.terminals.map((t) => [t, 0]));

  const snap = () =>
    Object.fromEntries(
      raw.terminals.map((t) => [
        t,
        {
          vector: { ...reps[t].vector },
          pending: reps[t].pending.map((p) => p.id),
          zones: reps[t].zoneDots(),
        },
      ]),
    );

  const maxLen = Math.max(...raw.terminals.map((t) => raw.inbox[t].length));
  for (let round = 0; round < maxLen; round += 1) {
    for (const t of raw.terminals) {
      const list = raw.inbox[t];
      if (round >= list.length) continue;
      done[t] += 1;
      const msg = byId[list[round]];
      const action = reps[t].deliver(msg);
      expected.push({ action: { terminal: t, messageId: msg.id, action }, snapshot: snap() });
      if (action === 'applied') {
        let rel = reps[t].releaseOnce();
        while (rel) {
          expected.push({
            action: { terminal: t, messageId: rel.id, action: 'released' },
            snapshot: snap(),
          });
          rel = reps[t].releaseOnce();
        }
      }
    }
  }
  return expected;
}

function actualZones(view: TerminalView): Record<string, string[]> {
  return Object.fromEntries(
    view.zones.map((z) => [z.zone, z.dots.map((d) => d.dot).sort((a, b) => a.localeCompare(b))]),
  );
}

describe('逐步回放：释放紧邻触发收件，且每步状态可独立复算', () => {
  // 对每个样例：用独立参考模型重放，逐步核对动作序列与全终端快照
  for (const [sampleIndex, sample] of SAMPLES.entries()) {
    it(`样例${sampleIndex + 1}「${sample.name}」：动作序列、版本向量、暂存队列、标签逐点复算一致`, () => {
      const raw = sample.data as RawScenario;
      const r = runReplay(raw);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const expected = referenceReplay(raw);

      expect(r.steps.map((s) => [s.terminal, s.messageId, s.action])).toEqual(
        expected.map((e) => [e.action.terminal, e.action.messageId, e.action.action]),
      );
      expect(r.steps).toHaveLength(expected.length);

      r.steps.forEach((s, i) => {
        for (const t of raw.terminals) {
          const got = s.stateAfter[t];
          const want = expected[i].snapshot[t];
          expect(got.vector, `第${i + 1}步 ${t} 版本向量`).toEqual(want.vector);
          expect(got.pending, `第${i + 1}步 ${t} 暂存队列`).toEqual(want.pending);
          expect(actualZones(got), `第${i + 1}步 ${t} 有效标签`).toEqual(want.zones);
        }
        // 收件计数只随外部收件动作推进，释放步骤不消耗收件
        const external = r.steps
          .slice(0, i + 1)
          .filter((x) => x.action !== 'released' && x.terminal === s.terminal).length;
        expect(s.stateAfter[s.terminal].inboxDone).toBe(external);
      });

      // 最终收敛
      const last = r.steps[r.steps.length - 1].stateAfter;
      assertConvergedIndependently(raw.terminals, last);
    });
  }

  it('两级释放链：中间新增先释放、更晚撤销紧随其后，且两步都不被其它收件插队', () => {
    const raw = SAMPLES[3].data as RawScenario;
    const r = runReplay(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // 定位 B 终端：A#3、A#2 先暂存，A#1 收件触发连续释放
    const bActions = r.steps.filter((s) => s.terminal === 'B');
    expect(bActions.map((s) => [s.messageId, s.action])).toEqual([
      ['A#3', 'buffered'],
      ['A#2', 'buffered'],
      ['A#1', 'applied'],
      ['A#2', 'released'], // 中间新增先出现
      ['A#3', 'released'], // 更晚撤销随后出现
      ['B#1', 'applied'],
    ]);

    const iTrigger = r.steps.findIndex(
      (s) => s.terminal === 'B' && s.messageId === 'A#1' && s.action === 'applied',
    );
    const relAdd = r.steps[iTrigger + 1];
    const relRemove = r.steps[iTrigger + 2];
    expect(relAdd.messageId).toBe('A#2');
    expect(relAdd.action).toBe('released');
    expect(relRemove.messageId).toBe('A#3');
    expect(relRemove.action).toBe('released');

    // 因果依据：两步释放都注明紧邻触发收件；撤销步还能看到发送方前序已应用
    expect(relAdd.reason).toContain('外部收件 A#1');
    expect(relAdd.reason).toContain('发送方前序 A#1 已应用');
    expect(relRemove.reason).toContain('上一步释放 A#2');
    expect(relRemove.reason).toContain('发送方前序 A#2 已应用');

    const b = (s: Step) => s.stateAfter.B;
    // 触发收件 A#1 之后：只应用了 A#1，A#2/A#3 仍暂存，标签只有 D-31
    expect(b(r.steps[iTrigger]).vector).toEqual({ A: 1, B: 0 });
    expect(b(r.steps[iTrigger]).pending).toEqual(['A#3', 'A#2']);
    expect(actualZones(b(r.steps[iTrigger]))).toEqual({ 'Z-CHAIN': ['D-31'] });

    // 第一级释放（中间新增 A#2）：向量推进到 A=2，撤销仍在暂存，两个点并存
    expect(b(relAdd).vector).toEqual({ A: 2, B: 0 });
    expect(b(relAdd).pending).toEqual(['A#3']);
    expect(b(relAdd).inboxDone).toBe(3);
    expect(actualZones(b(relAdd))).toEqual({ 'Z-CHAIN': ['D-31', 'D-32'] });

    // 第二级释放（更晚撤销 A#3）：清空暂存，撤销清掉产生时已观测的两个点
    expect(b(relRemove).vector).toEqual({ A: 3, B: 0 });
    expect(b(relRemove).pending).toEqual([]);
    expect(actualZones(b(relRemove))).toEqual({});
    expect(relRemove.effect).toContain('D-31');
    expect(relRemove.effect).toContain('D-32');

    // 释放链期间其它终端的收件动作不得插入（三步下标连续）
    expect(r.steps.slice(iTrigger, iTrigger + 3).map((s) => s.terminal)).toEqual(['B', 'B', 'B']);
  });

  it('任意乱序收件（含重复）下，回放动作序列与独立模型逐点一致且最终收敛', () => {
    for (let iter = 0; iter < 30; iter += 1) {
      const rnd = mulberry32(iter + 100);
      const clone = structuredClone(SAMPLES[3].data) as RawScenario;
      for (const t of clone.terminals) clone.inbox[t] = shuffle([...clone.inbox[t]], rnd);
      // 混入重复投递
      clone.inbox.A.push(clone.inbox.A[0]);
      clone.inbox.B.push(clone.inbox.B[1], clone.inbox.B[0]);

      const r = runReplay(clone);
      expect(r.ok, `第 ${iter} 轮场景应合法`).toBe(true);
      if (!r.ok) continue;
      const expected = referenceReplay(clone);
      expect(
        r.steps.map((s) => [s.terminal, s.messageId, s.action]),
        `第 ${iter} 轮动作序列`,
      ).toEqual(expected.map((e) => [e.action.terminal, e.action.messageId, e.action.action]));
      r.steps.forEach((s, i) => {
        for (const t of clone.terminals) {
          expect(s.stateAfter[t].vector, `第${iter}轮 第${i + 1}步 ${t} 向量`).toEqual(
            expected[i].snapshot[t].vector,
          );
          expect(s.stateAfter[t].pending, `第${iter}轮 第${i + 1}步 ${t} 暂存`).toEqual(
            expected[i].snapshot[t].pending,
          );
          expect(actualZones(s.stateAfter[t]), `第${iter}轮 第${i + 1}步 ${t} 标签`).toEqual(
            expected[i].snapshot[t].zones,
          );
        }
      });
      assertConvergedIndependently(clone.terminals, r.steps[r.steps.length - 1].stateAfter);
    }
  });

  it('add-wins：并发新增（晚于撤销产生）在撤销释放后仍存活', () => {
    const raw = SAMPLES[0].data as RawScenario;
    const r = runReplay(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // B 终端：A#2（撤销，ctx 仅 A:2）先暂存；A#1 释放撤销时 B#1 尚未到达，
    // 随后 B#1 的并发点 D-02 必须存活
    const last = r.steps[r.steps.length - 1].stateAfter;
    for (const t of raw.terminals) {
      const alpha = last[t].zones.find((z) => z.zone === 'Z-ALPHA');
      expect(alpha?.dots.map((d) => d.dot)).toEqual(['D-02']);
    }
    // 撤销释放步紧邻其触发收件
    const removeRelease = r.steps.find(
      (s) => s.terminal === 'B' && s.messageId === 'A#2' && s.action === 'released',
    );
    expect(removeRelease).toBeDefined();
    const prev = r.steps[removeRelease!.index - 1];
    expect(prev.terminal).toBe('B');
    expect(prev.action === 'applied' || prev.action === 'released').toBe(true);
  });
});
