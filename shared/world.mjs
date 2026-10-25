export const TILE = 16;
export const WIDTH = 48;
export const HEIGHT = 32;
export const SPAWN = { x: 24, y: 21 };
export const POINTS = [
  {
    id: 'reading',
    name: '云间书屋',
    subtitle: '一卷书，一处相聚',
    x: 21,
    y: 15,
    kind: 'library',
    panel: 'reading',
    rect: [16, 5, 11, 9],
  },
  {
    id: 'members',
    name: '迎新小屋',
    subtitle: '认识庭院里的善友',
    x: 8,
    y: 15,
    kind: 'welcome',
    panel: 'members',
    rect: [4, 7, 8, 7],
  },
  {
    id: 'wallet',
    name: '功德账房',
    subtitle: '每一份贡献，都有回响',
    x: 34,
    y: 14,
    kind: 'bank',
    panel: 'wallet',
    rect: [31, 6, 6, 7],
  },
  {
    id: 'services',
    name: '善友集市',
    subtitle: '用你的所长，交换一点帮助',
    x: 12,
    y: 22,
    kind: 'market',
    panel: 'market',
    rect: [7, 24, 11, 5],
  },
  {
    id: 'bounties',
    name: '愿力公告板',
    subtitle: '看看今天有什么可以帮忙的',
    x: 29,
    y: 22,
    kind: 'board',
    panel: 'market',
    rect: [28, 19, 3, 2],
  },
  {
    id: 'journal',
    name: '回响之树',
    subtitle: '翻开我们留下的理解',
    x: 23,
    y: 27,
    kind: 'tree',
    panel: 'journal',
    rect: [21, 28, 4, 3],
  },
];
export function waterAt(x, y) {
  return x >= 39 + Math.floor(Math.sin(y * 0.27) * 2);
}
export function walkable(x, y) {
  if (
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    x < 2 ||
    x >= WIDTH - 2 ||
    y < 3 ||
    y >= HEIGHT - 1
  )
    return false;
  if (waterAt(x, y) && !(y >= 21 && y <= 23 && x <= 44)) return false;
  if (x >= 22 && x <= 24 && y >= 17 && y <= 19) return false;
  return !POINTS.some(
    (p) =>
      x >= p.rect[0] && x < p.rect[0] + p.rect[2] && y >= p.rect[1] && y < p.rect[1] + p.rect[3],
  );
}
export function route(from, to) {
  if (!walkable(to.x, to.y)) return [];
  const queue = [from];
  const visited = new Set([`${from.x},${from.y}`]);
  const parents = new Map();
  for (let i = 0; i < queue.length; i++) {
    const p = queue[i];
    if (p.x === to.x && p.y === to.y) {
      const result = [];
      let current = p;
      while (current.x !== from.x || current.y !== from.y) {
        result.unshift(current);
        current = parents.get(`${current.x},${current.y}`);
      }
      return result;
    }
    for (const [dx, dy] of [
      [0, 1],
      [1, 0],
      [0, -1],
      [-1, 0],
    ]) {
      const next = { x: p.x + dx, y: p.y + dy };
      const key = `${next.x},${next.y}`;
      if (!visited.has(key) && walkable(next.x, next.y)) {
        visited.add(key);
        parents.set(key, p);
        queue.push(next);
      }
    }
  }
  return [];
}
export function nearPoint(position) {
  return POINTS.find((p) => Math.abs(p.x - position.x) + Math.abs(p.y - position.y) <= 2) || null;
}
