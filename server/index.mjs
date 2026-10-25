import express from 'express';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SPAWN, walkable } from '../shared/world.mjs';
import {
  createStore,
  AppError,
  ensure,
  text,
  email,
  passwordHash,
  passwordMatches,
  publicUser,
  id,
  now,
  digest,
  token,
} from './store.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PHASES = ['gathering', 'reading', 'discussion', 'reflection', 'ended'];
const NOTE_KINDS = ['note', 'question', 'interpretation', 'case', 'counter'];
const positiveAmount = (value) => {
  ensure(
    Number.isSafeInteger(value) && value > 0 && value <= 10000,
    400,
    '金额需为 1—10,000 的整数。',
  );
  return value;
};

export function createApplication(options = {}) {
  const store = createStore(
    options.filename || join(process.env.DATA_DIR || join(ROOT, '.local-data'), 'reading.sqlite'),
  );
  const { one, all, run, tx, setting, account, post, moneyOperation, audit } = store;
  const app = express();
  const bootstrapCode = options.bootstrapCode || token().slice(0, 24);
  const publicOrigin = options.publicOrigin || process.env.PUBLIC_ORIGIN || '';
  const secureCookie = options.secureCookie ?? process.env.COOKIE_SECURE === 'true';
  if (
    publicOrigin &&
    (new URL(publicOrigin).protocol !== 'https:' ||
      new URL(publicOrigin).origin !== publicOrigin ||
      !secureCookie)
  )
    throw new Error('PUBLIC_ORIGIN 必须是无路径的 HTTPS 入口，并开启 COOKIE_SECURE=true。');
  const connections = new Map();
  const worldPositions = new Map();
  const worldPosition = (userId) => {
    if (!worldPositions.has(userId))
      worldPositions.set(userId, {
        ...SPAWN,
        facing: 'down',
        skin: 0,
        movedAt: 0,
        emote: '',
        emoteUntil: 0,
      });
    return worldPositions.get(userId);
  };
  const worldSnapshot = () =>
    [...connections.keys()]
      .map((uid) => {
        const user = one("SELECT id,name FROM users WHERE id=? AND status<>'suspended'", uid);
        if (!user) return null;
        const p = worldPosition(uid);
        return {
          id: user.id,
          name: user.name,
          x: p.x,
          y: p.y,
          facing: p.facing,
          skin: p.skin,
          moving: Date.now() - p.movedAt < 240,
          emote: p.emote,
          emoteUntil: p.emoteUntil,
        };
      })
      .filter(Boolean);
  const hands = new Map();
  const voice = new Set();
  const rateBuckets = new Map();
  const dummyPassword = passwordHash(token());
  let iceServers = [];
  try {
    iceServers = JSON.parse(process.env.RTC_ICE_SERVERS || '[]');
    ensure(Array.isArray(iceServers), 500, '语音配置需为数组。');
  } catch {
    throw new Error('RTC_ICE_SERVERS 不是有效的 JSON 数组。');
  }
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    let host;
    try {
      host = new URL(`http://${req.headers.host}`).hostname;
    } catch {
      return res.status(400).json({ error: '无效入口。' });
    }
    const configuredHost = publicOrigin ? new URL(publicOrigin).hostname : null;
    if (!['localhost', '127.0.0.1', '[::1]'].includes(host) && host !== configuredHost)
      return res.status(403).json({ error: '未授权的访问入口。' });
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), microphone=(self)');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    if (req.path.startsWith('/api')) res.setHeader('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.headers.origin;
      const allowed = publicOrigin
        ? [publicOrigin]
        : [`http://${req.headers.host}`, 'http://127.0.0.1:5179', 'http://localhost:5179'];
      if (!origin || !allowed.includes(origin))
        return res.status(403).json({ error: '请求来源未获授权，请从本站页面操作。' });
      if (!req.is('application/json')) return res.status(415).json({ error: '请使用 JSON 请求。' });
    }
    next();
  });
  app.use(express.json({ limit: '256kb' }));
  app.use('/api', (req, res, next) => {
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
      (!req.body || typeof req.body !== 'object' || Array.isArray(req.body))
    )
      return res.status(400).json({ error: '请提交有效的 JSON 对象。' });
    next();
  });
  const send = (response, type, data) =>
    response.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  const broadcastWorld = () => {
    const snapshot = worldSnapshot();
    for (const set of connections.values())
      for (const c of set) send(c.response, 'world', snapshot);
  };
  const broadcast = () => {
    for (const set of connections.values()) for (const c of set) send(c.response, 'refresh', {});
  };
  const disconnect = (userId) => {
    for (const c of connections.get(userId) || []) c.response.end();
    connections.delete(userId);
    hands.delete(userId);
    voice.delete(userId);
    worldPositions.delete(userId);
    broadcastWorld();
  };
  const limited = (req) => {
    const key = req.socket.remoteAddress || 'unknown';
    const old = rateBuckets.get(key);
    const bucket =
      old && old.until > Date.now() ? old : { count: 0, until: Date.now() + 15 * 60 * 1000 };
    bucket.count++;
    rateBuckets.set(key, bucket);
    ensure(bucket.count <= 30, 429, '尝试较多，请稍后再试。');
  };
  const getSession = (req) => {
    const cookie = String(req.headers.cookie || '')
      .split(';')
      .map((v) => v.trim())
      .find((v) => v.startsWith('cloud_session='));
    if (!cookie) return null;
    const hash = digest(cookie.slice('cloud_session='.length));
    return one(
      'SELECT u.*,s.token_hash AS session_hash,s.expires_at FROM auth_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?',
      hash,
      now(),
    );
  };
  const auth = (req, _res, next) => {
    try {
      req.user = getSession(req);
      ensure(req.user && req.user.status !== 'suspended', 401, '会话已结束，请重新登录。');
      next();
    } catch (e) {
      next(e);
    }
  };
  const owner = (req) => ensure(req.user.role === 'owner', 403, '这项操作由管理员负责。');
  const resident = (req) =>
    ensure(req.user.status === 'resident', 403, '试住期间可以共读；正式加入后开放功德币服务。');
  const active = () =>
    one('SELECT * FROM reading_sessions WHERE id=?', setting('active_session') || '');
  const leader = (req) => {
    const session = active();
    ensure(session, 404, '当前没有共读。');
    ensure(session.leader_id === req.user.id, 403, '只有本场领读人可以操作。');
    return session;
  };
  const login = (res, userId) => {
    const secret = token();
    run('DELETE FROM auth_sessions WHERE expires_at<=?', now());
    run(
      'INSERT INTO auth_sessions VALUES(?,?,?)',
      digest(secret),
      userId,
      new Date(Date.now() + 12 * 3600000).toISOString(),
    );
    res.setHeader(
      'Set-Cookie',
      `cloud_session=${secret}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200${secureCookie ? '; Secure' : ''}`,
    );
  };
  const publish = (res, data = { ok: true }) => {
    broadcast();
    res.json(data);
  };

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.get('/api/bootstrap', (_req, res) =>
    res.json({ needsSetup: !one("SELECT id FROM users WHERE role='owner' LIMIT 1") }),
  );
  app.post('/api/setup', (req, res) => {
    limited(req);
    ensure(req.body.code === bootstrapCode, 403, '建站码不正确，请查看启动终端。');
    ensure(req.body.adult === true && req.body.agree === true, 400, '请确认成年并接受共读公约。');
    const name = text(req.body.name, '称呼', 30);
    const address = email(req.body.email);
    const hash = passwordHash(req.body.password);
    const userId = tx(() => {
      ensure(!one("SELECT id FROM users WHERE role='owner'"), 409, '管理员已经建立，请登录。');
      const uid = id();
      run(
        'INSERT INTO users VALUES(?,?,?,?,?,?,1,NULL,?)',
        uid,
        address,
        name,
        hash,
        'owner',
        'resident',
        now(),
      );
      account(uid, 'user', name);
      post('owner-welcome', uid, '管理员起步额度', [
        { account: 'treasury', amount: -20 },
        { account: uid, amount: 20 },
      ]);
      store.startSession('第一场 · 从相聚开始', setting('sample_book'), uid);
      audit(uid, 'owner-created', uid);
      return uid;
    });
    login(res, userId);
    res.status(201).json({ ok: true });
  });
  app.post('/api/login', (req, res) => {
    limited(req);
    const address = email(req.body.email);
    const u = one('SELECT * FROM users WHERE email=?', address);
    const correct = passwordMatches(req.body.password, u?.password_hash || dummyPassword);
    ensure(u && correct && u.status !== 'suspended', 401, '邮箱、密码不正确，或账户已暂停。');
    login(res, u.id);
    res.json({ ok: true });
  });
  app.post('/api/invite/preview', (req, res) => {
    const secret = typeof req.body.token === 'string' ? req.body.token : '';
    const invitation = one(
      'SELECT email,expires_at,used_by,revoked FROM invites WHERE token_hash=?',
      digest(secret),
    );
    ensure(
      invitation && !invitation.revoked && !invitation.used_by && invitation.expires_at > now(),
      404,
      '邀请已失效、已被领取或不存在，请联系邀请人。',
    );
    res.json({ email: invitation.email, expiresAt: invitation.expires_at });
  });
  app.post('/api/join', (req, res) => {
    limited(req);
    ensure(
      req.body.adult === true && req.body.agree === true,
      400,
      '仅邀请直接认识的成年成员，请确认成年并接受公约。',
    );
    const secret = text(req.body.token, '邀请', 100);
    const address = email(req.body.email);
    const name = text(req.body.name, '称呼', 30);
    const hash = passwordHash(req.body.password);
    const uid = tx(() => {
      const inv = one('SELECT * FROM invites WHERE token_hash=?', digest(secret));
      ensure(
        inv && !inv.revoked && !inv.used_by && inv.expires_at > now(),
        409,
        '邀请已失效或被领取。',
      );
      ensure(inv.email === address, 403, '请使用邀请绑定的邮箱加入。');
      ensure(
        !one('SELECT id FROM users WHERE email=?', address),
        409,
        '该邮箱已加入，请直接登录。',
      );
      const userId = id();
      run(
        'INSERT INTO users VALUES(?,?,?,?,?,?,1,?,?)',
        userId,
        address,
        name,
        hash,
        'member',
        'probation',
        inv.sponsor_id,
        now(),
      );
      account(userId, 'user', name);
      run('UPDATE invites SET used_by=? WHERE id=?', userId, inv.id);
      audit(userId, 'invitation-accepted', inv.id);
      return userId;
    });
    login(res, uid);
    broadcast();
    res.status(201).json({ ok: true });
  });
  app.post('/api/logout', auth, (req, res) => {
    run('DELETE FROM auth_sessions WHERE token_hash=?', req.user.session_hash);
    for (const c of connections.get(req.user.id) || [])
      if (c.hash === req.user.session_hash) c.response.end();
    res.setHeader(
      'Set-Cookie',
      `cloud_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secureCookie ? '; Secure' : ''}`,
    );
    res.json({ ok: true });
  });

  app.get('/api/state', auth, (req, res) => {
    const u = req.user;
    const session = active();
    const book = session ? one('SELECT * FROM books WHERE id=?', session.book_id) : null;
    const passages = book
      ? all('SELECT * FROM passages WHERE book_id=? ORDER BY ordinal', book.id)
      : [];
    const users = all(
      "SELECT id,name,status,role,created_at FROM users WHERE status<>'suspended' ORDER BY created_at",
    );
    const participants = users.map((m) => ({
      ...publicUser(m),
      online: connections.has(m.id),
      hand: hands.get(m.id) || null,
      voice: voice.has(m.id),
    }));
    const bounties = all(
      'SELECT b.*,u.name AS claimant_name FROM bounties b LEFT JOIN users u ON u.id=b.claimant_id ORDER BY b.created_at DESC',
    ).map((b) => ({
      ...b,
      evidence: u.role === 'owner' || b.claimant_id === u.id ? b.evidence : '',
    }));
    res.json({
      user: publicUser(u),
      world: worldSnapshot(),
      session,
      book,
      passages,
      participants,
      books: all('SELECT * FROM books ORDER BY created_at DESC'),
      notes: all(
        'SELECT n.*,u.name AS author_name FROM notes n JOIN users u ON u.id=n.user_id WHERE (n.user_id=? OR n.shared=1) AND n.passage_id IN (SELECT id FROM passages WHERE book_id=?) ORDER BY n.created_at DESC',
        u.id,
        book?.id || '',
      ),
      history: all(
        "SELECT s.id,s.title,s.artifact,s.created_at,b.title AS book_title FROM reading_sessions s JOIN books b ON b.id=s.book_id WHERE s.artifact<>'' ORDER BY s.created_at DESC",
      ),
      wallet: {
        balance: one('SELECT balance FROM accounts WHERE id=?', u.id).balance,
        transactions: all(
          'SELECT t.id,t.memo,t.created_at,e.amount FROM ledger_entries e JOIN ledger_transactions t ON t.id=e.transaction_id WHERE e.account_id=? ORDER BY e.id DESC LIMIT 60',
          u.id,
        ),
        contributions: all(
          'SELECT * FROM contributions WHERE user_id=? ORDER BY created_at DESC',
          u.id,
        ),
        treasury: one("SELECT balance FROM accounts WHERE id='treasury'").balance,
        supply: one("SELECT SUM(balance) AS value FROM accounts WHERE kind<>'issuance'").value,
      },
      bounties,
      offers: all(
        "SELECT o.*,u.name AS seller_name FROM offers o JOIN users u ON u.id=o.seller_id WHERE o.active=1 AND u.status='resident' ORDER BY o.created_at DESC",
      ),
      orders: all(
        "SELECT o.*,f.title,b.name AS buyer_name,s.name AS seller_name FROM orders o JOIN offers f ON f.id=o.offer_id JOIN users b ON b.id=o.buyer_id JOIN users s ON s.id=o.seller_id WHERE o.buyer_id=? OR o.seller_id=? OR ?='owner' ORDER BY o.created_at DESC",
        u.id,
        u.id,
        u.role,
      ),
      invites:
        u.role === 'owner'
          ? all(
              'SELECT id,email,expires_at,used_by,revoked,created_at FROM invites ORDER BY created_at DESC',
            )
          : [],
      members:
        u.role === 'owner'
          ? all('SELECT id,name,email,status,role,created_at FROM users ORDER BY created_at')
          : [],
      rtc: { iceServers, mode: iceServers.length ? 'configured' : 'local' },
    });
  });
  app.get('/api/events', auth, (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const c = { response: res, hash: req.user.session_hash };
    if (!connections.has(req.user.id)) connections.set(req.user.id, new Set());
    connections.get(req.user.id).add(c);
    send(res, 'ready', {});
    broadcastWorld();
    broadcast();
    req.on('close', () => {
      const set = connections.get(req.user.id);
      set?.delete(c);
      if (set && !set.size) {
        connections.delete(req.user.id);
        hands.delete(req.user.id);
        voice.delete(req.user.id);
        worldPositions.delete(req.user.id);
      }
      broadcastWorld();
      broadcast();
    });
  });
  app.post('/api/world/move', auth, (req, res) => {
    ensure(connections.has(req.user.id), 409, '请先连接庭院，再移动角色。');
    const p = worldPosition(req.user.id);
    const { x, y, facing = 'down', skin = p.skin } = req.body;
    ensure(walkable(x, y), 400, '这里是建筑或水面，不能通行。');
    ensure(
      ['up', 'down', 'left', 'right'].includes(facing) &&
        Number.isInteger(skin) &&
        skin >= 0 &&
        skin < 6,
      400,
      '无效的角色设置。',
    );
    ensure(Math.abs(x - p.x) + Math.abs(y - p.y) <= 1, 409, '请逐格移动，不可穿越地图。');
    ensure(Date.now() - p.movedAt >= 75, 429, '走慢一点，等脚步跟上。');
    Object.assign(p, { x, y, facing, skin, movedAt: Date.now() });
    broadcastWorld();
    res.json({ ok: true });
  });
  app.post('/api/world/emote', auth, (req, res) => {
    ensure(connections.has(req.user.id), 409, '请先连接庭院。');
    ensure(['wave', 'heart', 'idea'].includes(req.body.emote), 400, '这个表情还没有加入庭院。');
    const p = worldPosition(req.user.id);
    ensure(Date.now() - (p.emoteUntil - 4500) > 1500, 429, '稍等片刻再打招呼吧。');
    p.emote = req.body.emote;
    p.emoteUntil = Date.now() + 4500;
    broadcastWorld();
    res.json({ ok: true });
  });

  const heartbeat = setInterval(() => {
    for (const [uid, set] of connections)
      for (const c of set) {
        if (
          !one(
            "SELECT s.user_id FROM auth_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.status<>'suspended'",
            c.hash,
            now(),
          )
        )
          c.response.end();
        else c.response.write(': heartbeat\n\n');
      }
    for (const [key, bucket] of rateBuckets)
      if (bucket.until <= Date.now()) rateBuckets.delete(key);
  }, 15000);
  heartbeat.unref();

  app.post('/api/invites', auth, (req, res) => {
    owner(req);
    ensure(req.body.knownAdult === true, 400, '请确认是你直接认识的成年伙伴。');
    const address = email(req.body.email);
    ensure(!one('SELECT id FROM users WHERE email=?', address), 409, '这位伙伴已经加入。');
    const secret = token();
    const inviteId = id();
    tx(() => {
      run('UPDATE invites SET revoked=1 WHERE email=? AND used_by IS NULL', address);
      run(
        'INSERT INTO invites(id,token_hash,email,sponsor_id,expires_at,created_at) VALUES(?,?,?,?,?,?)',
        inviteId,
        digest(secret),
        address,
        req.user.id,
        new Date(Date.now() + 7 * 86400000).toISOString(),
        now(),
      );
      audit(req.user.id, 'invite-created', inviteId);
    });
    publish(res, { token: secret, id: inviteId });
  });
  app.post('/api/invites/:id/revoke', auth, (req, res) => {
    owner(req);
    run('UPDATE invites SET revoked=1 WHERE id=? AND used_by IS NULL', req.params.id);
    publish(res);
  });
  app.post('/api/members/:id/approve', auth, (req, res) => {
    owner(req);
    const result = moneyOperation(
      req.user.id,
      req.body.operationId,
      { action: 'approve', id: req.params.id },
      (key) => {
        const member = one('SELECT * FROM users WHERE id=?', req.params.id);
        ensure(member?.status === 'probation', 409, '该成员不是待确认的试住成员。');
        if (!setting(`welcome:${member.id}`)) {
          post(key, req.user.id, `常住起步额度 · ${member.name}`, [
            { account: 'treasury', amount: -20 },
            { account: member.id, amount: 20 },
          ]);
          store.setSetting(`welcome:${member.id}`, '1');
        }
        run("UPDATE users SET status='resident' WHERE id=?", member.id);
        audit(req.user.id, 'member-approved', member.id);
        return { ok: true };
      },
    );
    publish(res, result);
  });
  app.post('/api/members/:id/suspend', auth, (req, res) => {
    owner(req);
    ensure(req.params.id !== req.user.id, 400, '不能暂停自己的管理员账户。');
    ensure(active()?.leader_id !== req.params.id, 409, '请先更换本场领读人。');
    tx(() => {
      run("UPDATE users SET status='suspended' WHERE id=? AND role<>'owner'", req.params.id);
      run('DELETE FROM auth_sessions WHERE user_id=?', req.params.id);
      audit(req.user.id, 'member-suspended', req.params.id);
    });
    disconnect(req.params.id);
    publish(res);
  });
  app.post('/api/members/:id/restore', auth, (req, res) => {
    owner(req);
    run("UPDATE users SET status='probation' WHERE id=? AND status='suspended'", req.params.id);
    audit(req.user.id, 'member-restored', req.params.id);
    publish(res);
  });

  app.post('/api/books', auth, (req, res) => {
    owner(req);
    ensure(req.body.hasRights === true, 400, '请确认你有权在小组中使用这份文本。');
    const title = text(req.body.title, '书名', 100);
    const author = text(req.body.author || '未署名', '作者', 100);
    const source = text(req.body.source, '来源与使用权说明', 1000);
    const content = text(req.body.content, '文本', 60000);
    const paragraphs = content
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter(Boolean);
    ensure(paragraphs.length >= 2 && paragraphs.length <= 200, 400, '请用空行分成 2—200 个段落。');
    const bookId = tx(() => store.createBook({ title, author, source, paragraphs }));
    publish(res, { id: bookId });
  });
  app.post('/api/sessions', auth, (req, res) => {
    owner(req);
    const title = text(req.body.title, '共读名称', 100);
    ensure(one('SELECT id FROM books WHERE id=?', req.body.bookId || ''), 404, '书目不存在。');
    ensure(
      one("SELECT id FROM users WHERE id=? AND status='resident'", req.body.leaderId || ''),
      400,
      '请选择常住成员担任领读人。',
    );
    const sessionId = tx(() => store.startSession(title, req.body.bookId, req.body.leaderId));
    hands.clear();
    publish(res, { id: sessionId });
  });
  app.post('/api/reading', auth, (req, res) => {
    const s = leader(req);
    ensure(PHASES.includes(req.body.phase), 400, '无效的活动阶段。');
    const count = one('SELECT COUNT(*) AS n FROM passages WHERE book_id=?', s.book_id).n;
    ensure(
      Number.isInteger(req.body.anchorIndex) &&
        req.body.anchorIndex >= 0 &&
        req.body.anchorIndex < count,
      400,
      '无效的段落。',
    );
    run(
      'UPDATE reading_sessions SET phase=?,anchor_index=?,started_at=COALESCE(started_at,?) WHERE id=?',
      req.body.phase,
      req.body.anchorIndex,
      now(),
      s.id,
    );
    publish(res);
  });
  app.post('/api/hand', auth, (req, res) => {
    req.body.raised ? hands.set(req.user.id, now()) : hands.delete(req.user.id);
    publish(res);
  });
  app.post('/api/hands/:id/lower', auth, (req, res) => {
    leader(req);
    hands.delete(req.params.id);
    publish(res);
  });
  app.post('/api/notes', auth, (req, res) => {
    ensure(
      one('SELECT id FROM passages WHERE id=?', req.body.passageId || ''),
      404,
      '原文段落不存在。',
    );
    const body = text(req.body.body, '笔记', 5000);
    ensure(NOTE_KINDS.includes(req.body.kind), 400, '无效的笔记类型。');
    const noteId = id();
    run(
      'INSERT INTO notes VALUES(?,?,?,?,?,?,?,?)',
      noteId,
      req.user.id,
      req.body.passageId,
      body,
      req.body.kind,
      req.body.shared === true ? 1 : 0,
      now(),
      now(),
    );
    publish(res, { id: noteId });
  });
  app.post('/api/notes/:id/visibility', auth, (req, res) => {
    const note = one('SELECT * FROM notes WHERE id=?', req.params.id);
    ensure(note?.user_id === req.user.id, 403, '只有作者能改变分享范围。');
    run(
      'UPDATE notes SET shared=?,updated_at=? WHERE id=?',
      req.body.shared === true ? 1 : 0,
      now(),
      note.id,
    );
    publish(res);
  });
  app.delete('/api/notes/:id', auth, (req, res) => {
    const note = one('SELECT * FROM notes WHERE id=?', req.params.id);
    ensure(note?.user_id === req.user.id, 403, '只有作者能删除自己的笔记。');
    run('DELETE FROM notes WHERE id=?', note.id);
    publish(res);
  });
  app.post('/api/artifact', auth, (req, res) => {
    const s = leader(req);
    const body = text(req.body.body, '共同成果', 15000);
    ensure(req.body.revision === s.revision, 409, '成果已被更新，请刷新后再整理。');
    run('UPDATE reading_sessions SET artifact=?,revision=revision+1 WHERE id=?', body, s.id);
    publish(res);
  });

  app.post('/api/bounties', auth, (req, res) => {
    owner(req);
    const title = text(req.body.title, '任务标题', 100);
    const description = text(req.body.description, '交付标准', 3000);
    const reward = positiveAmount(req.body.reward);
    const result = moneyOperation(
      req.user.id,
      req.body.operationId,
      { action: 'bounty-create', title, description, reward },
      (key) => {
        const bid = id();
        account(`bounty:${bid}`, 'escrow', title);
        post(key, req.user.id, `锁定贡献预算 · ${title}`, [
          { account: 'treasury', amount: -reward },
          { account: `bounty:${bid}`, amount: reward },
        ]);
        run(
          'INSERT INTO bounties(id,title,description,reward,state,creator_id,created_at) VALUES(?,?,?,?,?,?,?)',
          bid,
          title,
          description,
          reward,
          'open',
          req.user.id,
          now(),
        );
        return { id: bid };
      },
    );
    publish(res, result);
  });
  app.post('/api/bounties/:id/claim', auth, (req, res) => {
    resident(req);
    tx(() => {
      const b = one('SELECT * FROM bounties WHERE id=?', req.params.id);
      ensure(b?.state === 'open', 409, '任务已被领取或关闭。');
      ensure(b.creator_id !== req.user.id, 403, '不能领取由自己验收的任务。');
      run("UPDATE bounties SET state='claimed',claimant_id=? WHERE id=?", req.user.id, b.id);
    });
    publish(res);
  });
  app.post('/api/bounties/:id/withdraw', auth, (req, res) => {
    const b = one('SELECT * FROM bounties WHERE id=?', req.params.id);
    ensure(
      b?.claimant_id === req.user.id && b.state === 'claimed',
      409,
      '只能归还自己尚未提交的任务。',
    );
    run(
      "UPDATE bounties SET state='open',claimant_id=NULL,evidence='',review_note='' WHERE id=?",
      b.id,
    );
    publish(res);
  });
  app.post('/api/bounties/:id/submit', auth, (req, res) => {
    resident(req);
    const b = one('SELECT * FROM bounties WHERE id=?', req.params.id);
    ensure(
      b?.claimant_id === req.user.id && b.state === 'claimed',
      403,
      '只能提交自己正在完成的任务。',
    );
    const evidence = text(req.body.evidence, '交付说明', 6000);
    run("UPDATE bounties SET state='submitted',evidence=? WHERE id=?", evidence, b.id);
    publish(res);
  });
  app.post('/api/bounties/:id/review', auth, (req, res) => {
    owner(req);
    const result = moneyOperation(
      req.user.id,
      req.body.operationId,
      {
        action: 'review',
        id: req.params.id,
        accept: req.body.accept,
        reviewNote: req.body.reviewNote || '',
      },
      (key) => {
        const b = one('SELECT * FROM bounties WHERE id=?', req.params.id);
        ensure(
          b?.state === 'submitted' && b.claimant_id !== req.user.id,
          409,
          '任务不在可验收状态，或存在利益冲突。',
        );
        if (req.body.accept === true) {
          post(key, req.user.id, `贡献验收 · ${b.title}`, [
            { account: `bounty:${b.id}`, amount: -b.reward },
            { account: b.claimant_id, amount: b.reward },
          ]);
          run("UPDATE bounties SET state='completed' WHERE id=?", b.id);
          run(
            'INSERT INTO contributions VALUES(?,?,?,?,?,?)',
            id(),
            b.claimant_id,
            b.id,
            b.title,
            'bounty',
            now(),
          );
        } else {
          const note = text(req.body.reviewNote, '补充说明', 1000);
          run("UPDATE bounties SET state='claimed',review_note=? WHERE id=?", note, b.id);
        }
        return { ok: true };
      },
    );
    publish(res, result);
  });
  app.post('/api/bounties/:id/cancel', auth, (req, res) => {
    owner(req);
    const result = moneyOperation(
      req.user.id,
      req.body.operationId,
      { action: 'cancel-bounty', id: req.params.id },
      (key) => {
        const b = one('SELECT * FROM bounties WHERE id=?', req.params.id);
        ensure(b?.state === 'open', 409, '仅能取消尚未被领取的任务；已领取任务需要先协商处理。');
        post(key, req.user.id, `退回未领取预算 · ${b.title}`, [
          { account: `bounty:${b.id}`, amount: -b.reward },
          { account: 'treasury', amount: b.reward },
        ]);
        run("UPDATE bounties SET state='cancelled' WHERE id=?", b.id);
        return { ok: true };
      },
    );
    publish(res, result);
  });
  app.post('/api/offers', auth, (req, res) => {
    resident(req);
    const title = text(req.body.title, '服务名称', 100);
    const description = text(req.body.description, '服务约定', 3000);
    const price = positiveAmount(req.body.price);
    const oid = id();
    run(
      'INSERT INTO offers VALUES(?,?,?,?,?,1,?)',
      oid,
      req.user.id,
      title,
      description,
      price,
      now(),
    );
    publish(res, { id: oid });
  });
  app.post('/api/offers/:id/close', auth, (req, res) => {
    const offer = one('SELECT * FROM offers WHERE id=?', req.params.id);
    ensure(offer?.seller_id === req.user.id, 403, '只有提供者能下架服务。');
    run('UPDATE offers SET active=0 WHERE id=?', offer.id);
    publish(res);
  });
  app.post('/api/orders', auth, (req, res) => {
    resident(req);
    const result = moneyOperation(
      req.user.id,
      req.body.operationId,
      { action: 'order', offerId: req.body.offerId },
      (key) => {
        const offer = one(
          "SELECT o.* FROM offers o JOIN users u ON u.id=o.seller_id WHERE o.id=? AND o.active=1 AND u.status='resident'",
          req.body.offerId || '',
        );
        ensure(offer, 404, '服务不存在或已下架。');
        ensure(offer.seller_id !== req.user.id, 400, '不能购买自己的服务。');
        const orderId = id();
        account(`order:${orderId}`, 'escrow', offer.title);
        post(key, req.user.id, `托管服务款 · ${offer.title}`, [
          { account: req.user.id, amount: -offer.price },
          { account: `order:${orderId}`, amount: offer.price },
        ]);
        run(
          'INSERT INTO orders(id,offer_id,buyer_id,seller_id,price,state,created_at) VALUES(?,?,?,?,?,?,?)',
          orderId,
          offer.id,
          req.user.id,
          offer.seller_id,
          offer.price,
          'funded',
          now(),
        );
        return { id: orderId };
      },
    );
    publish(res, result);
  });
  app.post('/api/orders/:id/deliver', auth, (req, res) => {
    resident(req);
    const order = one('SELECT * FROM orders WHERE id=?', req.params.id);
    ensure(
      order?.seller_id === req.user.id && order.state === 'funded',
      403,
      '只有提供者能提交待交付订单。',
    );
    const delivery = text(req.body.delivery, '交付说明', 6000);
    run("UPDATE orders SET state='delivered',delivery=? WHERE id=?", delivery, order.id);
    publish(res);
  });
  app.post('/api/orders/:id/settle', auth, (req, res) => {
    resident(req);
    const result = moneyOperation(
      req.user.id,
      req.body.operationId,
      { action: 'settle', id: req.params.id },
      (key) => {
        const o = one('SELECT * FROM orders WHERE id=?', req.params.id);
        ensure(
          o?.buyer_id === req.user.id && o.state === 'delivered',
          409,
          '只有委托人能确认已交付的服务。',
        );
        post(key, req.user.id, '服务验收结算', [
          { account: `order:${o.id}`, amount: -o.price },
          { account: o.seller_id, amount: o.price },
        ]);
        run("UPDATE orders SET state='completed' WHERE id=?", o.id);
        run(
          'INSERT INTO contributions VALUES(?,?,?,?,?,?)',
          id(),
          o.seller_id,
          o.id,
          '完成委托服务',
          'service',
          now(),
        );
        return { ok: true };
      },
    );
    publish(res, result);
  });
  app.post('/api/orders/:id/refund', auth, (req, res) => {
    const result = moneyOperation(
      req.user.id,
      req.body.operationId,
      { action: 'refund', id: req.params.id },
      (key) => {
        const o = one('SELECT * FROM orders WHERE id=?', req.params.id);
        ensure(
          o?.state === 'funded' && [o.buyer_id, o.seller_id].includes(req.user.id),
          409,
          '未交付前，任一方可以取消并退款。',
        );
        post(key, req.user.id, '未交付服务退款', [
          { account: `order:${o.id}`, amount: -o.price },
          { account: o.buyer_id, amount: o.price },
        ]);
        run("UPDATE orders SET state='refunded' WHERE id=?", o.id);
        return { ok: true };
      },
    );
    publish(res, result);
  });
  app.post('/api/orders/:id/dispute', auth, (req, res) => {
    const o = one('SELECT * FROM orders WHERE id=?', req.params.id);
    ensure(
      o?.state === 'delivered' && [o.buyer_id, o.seller_id].includes(req.user.id),
      403,
      '该订单不能申请复核。',
    );
    run("UPDATE orders SET state='disputed' WHERE id=?", o.id);
    audit(req.user.id, 'order-disputed', o.id);
    publish(res);
  });
  app.post('/api/orders/:id/agreement', auth, (req, res) => {
    ensure(typeof req.body.refund === 'boolean', 400, '请选择协商结果。');
    const result = moneyOperation(
      req.user.id,
      req.body.operationId,
      { action: 'agreement', id: req.params.id, refund: req.body.refund },
      (key) => {
        const o = one('SELECT * FROM orders WHERE id=?', req.params.id);
        ensure(
          o?.state === 'disputed' && [o.buyer_id, o.seller_id].includes(req.user.id),
          403,
          '只有争议当事人能确认协商结果。',
        );
        store.setSetting(`agreement:${o.id}:${req.user.id}`, String(req.body.refund));
        const other = req.user.id === o.buyer_id ? o.seller_id : o.buyer_id;
        if (setting(`agreement:${o.id}:${other}`) !== String(req.body.refund))
          return { agreed: false };
        post(key, req.user.id, req.body.refund ? '双方协商退款' : '双方协商结算', [
          { account: `order:${o.id}`, amount: -o.price },
          { account: req.body.refund ? o.buyer_id : o.seller_id, amount: o.price },
        ]);
        run(
          'UPDATE orders SET state=? WHERE id=?',
          req.body.refund ? 'refunded' : 'completed',
          o.id,
        );
        if (!req.body.refund)
          run(
            'INSERT INTO contributions VALUES(?,?,?,?,?,?)',
            id(),
            o.seller_id,
            o.id,
            '完成委托服务（双方协商）',
            'service',
            now(),
          );
        audit(req.user.id, 'order-agreement', o.id);
        return { agreed: true };
      },
    );
    publish(res, result);
  });
  app.post('/api/orders/:id/resolve', auth, (req, res) => {
    owner(req);
    const result = moneyOperation(
      req.user.id,
      req.body.operationId,
      { action: 'resolve', id: req.params.id, refund: req.body.refund },
      (key) => {
        const o = one('SELECT * FROM orders WHERE id=?', req.params.id);
        ensure(o?.state === 'disputed', 409, '该订单不在复核中。');
        ensure(
          ![o.buyer_id, o.seller_id].includes(req.user.id),
          403,
          '管理员是交易当事人，不能自行裁决；请线下协商后安排独立复核。',
        );
        ensure(typeof req.body.refund === 'boolean', 400, '请选择处理结果。');
        const recipient = req.body.refund ? o.buyer_id : o.seller_id;
        post(key, req.user.id, req.body.refund ? '争议复核退款' : '争议复核结算', [
          { account: `order:${o.id}`, amount: -o.price },
          { account: recipient, amount: o.price },
        ]);
        run(
          'UPDATE orders SET state=? WHERE id=?',
          req.body.refund ? 'refunded' : 'completed',
          o.id,
        );
        if (!req.body.refund)
          run(
            'INSERT INTO contributions VALUES(?,?,?,?,?,?)',
            id(),
            o.seller_id,
            o.id,
            '完成委托服务（复核确认）',
            'service',
            now(),
          );
        audit(req.user.id, 'order-resolved', o.id);
        return { ok: true };
      },
    );
    publish(res, result);
  });
  app.post('/api/donate', auth, (req, res) => {
    resident(req);
    const amount = positiveAmount(req.body.amount);
    const result = moneyOperation(
      req.user.id,
      req.body.operationId,
      { action: 'donate', amount },
      (key) => {
        post(key, req.user.id, '自愿支持公共愿力池', [
          { account: req.user.id, amount: -amount },
          { account: 'treasury', amount },
        ]);
        return { ok: true };
      },
    );
    publish(res, result);
  });
  app.get('/api/audit', auth, (req, res) => {
    owner(req);
    const unbalanced = all(
      'SELECT transaction_id,SUM(amount) AS total FROM ledger_entries GROUP BY transaction_id HAVING SUM(amount)<>0',
    );
    const mismatches = all(
      'SELECT a.id,a.balance,COALESCE(SUM(e.amount),0) AS calculated FROM accounts a LEFT JOIN ledger_entries e ON e.account_id=a.id GROUP BY a.id HAVING a.balance<>COALESCE(SUM(e.amount),0)',
    );
    res.json({
      ok: !unbalanced.length && !mismatches.length,
      unbalanced,
      mismatches,
      supply: one("SELECT SUM(balance) AS n FROM accounts WHERE kind<>'issuance'").n,
      issuance: -one("SELECT balance FROM accounts WHERE id='issuance'").balance,
    });
  });
  app.get('/api/export', auth, (req, res) => {
    res.setHeader('Content-Disposition', 'attachment; filename="cloud-reading-export.json"');
    res.json({
      exportedAt: now(),
      user: publicUser(req.user),
      notes: all(
        'SELECT n.*,p.body AS original,b.title AS book_title FROM notes n JOIN passages p ON p.id=n.passage_id JOIN books b ON b.id=p.book_id WHERE n.user_id=?',
        req.user.id,
      ),
      artifacts: all("SELECT title,artifact,created_at FROM reading_sessions WHERE artifact<>''"),
      contributions: all('SELECT * FROM contributions WHERE user_id=?', req.user.id),
      transactions: all(
        'SELECT t.memo,t.created_at,e.amount FROM ledger_entries e JOIN ledger_transactions t ON t.id=e.transaction_id WHERE e.account_id=? ORDER BY e.id',
        req.user.id,
      ),
    });
  });
  app.post('/api/voice', auth, (req, res) => {
    ensure(connections.has(req.user.id), 409, '请先恢复房间实时连接。');
    if (req.body.enabled === true)
      ensure(
        voice.has(req.user.id) || voice.size < 6,
        409,
        '首版直连语音最多同时 6 人；文字共读不受影响。',
      );
    req.body.enabled === true ? voice.add(req.user.id) : voice.delete(req.user.id);
    publish(res);
  });
  app.post('/api/signal', auth, (req, res) => {
    ensure(voice.has(req.user.id) && voice.has(req.body.to), 403, '语音双方都需要主动加入房间。');
    ensure(['offer', 'answer', 'candidate'].includes(req.body.type), 400, '无效的语音信令。');
    ensure(
      req.body.to !== req.user.id && req.body.payload && typeof req.body.payload === 'object',
      400,
      '无效的语音目标。',
    );
    for (const c of connections.get(req.body.to) || [])
      send(c.response, 'signal', {
        from: req.user.id,
        type: req.body.type,
        payload: req.body.payload,
      });
    res.json({ ok: true });
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: '接口不存在。' }));
  const dist = join(ROOT, 'dist');
  if (existsSync(dist)) {
    app.use(express.static(dist));
    app.get('/{*path}', (_req, res) => res.sendFile(join(dist, 'index.html')));
  } else
    app.get('/', (_req, res) =>
      res.type('text').send('网页尚未构建。请运行 npm run build，或使用 npm run dev。'),
    );
  app.use((error, _req, res, _next) => {
    if (res.headersSent) return res.end();
    if (error.type === 'entity.too.large')
      return res.status(413).json({ error: '内容过长，请缩短后再提交。' });
    if (error instanceof SyntaxError && 'body' in error)
      return res.status(400).json({ error: '请求格式不正确。' });
    const status = error.status || 500;
    if (status >= 500) console.error('服务内部错误：', error.message);
    res
      .status(status)
      .json({ error: status >= 500 ? '操作未完成，数据未确认保存。请稍后重试。' : error.message });
  });
  const server = createServer(app);
  return {
    app,
    server,
    store,
    bootstrapCode,
    close: async () => {
      clearInterval(heartbeat);
      for (const uid of [...connections.keys()]) disconnect(uid);
      await new Promise((resolveClose) => server.close(resolveClose));
      store.db.close();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const application = createApplication();
  const port = Number(process.env.PORT || 4317);
  const host = process.env.HOST || '127.0.0.1';
  application.server.listen(port, host, () => {
    console.log(`云间共读已启动：http://${host}:${port}`);
    if (!application.store.one("SELECT id FROM users WHERE role='owner'"))
      console.log(
        `首次建站码：${application.bootstrapCode}\n请在网页建立管理员；不要将建站码发给受邀成员。`,
      );
    console.log('仅本地运行，不会自动发布到公网；数据库位于私有数据目录。');
  });
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, () => application.close().then(() => process.exit(0)));
}
