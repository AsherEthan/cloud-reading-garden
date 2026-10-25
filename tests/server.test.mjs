import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { createApplication } from '../server/index.mjs';
import { POINTS, SPAWN, route, walkable } from '../shared/world.mjs';
import { createStore } from '../server/store.mjs';

const password = 'Only-For-Isolated-Tests-2026!';
const op = () => randomUUID();
async function fixture(t, persistent = false) {
  const directory = mkdtempSync(join(tmpdir(), 'cloud-reading-test-'));
  const filename = persistent ? join(directory, 'test.sqlite') : ':memory:';
  const app = createApplication({ filename, bootstrapCode: 'test-only-bootstrap-code' });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const actor = () => {
    let cookie = '';
    return {
      get cookie() {
        return cookie;
      },
      async call(
        path,
        body,
        expected = 200,
        method = body === undefined ? 'GET' : 'POST',
        headers = {},
      ) {
        const r = await fetch(`${base}/api${path}`, {
          method,
          headers: {
            Origin: base,
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
            Cookie: cookie,
            ...headers,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie').split(';')[0];
        const data = await r.json();
        assert.equal(r.status, expected, `${path}: ${JSON.stringify(data)}`);
        return data;
      },
    };
  };
  const owner = actor();
  await owner.call(
    '/setup',
    {
      code: app.bootstrapCode,
      name: '测试庭主',
      email: 'owner@example.test',
      password,
      adult: true,
      agree: true,
    },
    201,
  );
  const ownerId = (await owner.call('/state')).user.id;
  let memberNumber = 0;
  const member = async (approved = true) => {
    const n = ++memberNumber;
    const email = `member${n}@example.test`;
    const invitation = await owner.call('/invites', { email, knownAdult: true });
    const user = actor();
    await user.call(
      '/join',
      { token: invitation.token, email, password, name: `善友${n}`, adult: true, agree: true },
      201,
    );
    const uid = (await user.call('/state')).user.id;
    if (approved) await owner.call(`/members/${uid}/approve`, { operationId: op() });
    return { ...user, uid, email, invitation };
  };
  return { app, actor, owner, ownerId, member, base, filename };
}

async function fundedOrder(f) {
  const seller = await f.member();
  const buyer = await f.member();
  const offer = await seller.call('/offers', {
    title: '共读整理',
    description: '整理一次公开成果，交付文字。',
    price: 7,
  });
  const order = await buyer.call('/orders', { offerId: offer.id, operationId: op() });
  return { seller, buyer, offer, order };
}

test('游戏地图：所有建筑入口可达，建筑和水面不可穿越', () => {
  assert(walkable(SPAWN.x, SPAWN.y));
  for (const place of POINTS) {
    const path = route(SPAWN, place);
    assert(path.length > 0, `${place.name}必须可以走到`);
    let previous = SPAWN;
    for (const step of path) {
      assert(walkable(step.x, step.y));
      assert.equal(Math.abs(step.x - previous.x) + Math.abs(step.y - previous.y), 1);
      previous = step;
    }
  }
  assert.equal(walkable(40, 30), false);
  assert.equal(walkable(20, 10), false);
  assert.deepEqual(route(SPAWN, { x: 40, y: 30 }), []);
});

test('游戏位置与表情需要登录和实时在场，不能传送、刷币或泄露邮箱', async (t) => {
  const f = await fixture(t);
  await f.actor().call('/world/move', { x: 25, y: 21 }, 401);
  await f.owner.call('/world/move', { x: 25, y: 21 }, 409);
  const controller = new AbortController();
  const response = await fetch(`${f.base}/api/events`, {
    headers: { Cookie: f.owner.cookie },
    signal: controller.signal,
  });
  const reader = response.body.getReader();
  try {
    await reader.read();
    await f.owner.call('/world/move', { x: 25, y: 21, facing: 'right', skin: 2 });
    await f.owner.call('/world/move', { x: 40, y: 30 }, 400);
    await f.owner.call('/world/move', { x: 30, y: 22 }, 409);
    await f.owner.call('/world/emote', { emote: 'wave' });
    await f.owner.call('/world/emote', { emote: 'heart' }, 429);
    const state = await f.owner.call('/state');
    assert.equal(state.world[0].x, 25);
    assert.equal(state.world[0].skin, 2);
    assert.equal(state.world[0].emote, 'wave');
    assert.equal(state.world[0].email, undefined);
    assert.equal(state.wallet.balance, 20);
    assert.equal((await f.owner.call('/audit')).supply, 1000);
  } finally {
    controller.abort();
    await reader.cancel().catch(() => {});
  }
});

test('创世只发行一次，重启保持供给与稳定段落', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cloud-reading-store-'));
  const filename = join(directory, 'store.sqlite');
  try {
    let s = createStore(filename);
    const passageId = s.one('SELECT id FROM passages ORDER BY ordinal').id;
    assert.equal(s.one("SELECT balance FROM accounts WHERE id='treasury'").balance, 1000);
    s.db.close();
    s = createStore(filename);
    assert.equal(
      s.one("SELECT COUNT(*) AS n FROM ledger_transactions WHERE operation_key='genesis'").n,
      1,
    );
    assert.equal(s.one('SELECT id FROM passages ORDER BY ordinal').id, passageId);
    assert.equal(s.one('SELECT COUNT(*) AS n FROM passages').n, 14);
    s.db.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('平衡分录、余额不足及中途失败都原子回滚', () => {
  const s = createStore(':memory:');
  try {
    s.account('a', 'user', '甲');
    assert.throws(() =>
      s.tx(() =>
        s.post('bad', 'a', '不可超支', [
          { account: 'a', amount: -1 },
          { account: 'treasury', amount: 1 },
        ]),
      ),
    );
    assert.throws(() =>
      s.tx(() =>
        s.post('bad-sum', 'a', '不可不平衡', [
          { account: 'a', amount: 3 },
          { account: 'treasury', amount: -2 },
        ]),
      ),
    );
    assert.throws(() =>
      s.tx(() => {
        s.post('rollback', 'a', '回滚', [
          { account: 'a', amount: 10 },
          { account: 'treasury', amount: -10 },
        ]);
        throw new Error('simulate');
      }),
    );
    assert.equal(s.one("SELECT balance FROM accounts WHERE id='a'").balance, 0);
    assert.equal(s.one('SELECT COUNT(*) AS n FROM ledger_transactions').n, 1);
  } finally {
    s.db.close();
  }
});

test('建站码、登录、密码哈希、Cookie 与来源防护', async (t) => {
  const f = await fixture(t);
  const guest = f.actor();
  await guest.call('/setup', { code: 'wrong' }, 403);
  await guest.call('/state', undefined, 401);
  await guest.call('/login', { email: 'owner@example.test', password: 'bad' }, 401);
  await guest.call('/login', { email: 'owner@example.test', password }, 403, 'POST', {
    Origin: 'https://external.example',
  });
  const response = await fetch(`${f.base}/api/login`, {
    method: 'POST',
    headers: { Origin: f.base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'owner@example.test', password }),
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  const u = f.app.store.one('SELECT * FROM users WHERE id=?', f.ownerId);
  assert.notEqual(u.password_hash, password);
  assert(!JSON.stringify(await f.owner.call('/state')).includes('password_hash'));
  const hostStatus = await new Promise((resolveStatus, reject) => {
    const r = request(
      `${f.base}/api/health`,
      { headers: { Host: 'attacker.invalid' } },
      (response) => {
        response.resume();
        resolveStatus(response.statusCode);
      },
    );
    r.on('error', reject);
    r.end();
  });
  assert.equal(hostStatus, 403);
});

test('邀请绑定邮箱、单次领取，且不能绕过成年声明', async (t) => {
  const f = await fixture(t);
  const guest = f.actor();
  const inv = await f.owner.call('/invites', { email: 'invited@example.test', knownAdult: true });
  const common = { token: inv.token, name: '受邀者', password, adult: true, agree: true };
  await guest.call('/join', { ...common, email: 'other@example.test' }, 403);
  await guest.call('/join', { ...common, email: 'invited@example.test', adult: false }, 400);
  await guest.call('/join', { ...common, email: 'invited@example.test' }, 201);
  await f.actor().call('/join', { ...common, email: 'invited@example.test' }, 409);
  const user = await guest.call('/state');
  assert.equal(user.user.status, 'probation');
  assert.equal(user.wallet.balance, 0);
  assert(!JSON.stringify(f.app.store.all('SELECT * FROM invites')).includes(inv.token));
});

test('撤销与过期邀请不能使用，普通成员不能发邀请', async (t) => {
  const f = await fixture(t);
  const m = await f.member();
  await m.call('/invites', { email: 'x@example.test', knownAdult: true }, 403);
  const inv = await f.owner.call('/invites', { email: 'expired@example.test', knownAdult: true });
  f.app.store.run("UPDATE invites SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?", inv.id);
  await f.actor().call('/invite/preview', { token: inv.token }, 404);
  const another = await f.owner.call('/invites', {
    email: 'revoked@example.test',
    knownAdult: true,
  });
  await f.owner.call(`/invites/${another.id}/revoke`, {});
  await f.actor().call('/invite/preview', { token: another.token }, 404);
});

test('试住可阅读写笔记，但不能领取奖励或发布服务', async (t) => {
  const f = await fixture(t);
  const m = await f.member(false);
  const state = await m.call('/state');
  assert.equal(state.passages.length, 14);
  await m.call('/notes', {
    passageId: state.passages[0].id,
    kind: 'question',
    body: '一个真实的问题',
    shared: false,
  });
  await m.call('/offers', { title: '服务', description: '说明', price: 1 }, 403);
  await m.call('/donate', { amount: 1, operationId: op() }, 403);
});

test('私人笔记对成员与管理员都不可见，分享可撤回且不能越权修改', async (t) => {
  const f = await fixture(t);
  const a = await f.member();
  const b = await f.member();
  const state = await a.call('/state');
  const note = await a.call('/notes', {
    passageId: state.passages[0].id,
    kind: 'note',
    body: '私密内容-不应泄露',
    shared: false,
  });
  for (const reader of [f.owner, b])
    assert(!(await reader.call('/state')).notes.some((n) => n.id === note.id));
  await b.call(`/notes/${note.id}/visibility`, { shared: true }, 403);
  await f.owner.call(`/notes/${note.id}`, {}, 403, 'DELETE');
  await a.call(`/notes/${note.id}/visibility`, { shared: true });
  assert((await b.call('/state')).notes.some((n) => n.id === note.id));
  await a.call(`/notes/${note.id}/visibility`, { shared: false });
  assert(!(await b.call('/export')).notes.some((n) => n.id === note.id));
});

test('只有本场领读人能控制阶段、位置与共同成果，版本冲突被拒绝', async (t) => {
  const f = await fixture(t);
  const m = await f.member();
  await m.call('/reading', { phase: 'reading', anchorIndex: 2 }, 403);
  await f.owner.call('/reading', { phase: 'reading', anchorIndex: 2 });
  assert.equal((await m.call('/state')).session.anchor_index, 2);
  await f.owner.call('/reading', { phase: 'reading', anchorIndex: 99 }, 400);
  await f.owner.call('/artifact', { body: '第一份共同理解', revision: 0 });
  await f.owner.call('/artifact', { body: '过期草稿不能覆盖', revision: 0 }, 409);
  const state = await f.owner.call('/state');
  await f.owner.call('/sessions', { title: '第二场', bookId: state.book.id, leaderId: m.uid });
  await f.owner.call('/reading', { phase: 'reading', anchorIndex: 0 }, 403);
  await m.call('/reading', { phase: 'discussion', anchorIndex: 1 });
  assert.equal((await m.call('/state')).history[0].artifact, '第一份共同理解');
});

test('常住起步款幂等且暂停恢复后不会重复发放', async (t) => {
  const f = await fixture(t);
  const m = await f.member(false);
  const operationId = op();
  await f.owner.call(`/members/${m.uid}/approve`, { operationId });
  await f.owner.call(`/members/${m.uid}/approve`, { operationId });
  assert.equal((await m.call('/state')).wallet.balance, 20);
  await f.owner.call(`/members/${m.uid}/suspend`, {});
  await m.call('/state', undefined, 401);
  await f.owner.call(`/members/${m.uid}/restore`, {});
  await f.owner.call(`/members/${m.uid}/approve`, { operationId: op() });
  await m.call('/login', { email: m.email, password });
  assert.equal((await m.call('/state')).wallet.balance, 20);
});

test('贡献悬赏完整闭环，预算守恒且不可自验收获利', async (t) => {
  const f = await fixture(t);
  const m = await f.member();
  const b = await f.owner.call('/bounties', {
    title: '整理共读成果',
    description: '交付三条理解和一个待解问题',
    reward: 30,
    operationId: op(),
  });
  await f.owner.call(`/bounties/${b.id}/claim`, {}, 403);
  await m.call(`/bounties/${b.id}/claim`, {});
  await m.call(`/bounties/${b.id}/submit`, { evidence: '三条理解以及下一次的问题。' });
  await m.call(`/bounties/${b.id}/review`, { accept: true, operationId: op() }, 403);
  const operationId = op();
  await f.owner.call(`/bounties/${b.id}/review`, { accept: true, operationId });
  await f.owner.call(`/bounties/${b.id}/review`, { accept: true, operationId });
  const state = await m.call('/state');
  assert.equal(state.wallet.balance, 50);
  assert.equal(state.wallet.contributions.length, 1);
  assert.equal(
    f.app.store.one('SELECT balance FROM accounts WHERE id=?', `bounty:${b.id}`).balance,
    0,
  );
  assert.equal((await f.owner.call('/audit')).ok, true);
});

test('未领取悬赏可退预算，领取者可归还，验收可要求补充', async (t) => {
  const f = await fixture(t);
  const m = await f.member();
  const b = await f.owner.call('/bounties', {
    title: '可退回任务',
    description: '清楚的标准',
    reward: 10,
    operationId: op(),
  });
  await m.call(`/bounties/${b.id}/claim`, {});
  await m.call(`/bounties/${b.id}/withdraw`, {});
  await m.call(`/bounties/${b.id}/claim`, {});
  await m.call(`/bounties/${b.id}/submit`, { evidence: '待补充成果' });
  await f.owner.call(`/bounties/${b.id}/review`, {
    accept: false,
    reviewNote: '请增加原文依据',
    operationId: op(),
  });
  assert.equal((await m.call('/state')).bounties[0].state, 'claimed');
  await m.call(`/bounties/${b.id}/withdraw`, {});
  await f.owner.call(`/bounties/${b.id}/cancel`, { operationId: op() });
  assert.equal((await f.owner.call('/audit')).ok, true);
});

test('服务购买从服务端取价，重复请求不重复扣款，结算生成永久贡献', async (t) => {
  const f = await fixture(t);
  const seller = await f.member();
  const buyer = await f.member();
  const offer = await seller.call('/offers', {
    title: '整理一次笔记',
    description: '约定交付内容',
    price: 7,
  });
  const operationId = op();
  const order = await buyer.call('/orders', { offerId: offer.id, price: 1, operationId });
  const duplicate = await buyer.call('/orders', { offerId: offer.id, price: 999, operationId });
  assert.equal(order.id, duplicate.id);
  assert.equal((await buyer.call('/state')).wallet.balance, 13);
  await seller.call(`/orders/${order.id}/deliver`, { delivery: '已完成笔记整理。' });
  await seller.call(`/orders/${order.id}/settle`, { operationId: op() }, 409);
  const settleId = op();
  await buyer.call(`/orders/${order.id}/settle`, { operationId: settleId });
  await buyer.call(`/orders/${order.id}/settle`, { operationId: settleId });
  assert.equal((await seller.call('/state')).wallet.balance, 27);
  assert.equal((await seller.call('/state')).wallet.contributions.length, 1);
  await seller.call('/donate', { amount: 20, operationId: op() });
  assert.equal((await seller.call('/state')).wallet.contributions.length, 1);
  assert((await f.owner.call('/audit')).ok);
});

test('同一操作编号不同载荷冲突，超支和负金额拒绝', async (t) => {
  const f = await fixture(t);
  const m = await f.member();
  const operationId = op();
  await m.call('/donate', { amount: 2, operationId });
  await m.call('/donate', { amount: 3, operationId }, 409);
  await m.call('/donate', { amount: 19, operationId: op() }, 409);
  await m.call('/donate', { amount: -1, operationId: op() }, 400);
  assert.equal((await m.call('/state')).wallet.balance, 18);
  assert((await f.owner.call('/audit')).ok);
});

test('未交付退款与第三方争议复核均只结算一次', async (t) => {
  const f = await fixture(t);
  const { buyer, seller, offer, order } = await fundedOrder(f);
  await buyer.call(`/orders/${order.id}/refund`, { operationId: op() });
  assert.equal((await buyer.call('/state')).wallet.balance, 20);
  const second = await buyer.call('/orders', { offerId: offer.id, operationId: op() });
  await seller.call(`/orders/${second.id}/deliver`, { delivery: '等待确认' });
  await buyer.call(`/orders/${second.id}/dispute`, {});
  await f.owner.call(`/orders/${second.id}/resolve`, { refund: false, operationId: op() });
  assert.equal((await seller.call('/state')).wallet.balance, 27);
  await f.owner.call(`/orders/${second.id}/resolve`, { refund: true, operationId: op() }, 409);
  assert((await f.owner.call('/audit')).ok);
});

test('管理员作为交易当事人不能自裁，双方协商一致可以解冻', async (t) => {
  const f = await fixture(t);
  const seller = await f.member();
  const offer = await seller.call('/offers', {
    title: '一份整理',
    description: '具体内容',
    price: 5,
  });
  const order = await f.owner.call('/orders', { offerId: offer.id, operationId: op() });
  await seller.call(`/orders/${order.id}/deliver`, { delivery: '交付的文字' });
  await f.owner.call(`/orders/${order.id}/dispute`, {});
  await f.owner.call(`/orders/${order.id}/resolve`, { refund: true, operationId: op() }, 403);
  const vote = await f.owner.call(`/orders/${order.id}/agreement`, {
    refund: true,
    operationId: op(),
  });
  assert.equal(vote.agreed, false);
  const agreed = await seller.call(`/orders/${order.id}/agreement`, {
    refund: true,
    operationId: op(),
  });
  assert.equal(agreed.agreed, true);
  assert.equal((await f.owner.call('/state')).wallet.balance, 20);
  assert((await f.owner.call('/audit')).ok);
});

test('实时连接只发失效通知，不泄露私人笔记', async (t) => {
  const f = await fixture(t);
  const m = await f.member();
  const ctrl = new AbortController();
  const response = await fetch(`${f.base}/api/events`, {
    headers: { Cookie: m.cookie },
    signal: ctrl.signal,
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader();
  try {
    const ready = new TextDecoder().decode((await reader.read()).value);
    assert.match(ready, /event: ready/);
    const state = await f.owner.call('/state');
    await f.owner.call('/notes', {
      passageId: state.passages[0].id,
      kind: 'note',
      body: '只属于管理员的私密笔记',
      shared: false,
    });
    const notification = new TextDecoder().decode((await reader.read()).value);
    assert.match(notification, /event: refresh/);
    assert(!notification.includes('私密笔记'));
  } finally {
    ctrl.abort();
    await reader.cancel().catch(() => {});
  }
});

test('文本导入要求授权，导出与数据库重开保留已发布内容', async (t) => {
  const f = await fixture(t, true);
  await f.owner.call(
    '/books',
    {
      title: '新书',
      author: '自撰',
      source: '本人原创',
      content: '第一段\n\n第二段',
      hasRights: false,
    },
    400,
  );
  const book = await f.owner.call('/books', {
    title: '新书',
    author: '自撰',
    source: '本人原创',
    content: '第一段\n\n第二段',
    hasRights: true,
  });
  await f.owner.call('/sessions', { title: '新书共读', bookId: book.id, leaderId: f.ownerId });
  await f.owner.call('/artifact', { body: '保存的理解', revision: 0 });
  assert.equal((await f.owner.call('/export')).artifacts[0].artifact, '保存的理解');
  const reopened = createStore(f.filename);
  try {
    assert.equal(
      reopened.one('SELECT artifact FROM reading_sessions WHERE book_id=?', book.id).artifact,
      '保存的理解',
    );
  } finally {
    reopened.db.close();
  }
});
