import { Replica } from './engine';
import { parseScenario } from './parse';
import type { MessageSummary, ReplayResult, Step, TerminalView } from './types';

/**
 * 回放：按“轮次 × 终端”顺序消费各终端收件顺序，逐步记录动作、
 * 因果依据与全终端快照，最后复核收敛性。
 *
 * 一次外部收件可能补齐多条连续的因果依赖：触发收件先作为一步记录，
 * 随后在同一终端连续记录每一条被释放的暂存消息（中间新增先出现、
 * 更晚撤销随后出现……），每条释放都有独立快照——该步的版本向量、
 * 待处理队列与有效标签只反映截至该动作的状态，且全部释放步骤
 * 紧邻其触发收件，不被任何后续收件插队。
 *
 * 纯函数、无 IO：既可在 Web Worker 中运行，也可在 Node 下被测试直接调用。
 */
export function runReplay(raw: unknown): ReplayResult {
  const parsed = parseScenario(raw);
  if (!parsed.ok) return { ok: false, errors: parsed.errors };
  const sc = parsed.scenario;

  const replicas = new Map(sc.terminals.map((t) => [t, new Replica(t, sc.terminals)]));
  const done = new Map(sc.terminals.map((t) => [t, 0]));
  const steps: Step[] = [];
  const maxLen = Math.max(...sc.terminals.map((t) => sc.inbox[t].length));
  let index = 0;

  const capture = (): Record<string, TerminalView> => {
    const out: Record<string, TerminalView> = {};
    for (const t of sc.terminals) {
      out[t] = replicas.get(t)!.view(done.get(t)!, sc.inbox[t].length);
    }
    return out;
  };

  /** 追加一步并拍摄该步之后的全终端快照（状态仅截至本动作） */
  const appendStep = (
    terminal: string,
    round: number,
    messageId: string,
    kind: 'add' | 'remove',
    action: Step['action'],
    reason: string,
    effect: string,
  ): void => {
    steps.push({
      index: index++,
      round,
      terminal,
      messageId,
      kind,
      action,
      reason,
      effect,
      stateAfter: capture(),
    });
  };

  for (let round = 0; round < maxLen; round += 1) {
    for (const t of sc.terminals) {
      const inbox = sc.inbox[t];
      if (round >= inbox.length) continue;
      const replica = replicas.get(t)!;
      const mid = inbox[round];
      const msg = sc.messagesById[mid];
      done.set(t, done.get(t)! + 1);

      // 第一步：外部收件本身（应用 / 暂存 / 重复）。快照只反映本动作，
      // 不含任何由它触发的暂存释放。
      const res = replica.deliver(msg);
      appendStep(t, round, mid, msg.kind, res.action, res.reason, res.effect);

      // 紧随其后的连续步骤：逐条释放因本次收件而就绪的暂存消息，
      // 每条释放单独拍摄快照；多级依赖链按就绪顺序级联展开。
      // 重复或纯暂存收件不补齐任何依赖，循环立即结束。
      if (res.action === 'applied') {
        let rel = replica.releaseOnce(`外部收件 ${mid} 应用后依赖补齐`);
        while (rel) {
          const releasedId = rel.msg.id;
          appendStep(t, round, releasedId, rel.msg.kind, 'released', rel.reason, rel.effect);
          rel = replica.releaseOnce(`上一步释放 ${releasedId} 应用后依赖补齐`);
        }
      }
    }
  }

  // ---- 收敛复核：所有终端有效标签一致且暂存清空 ----
  const views = sc.terminals.map((t) => replicas.get(t)!.view(done.get(t)!, sc.inbox[t].length));
  const zoneKey = views.map((v) => v.zones.map((z) => z.zone).join(''));
  const pendingLeft = views.reduce((acc, v) => acc + v.pending.length, 0);
  const converged = zoneKey.every((k) => k === zoneKey[0]) && pendingLeft === 0;
  const finalZones = views.length > 0 ? views[0].zones.map((z) => z.zone) : [];
  const convergenceDetail = converged
    ? `全部 ${sc.terminals.length} 台终端收敛：有效标签 [${finalZones.join(', ') || '（空）'}]，暂存队列均已清空`
    : `未收敛：${sc.terminals
        .map(
          (t, i) =>
            `${t}=[${views[i].zones.map((z) => z.zone).join('|')}]${
              views[i].pending.length > 0 ? ` 暂存${views[i].pending.length}条` : ''
            }`,
        )
        .join('；')}`;

  const messages: Record<string, MessageSummary> = {};
  for (const m of sc.messages) {
    messages[m.id] = {
      id: m.id,
      kind: m.kind,
      from: m.from,
      seq: m.seq,
      ctx: m.ctx,
      label:
        m.kind === 'add'
          ? `新增 ${m.tag.zone}（点 ${m.dot}）`
          : `撤销 ${m.zone}`,
    };
  }

  return {
    ok: true,
    terminals: sc.terminals,
    steps,
    messages,
    inboxSizes: Object.fromEntries(sc.terminals.map((t) => [t, sc.inbox[t].length])),
    converged,
    finalZones,
    convergenceDetail,
  };
}
