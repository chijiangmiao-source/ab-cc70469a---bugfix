/** 内置样例场景：覆盖并发新增/撤销收敛、乱序暂存释放、多级级联释放、重复投递幂等 */

export interface Sample {
  name: string;
  data: unknown;
}

const concurrentAddRemove = {
  terminals: ['A', 'B', 'C'],
  messages: [
    {
      id: 'A#1',
      kind: 'add',
      dot: 'D-01',
      tag: { zone: 'Z-ALPHA', lat: 39.904, lng: 116.407, radiusKm: 3 },
      ctx: { A: 1 },
    },
    {
      id: 'B#1',
      kind: 'add',
      dot: 'D-02',
      tag: { zone: 'Z-ALPHA', lat: 39.905, lng: 116.408, radiusKm: 3 },
      ctx: { B: 1 },
    },
    { id: 'A#2', kind: 'remove', zone: 'Z-ALPHA', ctx: { A: 2 } },
    {
      id: 'C#1',
      kind: 'add',
      dot: 'D-03',
      tag: { zone: 'Z-BETA', lat: 31.23, lng: 121.47, radiusKm: 5 },
      ctx: { C: 1, A: 1 },
    },
  ],
  inbox: {
    A: ['A#1', 'A#2', 'B#1', 'C#1'],
    B: ['B#1', 'A#2', 'A#1', 'C#1'],
    C: ['C#1', 'A#1', 'B#1', 'A#2'],
  },
};

const outOfOrderRelease = {
  terminals: ['A', 'B'],
  messages: [
    {
      id: 'A#1',
      kind: 'add',
      dot: 'D-11',
      tag: { zone: 'Z-NORTH', lat: 40.1, lng: 116.9, radiusKm: 2 },
      ctx: { A: 1 },
    },
    {
      id: 'B#1',
      kind: 'add',
      dot: 'D-12',
      tag: { zone: 'Z-SOUTH', lat: 22.5, lng: 114.0, radiusKm: 4 },
      ctx: { B: 1 },
    },
    { id: 'B#2', kind: 'remove', zone: 'Z-NORTH', ctx: { B: 2, A: 1 } },
  ],
  inbox: {
    A: ['A#1', 'B#2', 'B#1'],
    B: ['B#2', 'B#1', 'A#1'],
  },
};

const duplicateDelivery = {
  terminals: ['A', 'B', 'C', 'D'],
  messages: [
    {
      id: 'A#1',
      kind: 'add',
      dot: 'D-21',
      tag: { zone: 'Z-1', lat: 30.6, lng: 104.0, radiusKm: 2 },
      ctx: { A: 1 },
    },
    {
      id: 'B#1',
      kind: 'add',
      dot: 'D-22',
      tag: { zone: 'Z-1', lat: 30.7, lng: 104.1, radiusKm: 2 },
      ctx: { B: 1 },
    },
    { id: 'C#1', kind: 'remove', zone: 'Z-1', ctx: { C: 1, A: 1 } },
    {
      id: 'D#1',
      kind: 'add',
      dot: 'D-23',
      tag: { zone: 'Z-2', lat: 23.1, lng: 113.3, radiusKm: 6 },
      ctx: { D: 1, B: 1 },
    },
  ],
  inbox: {
    A: ['A#1', 'A#1', 'B#1', 'C#1', 'D#1', 'C#1'],
    B: ['B#1', 'A#1', 'C#1', 'D#1', 'D#1'],
    C: ['C#1', 'A#1', 'B#1', 'D#1'],
    D: ['D#1', 'B#1', 'A#1', 'C#1', 'A#1'],
  },
};

const cascadeReleaseChain = {
  terminals: ['A', 'B'],
  messages: [
    {
      id: 'A#1',
      kind: 'add',
      dot: 'D-31',
      tag: { zone: 'Z-A', lat: 30.6, lng: 104.0, radiusKm: 2 },
      ctx: { A: 1 },
    },
    {
      id: 'B#1',
      kind: 'add',
      dot: 'D-32',
      tag: { zone: 'Z-B', lat: 31.0, lng: 104.3, radiusKm: 2 },
      ctx: { B: 1 },
    },
    {
      // 中间新增：既是 A 链第 2 条，又跨终端依赖 B#1
      id: 'A#2',
      kind: 'add',
      dot: 'D-33',
      tag: { zone: 'Z-C', lat: 31.4, lng: 104.6, radiusKm: 2 },
      ctx: { A: 2, B: 1 },
    },
    // 更晚撤销：A 链第 3 条；已见集合沿链不可收缩，故仍携带 B:1（不影响 Z-A 判定）
    { id: 'A#3', kind: 'remove', zone: 'Z-A', ctx: { A: 3, B: 1 } },
  ],
  // B 先收到另一台终端 A 的较晚撤销 A#3（缺发送方前序 A#1..A#2）及其前序新增
  // A#2（还缺跨终端依赖 B#1）；B#1 应用后仍不释放；最早前序 A#1 到达后，
  // 必须紧邻连续记录：释放 A#2（中间新增先出现）→ 释放 A#3（更晚撤销随后出现）。
  inbox: {
    A: ['A#1', 'B#1', 'A#2', 'A#3'],
    B: ['A#3', 'A#2', 'B#1', 'A#1'],
  },
};

export const SAMPLES: Sample[] = [
  { name: '并发新增与撤销（add-wins 收敛）', data: concurrentAddRemove },
  { name: '乱序投递与暂存释放', data: outOfOrderRelease },
  { name: '重复投递幂等（四终端）', data: duplicateDelivery },
  { name: '两级暂存释放链（单收件级联）', data: cascadeReleaseChain },
];
