import { Replica, type ReleasedApply } from './engine';
import { parseScenario } from './parse';
import type { MessageSummary, ReplayResult, Step, TerminalView } from './types';

/**
 * 回放：按“轮次 × 终端”顺序消费各终端收件顺序，
 * 逐步记录动作、因果依据与全终端快照，最后复核收敛性。
 *
 * 一次收件若补齐了多条因果依赖，其暂存释放必须作为**紧邻该收件的连续步骤**
 * 逐条记录：触发收件的快照只反映触发消息自身；随后每释放一条暂存消息，
 * 就立即记录一个只推进该条消息的独立快照。绝不先处理后续收件、再补记释放。
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

  for (let round = 0; round < maxLen; round += 1) {
    for (const t of sc.terminals) {
      const inbox = sc.inbox[t];
      if (round >= inbox.length) continue;
      const mid = inbox[round];
      const msg = sc.messagesById[mid];
      done.set(t, done.get(t)! + 1);

      // 钩子在引擎内部的状态静止点触发：
      // - triggerSnap：触发消息已应用、释放尚未开始（只含触发消息的效果）；
      // - 每条级联释放完成后立即抓快照（点集/向量/暂存只推进到该条）。
      let triggerSnap: Record<string, TerminalView> | null = null;
      const releasedEntries: Array<{ rel: ReleasedApply; snap: Record<string, TerminalView> }> = [];
      const res = replicas.get(t)!.deliver(msg, {
        afterTriggerApply: () => {
          triggerSnap = capture();
        },
        afterRelease: (rel) => {
          releasedEntries.push({ rel, snap: capture() });
        },
      });

      // 触发收件本身（applied / buffered / duplicate）：快照不含任何暂存释放
      steps.push({
        index: index++,
        round,
        terminal: t,
        messageId: mid,
        kind: msg.kind,
        action: res.action,
        reason: res.reason,
        effect: res.effect,
        stateAfter: triggerSnap ?? capture(),
      });
      // 因果释放：紧邻触发收件、按引擎内实际级联顺序逐条记录
      for (const { rel, snap } of releasedEntries) {
        steps.push({
          index: index++,
          round,
          terminal: t,
          messageId: rel.msg.id,
          kind: rel.msg.kind,
          action: 'released',
          reason: rel.reason,
          effect: rel.effect,
          stateAfter: snap,
        });
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
