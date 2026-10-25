import { DatabaseSync } from 'node:sqlite';
import { randomUUID, randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SAMPLE_BOOK } from './sample.mjs';

export const id = () => randomUUID();
export const now = () => new Date().toISOString();
export const digest = (value) => createHash('sha256').update(value).digest('hex');
export const token = () => randomBytes(32).toString('hex');
export const publicUser = (u) => ({
  id: u.id,
  name: u.name,
  status: u.status,
  role: u.role,
  createdAt: u.created_at,
});
export class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export const ensure = (condition, status, message) => {
  if (!condition) throw new AppError(status, message);
};
export function text(value, label, max = 5000, min = 1) {
  ensure(
    typeof value === 'string' && value.trim().length >= min && value.trim().length <= max,
    400,
    `${label}需为 ${min}—${max} 个字符。`,
  );
  return value.trim();
}
export function email(value) {
  const result = text(value, '邮箱', 180).toLowerCase();
  ensure(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result), 400, '请填写有效的受邀邮箱。');
  return result;
}
export function passwordHash(value) {
  text(value, '密码', 128, 12);
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(value, salt, 64).toString('hex')}`;
}
export function passwordMatches(value, encoded) {
  if (typeof value !== 'string' || value.length > 128) return false;
  const [salt, hex] = encoded.split(':');
  const actual = scryptSync(value, salt, 64);
  return timingSafeEqual(actual, Buffer.from(hex, 'hex'));
}

export function createStore(filename) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA foreign_keys=ON;
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=FULL;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('owner','member')), status TEXT NOT NULL CHECK(status IN ('probation','resident','suspended')),
      adult_accepted INTEGER NOT NULL CHECK(adult_accepted=1), sponsor_id TEXT REFERENCES users(id), created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auth_sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS invites (
      id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, email TEXT NOT NULL, sponsor_id TEXT NOT NULL REFERENCES users(id),
      expires_at TEXT NOT NULL, used_by TEXT REFERENCES users(id), revoked INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS books (id TEXT PRIMARY KEY, title TEXT NOT NULL, author TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS passages (id TEXT PRIMARY KEY, book_id TEXT NOT NULL REFERENCES books(id), ordinal INTEGER NOT NULL, body TEXT NOT NULL, UNIQUE(book_id,ordinal));
    CREATE TABLE IF NOT EXISTS reading_sessions (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, book_id TEXT NOT NULL REFERENCES books(id), leader_id TEXT NOT NULL REFERENCES users(id),
      phase TEXT NOT NULL DEFAULT 'gathering', anchor_index INTEGER NOT NULL DEFAULT 0, started_at TEXT,
      artifact TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), passage_id TEXT NOT NULL REFERENCES passages(id),
      body TEXT NOT NULL, kind TEXT NOT NULL, shared INTEGER NOT NULL DEFAULT 0 CHECK(shared IN(0,1)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN('user','treasury','escrow','issuance')),
      label TEXT NOT NULL, balance INTEGER NOT NULL DEFAULT 0,
      CHECK(kind='issuance' OR balance>=0)
    );
    CREATE TABLE IF NOT EXISTS ledger_transactions (
      id TEXT PRIMARY KEY, operation_key TEXT NOT NULL UNIQUE, payload_hash TEXT NOT NULL, actor_id TEXT,
      memo TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ledger_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT, transaction_id TEXT NOT NULL REFERENCES ledger_transactions(id),
      account_id TEXT NOT NULL REFERENCES accounts(id), amount INTEGER NOT NULL CHECK(amount<>0)
    );
    CREATE INDEX IF NOT EXISTS ledger_account ON ledger_entries(account_id,id);
    CREATE INDEX IF NOT EXISTS notes_owner ON notes(user_id,passage_id);
    CREATE TABLE IF NOT EXISTS bounties (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL, reward INTEGER NOT NULL CHECK(reward>0),
      state TEXT NOT NULL CHECK(state IN('open','claimed','submitted','completed','cancelled')),
      creator_id TEXT NOT NULL REFERENCES users(id), claimant_id TEXT REFERENCES users(id), evidence TEXT NOT NULL DEFAULT '',
      review_note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS offers (
      id TEXT PRIMARY KEY, seller_id TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL, description TEXT NOT NULL,
      price INTEGER NOT NULL CHECK(price>0), active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY, offer_id TEXT NOT NULL REFERENCES offers(id), buyer_id TEXT NOT NULL REFERENCES users(id),
      seller_id TEXT NOT NULL REFERENCES users(id), price INTEGER NOT NULL,
      state TEXT NOT NULL CHECK(state IN('funded','delivered','completed','refunded','disputed')),
      delivery TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS contributions (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), reference_id TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL, kind TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY, actor_id TEXT, action TEXT NOT NULL, subject_id TEXT, created_at TEXT NOT NULL
    );
  `);
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const tx = (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };
  const setting = (key) => one('SELECT value FROM settings WHERE key=?', key)?.value;
  const setSetting = (key, value) =>
    run(
      'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      key,
      String(value),
    );
  const account = (accountId, kind, label) =>
    run(
      'INSERT OR IGNORE INTO accounts(id,kind,label,balance) VALUES(?,?,?,0)',
      accountId,
      kind,
      label,
    );
  const audit = (actor, action, subject) =>
    run('INSERT INTO audit_events VALUES(?,?,?,?,?)', id(), actor, action, subject, now());

  // 只从这个入口记账；调用者须处于同一数据库事务中。
  const post = (operationKey, actor, memo, entries) => {
    ensure(
      entries.length > 1 && entries.every((e) => Number.isSafeInteger(e.amount) && e.amount !== 0),
      400,
      '无效的记账分录。',
    );
    ensure(entries.reduce((sum, e) => sum + e.amount, 0) === 0, 500, '账目不平衡，交易未执行。');
    const payloadHash = digest(JSON.stringify({ actor, memo, entries }));
    const previous = one('SELECT * FROM ledger_transactions WHERE operation_key=?', operationKey);
    if (previous) {
      ensure(previous.payload_hash === payloadHash, 409, '该操作编号已用于另一笔交易。');
      return previous.id;
    }
    const totals = new Map();
    for (const entry of entries)
      totals.set(entry.account, (totals.get(entry.account) || 0) + entry.amount);
    for (const [accountId, delta] of totals) {
      const a = one('SELECT * FROM accounts WHERE id=?', accountId);
      ensure(a, 500, '账户不存在。');
      ensure(Number.isSafeInteger(a.balance + delta), 400, '余额超出允许范围。');
      ensure(a.kind === 'issuance' || a.balance + delta >= 0, 409, '可用功德币不足。');
    }
    const transactionId = id();
    run(
      'INSERT INTO ledger_transactions VALUES(?,?,?,?,?,?)',
      transactionId,
      operationKey,
      payloadHash,
      actor,
      memo,
      now(),
    );
    for (const entry of entries)
      run(
        'INSERT INTO ledger_entries(transaction_id,account_id,amount) VALUES(?,?,?)',
        transactionId,
        entry.account,
        entry.amount,
      );
    for (const [accountId, delta] of totals)
      run('UPDATE accounts SET balance=balance+? WHERE id=?', delta, accountId);
    return transactionId;
  };
  const moneyOperation = (actor, key, payload, fn) =>
    tx(() => {
      text(key, '操作编号', 100, 8);
      const opKey = `${actor}:${key}`;
      const serialized = digest(JSON.stringify(payload));
      const existing = one('SELECT value FROM settings WHERE key=?', `operation:${opKey}`);
      if (existing) {
        const saved = JSON.parse(existing.value);
        ensure(saved.hash === serialized, 409, '请勿复用其他操作的编号。');
        return saved.result;
      }
      const result = fn(opKey);
      setSetting(`operation:${opKey}`, JSON.stringify({ hash: serialized, result }));
      return result;
    });
  const createBook = ({ title, author, source, paragraphs }) => {
    const bookId = id();
    run('INSERT INTO books VALUES(?,?,?,?,?)', bookId, title, author, source, now());
    paragraphs.forEach((body, ordinal) =>
      run('INSERT INTO passages VALUES(?,?,?,?)', id(), bookId, ordinal, body),
    );
    return bookId;
  };
  const startSession = (title, bookId, leaderId) => {
    const old = setting('active_session');
    if (old) run("UPDATE reading_sessions SET phase='ended' WHERE id=?", old);
    const sessionId = id();
    run(
      'INSERT INTO reading_sessions(id,title,book_id,leader_id,created_at) VALUES(?,?,?,?,?)',
      sessionId,
      title,
      bookId,
      leaderId,
      now(),
    );
    setSetting('active_session', sessionId);
    return sessionId;
  };
  if (!setting('initialized'))
    tx(() => {
      account('treasury', 'treasury', '公共愿力池');
      account('issuance', 'issuance', '创世发行对方账户');
      post('genesis', null, '创世发行 1,000 GC；非现金、不可提现', [
        { account: 'treasury', amount: 1000 },
        { account: 'issuance', amount: -1000 },
      ]);
      const bookId = createBook(SAMPLE_BOOK);
      setSetting('sample_book', bookId);
      setSetting('initialized', '1');
    });
  return {
    db,
    one,
    all,
    run,
    tx,
    setting,
    setSetting,
    account,
    post,
    moneyOperation,
    audit,
    createBook,
    startSession,
  };
}
