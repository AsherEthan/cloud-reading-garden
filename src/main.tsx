import { useCallback, useEffect, useRef, useState, type ReactNode, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import {
  BookOpen,
  Leaf,
  Users,
  Coins,
  ShoppingBag,
  ArrowUpRight,
  Hand,
  Mic,
  MicOff,
  LogOut,
  ShieldCheck,
  LockKeyhole,
  ArrowRight,
  Check,
  Copy,
  Download,
  Radio,
  Headphones,
  Sprout,
  ChevronLeft,
  ChevronRight,
  X,
} from 'lucide-react';
import { api, money, message, date, RequestError } from './api';
import { useVoice } from './voice';
import type { AppState, Bounty, Order } from './types';
import { GameShell, WorldBackdrop } from './game/GameShell';
import './styles.css';

const phases: Record<string, string> = {
  gathering: '相聚',
  reading: '静读',
  discussion: '共议',
  reflection: '回照',
  ended: '已结束',
};
const kinds: Record<string, string> = {
  note: '随记',
  question: '问题',
  interpretation: '解释',
  case: '案例',
  counter: '反例',
};
const states: Record<string, string> = {
  open: '待领取',
  claimed: '进行中',
  submitted: '待验收',
  completed: '已完成',
  cancelled: '已取消',
  funded: '已托管',
  delivered: '待确认',
  refunded: '已退款',
  disputed: '复核中',
};
const status: Record<string, string> = {
  probation: '试住伙伴',
  resident: '常住伙伴',
  suspended: '已暂停',
};
const tabs = [
  { id: 'garden', label: '共读庭院', icon: Leaf },
  { id: 'reading', label: '共读室', icon: BookOpen },
  { id: 'wallet', label: '功德账簿', icon: Coins },
  { id: 'market', label: '愿力集市', icon: ShoppingBag },
  { id: 'members', label: '善友与邀请', icon: Users },
];
type Fields = Record<string, string>;
type Perform = (job: () => Promise<unknown>, success?: string) => Promise<boolean>;
const field = (form: HTMLFormElement): Fields =>
  Object.fromEntries([...new FormData(form)].map(([key, value]) => [key, String(value)]));
function ActionForm({
  children,
  submit,
  label = '保存',
  busy,
  secondary = false,
}: {
  children: ReactNode;
  submit: (data: Fields) => Promise<boolean>;
  label?: string;
  busy: boolean;
  secondary?: boolean;
}) {
  const handle = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (await submit(field(form))) form.reset();
  };
  return (
    <form onSubmit={handle} className="action-form">
      <fieldset disabled={busy}>
        {children}
        <button className={secondary ? 'button outline' : 'button'} type="submit">
          {busy ? '处理中…' : label}
          <ArrowRight size={15} />
        </button>
      </fieldset>
    </form>
  );
}
function Input({
  name,
  label,
  type = 'text',
  maxLength = 100,
  ...props
}: {
  name: string;
  label: string;
  type?: string;
  required?: boolean;
  placeholder?: string;
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  defaultValue?: string | number;
  autoComplete?: string;
}) {
  return (
    <label className="field">
      {label}
      <input name={name} type={type} required maxLength={maxLength} {...props} />
    </label>
  );
}
function Area({
  name,
  label,
  ...props
}: {
  name: string;
  label: string;
  placeholder?: string;
  maxLength?: number;
  defaultValue?: string;
  rows?: number;
}) {
  return (
    <label className="field">
      {label}
      <textarea name={name} required maxLength={5000} rows={4} {...props} />
    </label>
  );
}
function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="empty">
      <Sprout size={24} />
      <p>{children}</p>
    </div>
  );
}
function PageTitle({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="page-title">
      <span className="eyebrow">{eyebrow}</span>
      <h1>{title}</h1>
      <p>{children}</p>
    </div>
  );
}
function Badge({ children }: { children: ReactNode }) {
  return <span className="badge">{children}</span>;
}

function App() {
  const [data, setData] = useState<AppState | null>(null);
  const [setup, setSetup] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState('garden');
  const [marketSection, setMarketSection] = useState('bounties');
  useEffect(() => {
    setNotice('');
    window.scrollTo(0, 0);
  }, [tab]);
  const [online, setOnline] = useState(false);
  const [inviteToken, setInviteToken] = useState(
    () => new URLSearchParams(location.hash.slice(1)).get('invite') || '',
  );
  const [invitedEmail, setInvitedEmail] = useState('');
  const serial = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++serial.current;
    try {
      const result = await api<AppState>('/state');
      if (current === serial.current) setData(result);
    } catch (e) {
      if (e instanceof RequestError && e.status === 401) {
        setData(null);
        setOnline(false);
      } else throw e;
    }
  }, []);
  const start = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api<{ needsSetup: boolean }>('/bootstrap');
      setSetup(result.needsSetup);
      if (!result.needsSetup) await refresh();
      if (inviteToken && !result.needsSetup) {
        const inv = await api<{ email: string }>('/invite/preview', { token: inviteToken });
        setInvitedEmail(inv.email);
      }
    } catch (e) {
      setNotice(message(e));
    } finally {
      setLoading(false);
    }
  }, [refresh, inviteToken]);
  useEffect(() => {
    void start();
  }, [start]);
  useEffect(() => {
    if (!data?.user.id) return;
    const events = new EventSource('/api/events');
    let disposed = false;
    const update = () => {
      if (!disposed) void refresh().catch((e) => setNotice(message(e)));
    };
    events.addEventListener('ready', () => {
      setOnline(true);
      update();
    });
    events.addEventListener('refresh', update);
    events.addEventListener('world', (event) =>
      window.dispatchEvent(
        new CustomEvent('cloud-world', { detail: JSON.parse((event as MessageEvent).data) }),
      ),
    );
    events.addEventListener('signal', (event) =>
      window.dispatchEvent(
        new CustomEvent('cloud-signal', { detail: JSON.parse((event as MessageEvent).data) }),
      ),
    );
    events.onerror = () => {
      setOnline(false);
      window.dispatchEvent(new Event('cloud-offline'));
      update();
    };
    const poll = window.setInterval(update, 30000);
    return () => {
      disposed = true;
      events.close();
      clearInterval(poll);
      setOnline(false);
    };
  }, [data?.user.id, refresh]);
  const perform: Perform = async (job, success = '已保存') => {
    if (busy) return false;
    setBusy(true);
    setNotice('');
    try {
      await job();
      await refresh();
      setNotice(success);
      return true;
    } catch (e) {
      setNotice(message(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const voice = useVoice(
    data?.user.id,
    data?.participants || [],
    data?.rtc.iceServers || [],
    setNotice,
  );
  const authSubmit = async (f: Fields) => {
    const path = setup ? '/setup' : inviteToken ? '/join' : '/login';
    return perform(async () => {
      await api(path, {
        ...f,
        token: inviteToken,
        adult: f.adult === 'on',
        agree: f.agree === 'on',
      });
      setSetup(false);
      setInviteToken('');
      history.replaceState(null, '', location.pathname);
    }, '欢迎来到云间共读');
  };
  if (loading)
    return (
      <main className="loading">
        <Leaf size={36} />
        <p>正在打开庭院…</p>
      </main>
    );
  if (!data)
    return (
      <div className="entry game-entry">
        <section className="entry-story">
          <a className="brand" href="/">
            <Leaf />
            <span>
              云间共读<small>CLOUD READING GARDEN</small>
            </span>
          </a>
          <div>
            <span className="eyebrow">一卷书 · 一处相聚</span>
            <h1>
              让理解，
              <br />
              在相遇中生长。
            </h1>
            <p>
              不必急着表达，不必成为谁。
              <br />
              带着一本书、一个问题，来到这里。
            </p>
          </div>
          <WorldBackdrop />
          <div className="entry-foot">
            <LockKeyhole size={14} /> 邀请制善友共学空间 · 仅限成年伙伴
          </div>
        </section>
        <main className="entry-form">
          <div className="entry-card">
            <Badge>
              {setup ? '建立你的第一座庭院' : inviteToken ? '一份来自善友的邀请' : '欢迎回到庭院'}
            </Badge>
            <h2>
              {setup ? '从一次共读开始' : inviteToken ? '一起，读懂更多' : '相聚，继续读下去'}
            </h2>
            <p className="muted">
              {setup
                ? '使用启动终端中的建站码，设置你自己的管理员账户。'
                : inviteToken
                  ? '邀请绑定指定邮箱。加入后可共读，正式确认后开放内部服务。'
                  : '这里不公开注册，请使用受邀时设置的账户登录。'}
            </p>
            {notice && (
              <div role="alert" className="notice">
                {notice}
              </div>
            )}
            <ActionForm
              busy={busy}
              submit={authSubmit}
              label={setup ? '建立庭院' : inviteToken ? '接受邀请并加入' : '进入庭院'}
            >
              {setup && <Input name="code" label="一次性建站码" autoComplete="off" />}
              {(setup || inviteToken) && (
                <Input
                  name="name"
                  label="你希望被怎样称呼"
                  maxLength={30}
                  autoComplete="nickname"
                />
              )}
              <Input
                name="email"
                label="邮箱"
                type="email"
                defaultValue={invitedEmail}
                autoComplete="username"
                maxLength={180}
              />
              <Input
                name="password"
                label={setup || inviteToken ? '设置密码（至少 12 个字符）' : '密码'}
                type="password"
                minLength={setup || inviteToken ? 12 : undefined}
                maxLength={128}
                autoComplete={setup || inviteToken ? 'new-password' : 'current-password'}
              />
              {(setup || inviteToken) && (
                <>
                  <label className="checkbox">
                    <input type="checkbox" name="adult" required />
                    我已成年，理解这里只邀请直接认识的伙伴
                  </label>
                  <label className="checkbox">
                    <input type="checkbox" name="agree" required />
                    我同意尊重差异、保护隐私，不把功德币视为修为评价或现金资产
                  </label>
                </>
              )}
            </ActionForm>
            <p className="fine">私人笔记默认不公开 · 不录音 · 功德币不可充值或提现</p>
            <button className="text-button" onClick={() => void start()}>
              重新检查连接
            </button>
          </div>
        </main>
      </div>
    );
  const logout = () =>
    perform(async () => {
      await voice.leave();
      await api('/logout', {});
      setData(null);
    }, '已退出');
  return (
    <GameShell
      data={data}
      active={tab}
      online={online}
      busy={busy}
      notice={notice}
      onDismiss={() => setNotice('')}
      onNavigate={(panel, section) => {
        setTab(panel);
        if (section) setMarketSection(section);
      }}
      onLogout={() => void logout()}
    >
      {tab === 'reading' && (
        <Reading data={data} perform={perform} busy={busy} voice={voice} online={online} />
      )}
      {tab === 'wallet' && <Wallet data={data} perform={perform} busy={busy} />}
      {tab === 'market' && (
        <Market data={data} perform={perform} busy={busy} initialView={marketSection} />
      )}
      {tab === 'members' && (
        <Members data={data} perform={perform} busy={busy} notify={setNotice} />
      )}
    </GameShell>
  );
}

function Reading({
  data,
  perform,
  busy,
  voice,
  online,
}: {
  data: AppState;
  perform: Perform;
  busy: boolean;
  voice: ReturnType<typeof useVoice>;
  online: boolean;
}) {
  const [follow, setFollow] = useState(true);
  const [selected, setSelected] = useState(data.session?.anchor_index || 0);
  const [scope, setScope] = useState('mine');
  const [draft, setDraft] = useState('');
  const [draftRevision, setDraftRevision] = useState(data.session?.revision || 0);
  const session = data.session;
  const isLeader = data.user.id === session?.leader_id;
  useEffect(() => {
    if (follow) setSelected(session?.anchor_index || 0);
  }, [follow, session?.anchor_index, session?.id]);
  useEffect(() => {
    setDraft(session?.artifact || '');
    setDraftRevision(session?.revision || 0);
  }, [session?.id]);
  const passage = data.passages[selected];
  const select = (index: number) => {
    setFollow(false);
    setSelected(index);
  };
  const update = (phase: string, anchorIndex = session?.anchor_index || 0) =>
    perform(() => api('/reading', { phase, anchorIndex }), '领读位置已同步');
  const notes = data.notes.filter((n) =>
    scope === 'mine' ? n.user_id === data.user.id : n.shared === 1,
  );
  return (
    <>
      <PageTitle eyebrow="原文在中央，理解在彼此之间" title={data.book?.title || '共读室'}>
        {data.book?.author} · {data.book?.source}
      </PageTitle>
      <div className="reading-toolbar">
        <div className="phase-list">
          {Object.entries(phases).map(([key, label]) => (
            <button
              key={key}
              disabled={!isLeader || busy}
              className={session?.phase === key ? 'phase selected' : 'phase'}
              onClick={() => void update(key)}
            >
              {label}
            </button>
          ))}
        </div>
        <label className="checkbox follow">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
          跟随领读
        </label>
      </div>
      <div className="reading-grid">
        <section className="panel reader">
          <div className="reader-heading">
            <span className="eyebrow">原文 · {data.passages.length} 段</span>
            <Badge>领读停在第 {(session?.anchor_index || 0) + 1} 段</Badge>
          </div>
          <div className="passage-index" aria-label="选择段落">
            {data.passages.map((p, i) => (
              <button
                aria-label={`第 ${i + 1} 段`}
                aria-pressed={i === selected}
                className={i === selected ? 'selected' : ''}
                key={p.id}
                onClick={() => select(i)}
              >
                {i + 1}
              </button>
            ))}
          </div>
          <article className="reading-text">
            <span className="passage-number">{String(selected + 1).padStart(2, '0')}</span>
            <p>{passage?.body || '请等待管理员安排共读书目。'}</p>
          </article>
          <div className="reading-pagination">
            <button
              className="button outline compact"
              disabled={selected <= 0}
              onClick={() => select(selected - 1)}
            >
              <ChevronLeft size={15} />
              上一段
            </button>
            {isLeader && (
              <button
                className="button compact"
                disabled={busy || !session}
                onClick={() => void update(session!.phase, selected)}
              >
                带大家读这一段
              </button>
            )}
            <button
              className="button outline compact"
              disabled={selected >= data.passages.length - 1}
              onClick={() => select(selected + 1)}
            >
              下一段
              <ChevronRight size={15} />
            </button>
          </div>
          <div className="reader-foot">
            <LockKeyhole size={14} />
            阅读进度不会作为奖励或排名依据。
          </div>
        </section>
        <aside className="panel room-side">
          <h3>
            <Users size={18} />
            在场的善友
          </h3>
          {data.participants
            .filter((p) => p.online)
            .map((p) => (
              <div className="participant" key={p.id}>
                <span className="avatar small">{p.name.slice(0, 1)}</span>
                <div>
                  <strong>{p.name}</strong>
                  <small>
                    {p.id === session?.leader_id ? '领读人' : p.voice ? '已加入语音' : '文字参与'}
                  </small>
                </div>
                {p.hand &&
                  (isLeader ? (
                    <button
                      className="icon-button"
                      aria-label={`放下${p.name}的手`}
                      onClick={() =>
                        void perform(() => api(`/hands/${p.id}/lower`, {}), '已放下举手')
                      }
                    >
                      <Hand size={17} />
                    </button>
                  ) : (
                    <Hand size={17} />
                  ))}
              </div>
            ))}
          <button
            className="button outline full"
            disabled={busy}
            onClick={() =>
              void perform(
                () =>
                  api('/hand', {
                    raised: !data.participants.find((p) => p.id === data.user.id)?.hand,
                  }),
                '举手状态已更新',
              )
            }
          >
            <Hand size={16} />
            {data.participants.find((p) => p.id === data.user.id)?.hand ? '放下手' : '我想说说'}
          </button>
          <div className="voice-box">
            <h4>
              <Headphones size={16} />
              小组语音
            </h4>
            {voice.joined ? (
              <>
                <p>
                  {voice.muted ? '麦克风已静音' : '麦克风已开启'} · 已连接 {voice.connected} 位伙伴
                </p>
                <div className="button-row">
                  <button className="button compact" onClick={voice.toggle}>
                    {voice.muted ? <MicOff size={15} /> : <Mic size={15} />}
                    {voice.muted ? '开启麦克风' : '静音'}
                  </button>
                  <button className="button outline compact" onClick={() => void voice.leave()}>
                    离开语音
                  </button>
                </div>
                <button className="text-button" onClick={voice.resume}>
                  恢复声音播放
                </button>
              </>
            ) : (
              <button
                className="button outline full"
                disabled={!online || voice.joining}
                onClick={() => void voice.join()}
              >
                <Mic size={16} />
                {voice.joining ? '正在请求麦克风…' : '自愿加入语音'}
              </button>
            )}
            <small>
              默认静音，不录音。
              {data.rtc.mode === 'local'
                ? '未配置穿透服务，跨网络语音可能无法连接。'
                : '已配置网络穿透服务，仍需双方实测。'}
            </small>
          </div>
        </aside>
      </div>
      <div className="notes-grid">
        <section className="panel">
          <div className="section-heading">
            <h2>写下此刻的理解</h2>
            <Badge>对应第 {selected + 1} 段</Badge>
          </div>
          <ActionForm
            busy={busy}
            label="保存这张卡片"
            submit={(f) =>
              perform(
                () =>
                  api('/notes', {
                    passageId: passage?.id,
                    body: f.body,
                    kind: f.kind,
                    shared: f.shared === 'on',
                  }),
                '笔记已保存',
              )
            }
          >
            <label className="field">
              卡片类型
              <select name="kind">
                {Object.entries(kinds).map(([key, value]) => (
                  <option value={key} key={key}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <Area
              name="body"
              label="我的笔记"
              placeholder="一个疑问、一种解释，或者一个不同的例子…"
            />
            <label className="checkbox">
              <input type="checkbox" name="shared" />
              主动分享到本庭院（默认仅自己可见）
            </label>
          </ActionForm>
        </section>
        <section className="panel">
          <div className="section-heading">
            <h2>理解卡片</h2>
            <div className="segmented">
              <button className={scope === 'mine' ? 'active' : ''} onClick={() => setScope('mine')}>
                我的笔记
              </button>
              <button
                className={scope === 'shared' ? 'active' : ''}
                onClick={() => setScope('shared')}
              >
                共同讨论
              </button>
            </div>
          </div>
          <div className="notes-list">
            {!notes.length && (
              <Empty>
                {scope === 'mine'
                  ? '你可以把暂不分享的想法留在这里。'
                  : '只有本人主动分享的卡片，才会出现在这里。'}
              </Empty>
            )}
            {notes.map((n) => (
              <article className="note" key={n.id}>
                <div className="note-meta">
                  <Badge>{kinds[n.kind]}</Badge>
                  <span>
                    {n.author_name} · 第 {data.passages.findIndex((p) => p.id === n.passage_id) + 1}{' '}
                    段
                  </span>
                  <span>{n.shared ? '庭院可见' : '仅自己'}</span>
                </div>
                <p>{n.body}</p>
                {n.user_id === data.user.id && (
                  <div className="button-row">
                    <button
                      className="text-button"
                      disabled={busy}
                      onClick={() =>
                        void perform(
                          () => api(`/notes/${n.id}/visibility`, { shared: !n.shared }),
                          '分享范围已更新',
                        )
                      }
                    >
                      {n.shared ? '收回为私有' : '分享给庭院'}
                    </button>
                    <button
                      className="text-button danger"
                      disabled={busy}
                      onClick={() => {
                        if (confirm('删除这张笔记卡片？此操作不可撤销。'))
                          void perform(() => api(`/notes/${n.id}`, {}, 'DELETE'), '笔记已删除');
                      }}
                    >
                      删除
                    </button>
                  </div>
                )}
              </article>
            ))}
          </div>
        </section>
      </div>
      <section className="panel artifact">
        <div className="section-heading">
          <h2>本场共同成果</h2>
          <Badge>由领读人整理</Badge>
        </div>
        {isLeader ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void perform(
                () => api('/artifact', { body: draft, revision: draftRevision }),
                '共同成果已发布',
              ).then((ok) => {
                if (ok) setDraftRevision((r) => r + 1);
              });
            }}
          >
            <label className="field">
              主要理解、仍存的分歧、下次的问题
              <textarea
                required
                value={draft}
                maxLength={15000}
                rows={6}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="不必强求一致，给尚未解决的问题留一个位置。"
              />
            </label>
            <button className="button" disabled={busy}>
              发布共同成果
              <Check size={16} />
            </button>
            <button
              type="button"
              className="text-button"
              style={{ marginLeft: 16 }}
              disabled={busy}
              onClick={() => {
                if (
                  draft === session?.artifact ||
                  confirm('用已发布版本替换当前草稿？尚未发布的修改会丢失。')
                ) {
                  setDraft(session?.artifact || '');
                  setDraftRevision(session?.revision || 0);
                }
              }}
            >
              载入已发布版本
            </button>
          </form>
        ) : session?.artifact ? (
          <div className="prose">{session.artifact}</div>
        ) : (
          <p className="muted">领读人整理后，本场成果会在这里保存。</p>
        )}
      </section>
    </>
  );
}

function Wallet({ data, perform, busy }: { data: AppState; perform: Perform; busy: boolean }) {
  const [audit, setAudit] = useState('');
  return (
    <>
      <PageTitle eyebrow="善意被看见，贡献有回响" title="功德账簿">
        余额不是修为，转账不转移贡献。这里的 GC 只协调庭院内部服务。
      </PageTitle>
      <section className="wallet-hero">
        <div>
          <span className="eyebrow">我的可用余额</span>
          <h2>
            {data.wallet.balance}
            <small>GC</small>
          </h2>
          <p>非现金 · 不可充值 · 不可提现 · 无升值承诺</p>
        </div>
        <Coins size={90} strokeWidth={0.7} />
        <div className="wallet-aside">
          <p>
            公共愿力池 <strong>{data.wallet.treasury} GC</strong>
          </p>
          <p>
            当前流通与托管合计 <strong>{data.wallet.supply} GC</strong>
          </p>
          <small>首版固定创世供给 1,000 GC；没有额外增发或销毁。</small>
        </div>
      </section>
      <div className="notes-grid">
        <section className="panel">
          <h2>我的收支</h2>
          <div className="ledger">
            {data.wallet.transactions.map((t, i) => (
              <div key={`${t.id}:${i}`}>
                <span className={t.amount > 0 ? 'ledger-icon positive' : 'ledger-icon'}>
                  <ArrowUpRight size={18} />
                </span>
                <div>
                  <strong>{t.memo}</strong>
                  <small>{date(t.created_at)}</small>
                </div>
                <b className={t.amount > 0 ? 'positive' : ''}>
                  {t.amount > 0 ? '+' : ''}
                  {t.amount} GC
                </b>
              </div>
            ))}
            {!data.wallet.transactions.length && (
              <Empty>还没有收支记录。参与共读始终不需要付币。</Empty>
            )}
          </div>
        </section>
        <div className="stack">
          <section className="panel">
            <h2>我的贡献履历</h2>
            <p className="muted">已经完成的贡献，不会因花币而消失。</p>
            {data.wallet.contributions.length ? (
              data.wallet.contributions.map((c) => (
                <div className="contribution" key={c.id}>
                  <ShieldCheck size={19} />
                  <div>
                    <strong>{c.title}</strong>
                    <small>{date(c.created_at)}</small>
                  </div>
                </div>
              ))
            ) : (
              <Empty>真实交付并验收后，在这里留下记录。</Empty>
            )}
          </section>
          <section className="panel">
            <h3>自愿支持公共空间</h3>
            <p className="muted">不是获得身份或治理权的条件，不产生额外贡献等级。</p>
            <ActionForm
              busy={busy}
              label="支持公共愿力池"
              secondary
              submit={(f) =>
                perform(
                  () => money('/donate', { amount: Number(f.amount) }),
                  '谢谢你的支持，账目已记录',
                )
              }
            >
              <Input
                name="amount"
                label="支持数量（GC）"
                type="number"
                min={1}
                max={Math.min(10000, data.wallet.balance)}
              />
            </ActionForm>
          </section>
        </div>
      </div>
      <section className="panel export-panel">
        <div>
          <h3>数据属于你的经历</h3>
          <p className="muted">导出自己的笔记、流水、贡献和庭院共同成果。不包含他人的私人笔记。</p>
        </div>
        <a className="button outline" href="/api/export" download>
          <Download size={16} />
          导出我的数据
        </a>
        {data.user.role === 'owner' && (
          <button
            className="button outline"
            disabled={busy}
            onClick={() =>
              void perform(async () => {
                const result = await api<{ ok: boolean; supply: number; issuance: number }>(
                  '/audit',
                );
                setAudit(
                  result.ok
                    ? `对账通过 · 余额与分录一致 · 供给 ${result.supply} GC`
                    : '对账发现异常，请停止交易并检查数据库。',
                );
              }, '已完成账本对账')
            }
          >
            检查账本
          </button>
        )}
        {audit && <p role="status">{audit}</p>}
      </section>
    </>
  );
}

function BountyCard({
  b,
  data,
  perform,
  busy,
}: {
  b: Bounty;
  data: AppState;
  perform: Perform;
  busy: boolean;
}) {
  const owner = data.user.role === 'owner';
  const mine = b.claimant_id === data.user.id;
  return (
    <article className="panel market-card">
      <div className="card-kicker">
        <Badge>{states[b.state]}</Badge>
        <strong className="coin-tag">{b.reward} GC</strong>
      </div>
      <h3>{b.title}</h3>
      <p className="prose muted">{b.description}</p>
      {b.claimant_name && <p className="fine">领取伙伴：{b.claimant_name}</p>}
      {b.review_note && mine && <div className="notice">需要补充：{b.review_note}</div>}
      {b.evidence && (
        <details>
          <summary>查看交付说明</summary>
          <p className="prose">{b.evidence}</p>
        </details>
      )}
      {b.state === 'open' &&
        (owner ? (
          <button
            className="text-button danger"
            disabled={busy}
            onClick={() =>
              void perform(() => money(`/bounties/${b.id}/cancel`), '预算已退回公共池')
            }
          >
            取消并退回预算
          </button>
        ) : (
          <button
            className="button outline"
            disabled={busy || data.user.status !== 'resident'}
            onClick={() => void perform(() => api(`/bounties/${b.id}/claim`, {}), '任务已领取')}
          >
            领取贡献任务
            <ArrowRight size={15} />
          </button>
        ))}
      {b.state === 'claimed' && mine && (
        <ActionForm
          busy={busy}
          label="提交验收"
          submit={(f) =>
            perform(
              () => api(`/bounties/${b.id}/submit`, { evidence: f.evidence }),
              '已提交给管理员验收',
            )
          }
        >
          <Area name="evidence" label="我的交付说明" maxLength={6000} />
        </ActionForm>
      )}
      {b.state === 'claimed' && mine && (
        <button
          className="text-button"
          disabled={busy}
          onClick={() =>
            void perform(() => api(`/bounties/${b.id}/withdraw`, {}), '任务已归还，预算仍在托管')
          }
        >
          归还未完成的任务
        </button>
      )}
      {b.state === 'submitted' && owner && (
        <>
          <button
            className="button compact"
            disabled={busy}
            onClick={() =>
              void perform(
                () => money(`/bounties/${b.id}/review`, { accept: true }),
                '已验收，奖励和贡献履历已入账',
              )
            }
          >
            验收并发放 {b.reward} GC
          </button>
          <details>
            <summary>需要补充</summary>
            <ActionForm
              busy={busy}
              label="退回补充"
              secondary
              submit={(f) =>
                perform(
                  () =>
                    money(`/bounties/${b.id}/review`, { accept: false, reviewNote: f.reviewNote }),
                  '已退回补充',
                )
              }
            >
              <Area name="reviewNote" label="需要补充的具体标准" maxLength={1000} />
            </ActionForm>
          </details>
        </>
      )}
    </article>
  );
}
function OrderCard({
  order: o,
  data,
  perform,
  busy,
}: {
  order: Order;
  data: AppState;
  perform: Perform;
  busy: boolean;
}) {
  const buyer = o.buyer_id === data.user.id;
  const seller = o.seller_id === data.user.id;
  const admin = data.user.role === 'owner' && !buyer && !seller;
  return (
    <article className="panel market-card">
      <div className="card-kicker">
        <Badge>{states[o.state]}</Badge>
        <strong>{o.price} GC</strong>
      </div>
      <h3>{o.title}</h3>
      <p className="fine">
        委托：{o.buyer_name} · 提供：{o.seller_name}
      </p>
      {o.delivery && <p className="prose">{o.delivery}</p>}
      {o.state === 'funded' && seller && (
        <ActionForm
          busy={busy}
          label="提交服务交付"
          submit={(f) =>
            perform(
              () => api(`/orders/${o.id}/deliver`, { delivery: f.delivery }),
              '已交付，请委托人确认',
            )
          }
        >
          <Area name="delivery" label="服务完成说明" maxLength={6000} />
        </ActionForm>
      )}
      {o.state === 'funded' && (buyer || seller) && (
        <button
          className="text-button danger"
          disabled={busy}
          onClick={() =>
            void perform(() => money(`/orders/${o.id}/refund`), '订单已取消，托管款已原路退回')
          }
        >
          未交付，取消并退款
        </button>
      )}
      {o.state === 'delivered' && (
        <div className="button-row">
          {buyer && (
            <button
              className="button compact"
              disabled={busy}
              onClick={() =>
                void perform(() => money(`/orders/${o.id}/settle`), '服务已确认，款项已结算')
              }
            >
              确认收到并结算
            </button>
          )}
          {(buyer || seller) && (
            <button
              className="button outline compact"
              disabled={busy}
              onClick={() =>
                void perform(() => api(`/orders/${o.id}/dispute`, {}), '已冻结托管款，等待复核')
              }
            >
              申请复核
            </button>
          )}
        </div>
      )}
      {o.state === 'disputed' &&
        (admin ? (
          <div className="button-row">
            <button
              className="button outline compact"
              disabled={busy}
              onClick={() =>
                void perform(() => money(`/orders/${o.id}/resolve`, { refund: true }), '复核已退款')
              }
            >
              复核后退款
            </button>
            <button
              className="button compact"
              disabled={busy}
              onClick={() =>
                void perform(
                  () => money(`/orders/${o.id}/resolve`, { refund: false }),
                  '复核已结算',
                )
              }
            >
              复核后结算
            </button>
          </div>
        ) : (
          <p className="fine">托管款暂不流动，等待独立复核。若管理员也是当事人，请先线下协商。</p>
        ))}
      {o.state === 'disputed' && (buyer || seller) && (
        <div className="button-row">
          <button
            className="button outline compact"
            disabled={busy}
            onClick={() =>
              void perform(
                () => money(`/orders/${o.id}/agreement`, { refund: true }),
                '退款意愿已记录，双方选择一致时才会执行',
              )
            }
          >
            协商：同意退款
          </button>
          <button
            className="button outline compact"
            disabled={busy}
            onClick={() =>
              void perform(
                () => money(`/orders/${o.id}/agreement`, { refund: false }),
                '结算意愿已记录，双方选择一致时才会执行',
              )
            }
          >
            协商：同意结算
          </button>
        </div>
      )}
    </article>
  );
}
function Market({
  data,
  perform,
  busy,
  initialView = 'bounties',
}: {
  data: AppState;
  perform: Perform;
  busy: boolean;
  initialView?: string;
}) {
  const [view, setView] = useState(initialView);
  useEffect(() => {
    setView(initialView);
  }, [initialView]);
  const owner = data.user.role === 'owner';
  return (
    <>
      <PageTitle eyebrow="把愿意做的事，变成真实的帮助" title="愿力集市">
        共读本身免费。贡献按交付验收，服务先托管、后确认，没有拉人返佣。
      </PageTitle>
      <div className="market-tabs segmented">
        <button className={view === 'bounties' ? 'active' : ''} onClick={() => setView('bounties')}>
          贡献悬赏
        </button>
        <button className={view === 'services' ? 'active' : ''} onClick={() => setView('services')}>
          善友服务
        </button>
        <button className={view === 'orders' ? 'active' : ''} onClick={() => setView('orders')}>
          服务订单
        </button>
      </div>
      {view === 'bounties' && (
        <>
          {owner && (
            <details className="panel create-panel">
              <summary>
                <Sprout size={18} />
                发布贡献悬赏
              </summary>
              <p className="muted">
                发布即从公共池锁定预算，验收后拨付。管理员不能领取自己的悬赏。
              </p>
              <ActionForm
                busy={busy}
                label="锁定预算并发布"
                submit={(f) =>
                  perform(
                    () =>
                      money('/bounties', {
                        title: f.title,
                        description: f.description,
                        reward: Number(f.reward),
                      }),
                    '贡献悬赏已发布，预算已托管',
                  )
                }
              >
                <Input name="title" label="任务名称" />
                <Area name="description" label="明确的交付与验收标准" maxLength={3000} />
                <Input name="reward" label="奖励（GC）" type="number" min={1} max={10000} />
              </ActionForm>
            </details>
          )}
          <div className="market-grid">
            {data.bounties.map((b) => (
              <BountyCard key={b.id} b={b} data={data} perform={perform} busy={busy} />
            ))}
          </div>
          {!data.bounties.length && <Empty>还没有贡献任务。可以从整理一场共读成果开始。</Empty>}
        </>
      )}
      {view === 'services' && (
        <>
          <details className="panel create-panel">
            <summary>
              <ShoppingBag size={18} />
              发布我的服务
            </summary>
            <ActionForm
              busy={busy}
              label="发布服务约定"
              submit={(f) =>
                perform(
                  () =>
                    api('/offers', {
                      title: f.title,
                      description: f.description,
                      price: Number(f.price),
                    }),
                  '服务已发布',
                )
              }
            >
              <Input name="title" label="服务名称" placeholder="例如：一次 30 分钟的读书笔记整理" />
              <Area name="description" label="范围、交付方式和时间约定" maxLength={3000} />
              <Input name="price" label="价格（GC）" type="number" min={1} max={10000} />
            </ActionForm>
          </details>
          <div className="market-grid">
            {data.offers.map((o) => (
              <article key={o.id} className="panel market-card">
                <div className="card-kicker">
                  <span>{o.seller_name} 提供</span>
                  <strong className="coin-tag">{o.price} GC</strong>
                </div>
                <h3>{o.title}</h3>
                <p className="muted prose">{o.description}</p>
                {o.seller_id === data.user.id ? (
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() =>
                      void perform(
                        () => api(`/offers/${o.id}/close`, {}),
                        '服务已下架，已有订单保留',
                      )
                    }
                  >
                    下架服务
                  </button>
                ) : (
                  <button
                    className="button outline"
                    disabled={busy || data.user.status !== 'resident'}
                    onClick={() => {
                      if (confirm(`委托“${o.title}”，将托管 ${o.price} GC。请先确认服务约定。`))
                        void perform(
                          () => money('/orders', { offerId: o.id }),
                          '委托已建立，款项已托管',
                        );
                    }}
                  >
                    确认约定并托管
                    <ArrowRight size={15} />
                  </button>
                )}
              </article>
            ))}
          </div>
          {!data.offers.length && <Empty>一份整理、一场答疑，都可以是一种帮助。</Empty>}
        </>
      )}
      {view === 'orders' && (
        <>
          <div className="market-grid">
            {data.orders.map((o) => (
              <OrderCard key={o.id} order={o} data={data} perform={perform} busy={busy} />
            ))}
          </div>
          {!data.orders.length && <Empty>你还没有服务订单。</Empty>}
        </>
      )}
    </>
  );
}

function Members({
  data,
  perform,
  busy,
  notify,
}: {
  data: AppState;
  perform: Perform;
  busy: boolean;
  notify: (value: string) => void;
}) {
  const [link, setLink] = useState('');
  const owner = data.user.role === 'owner';
  return (
    <>
      <PageTitle eyebrow="关系是相遇，不是上下线" title="善友与邀请">
        身份不等于职务，推荐不等于批准。每场只有一位领读人，币余额不决定治理权。
      </PageTitle>
      <div className="members-layout">
        <section className="panel">
          <h2>庭院里的伙伴</h2>
          <div className="member-list">
            {(owner ? data.members : data.participants).map((m) => (
              <div className="member" key={m.id}>
                <span className="avatar">{m.name.slice(0, 1)}</span>
                <div className="member-info">
                  <strong>{m.name}</strong>
                  <small>
                    {status[m.status]}
                    {m.role === 'owner' ? ' · 管理员' : ''}
                    {m.id === data.session?.leader_id ? ' · 本场领读' : ''}
                  </small>
                  {'email' in m && <small>{m.email}</small>}
                </div>
                {owner && m.role !== 'owner' && (
                  <div className="button-row">
                    {m.status === 'probation' && (
                      <button
                        className="button outline compact"
                        disabled={busy}
                        onClick={() =>
                          void perform(
                            () => money(`/members/${m.id}/approve`),
                            '已确认常住；起步额度仅首次发放',
                          )
                        }
                      >
                        确认常住
                      </button>
                    )}
                    {m.status === 'resident' && (
                      <button
                        className="text-button danger"
                        disabled={busy}
                        onClick={() => {
                          if (confirm(`暂停“${m.name}”的访问？会立即撤销会话，保留其笔记和余额。`))
                            void perform(() => api(`/members/${m.id}/suspend`, {}), '访问已暂停');
                        }}
                      >
                        暂停访问
                      </button>
                    )}
                    {m.status === 'suspended' && (
                      <button
                        className="button outline compact"
                        disabled={busy}
                        onClick={() =>
                          void perform(
                            () => api(`/members/${m.id}/restore`, {}),
                            '已恢复为试住状态',
                          )
                        }
                      >
                        恢复试住
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
        <section className="panel">
          <span className="eyebrow">一个边界清楚的空间</span>
          <h3>直接认识，再发出邀请。</h3>
          <p className="muted">
            没有邀请排行榜，没有多级返佣，没有父母式的默认支配权。领读是一项可以交接的工作，而不是更高的身份。
          </p>
          <div className="policy-item">
            <LockKeyhole size={20} />
            <div>
              <strong>私人笔记不因管理权而公开</strong>
              <p>管理员也无法通过普通界面读取他人私有笔记。数据库维护人员仍具备底层访问能力。</p>
            </div>
          </div>
          <div className="policy-item">
            <Coins size={20} />
            <div>
              <strong>基本参与不需要付币</strong>
              <p>阅读、发问、保存自己的理解，都不设消费门槛。</p>
            </div>
          </div>
        </section>
      </div>
      {owner && (
        <>
          <div className="notes-grid">
            <section className="panel">
              <h2>邀请一位善友</h2>
              <p className="muted">
                绑定邮箱，单次领取，7 天有效。链接只显示一次，请通过可信私聊发送。
              </p>
              <ActionForm
                busy={busy}
                label="生成专属邀请"
                submit={(f) =>
                  perform(async () => {
                    const r = await api<{ token: string }>('/invites', {
                      email: f.email,
                      knownAdult: f.knownAdult === 'on',
                    });
                    setLink(`${location.origin}/#invite=${r.token}`);
                  }, '邀请已生成；系统不会代你发送')
                }
              >
                <Input name="email" label="伙伴的邮箱" type="email" maxLength={180} />
                <label className="checkbox">
                  <input name="knownAdult" type="checkbox" required />
                  我确认这是我直接认识的成年伙伴
                </label>
              </ActionForm>
              {link && (
                <div className="invite-result">
                  <label className="field">
                    请私下发送这条邀请
                    <input value={link} readOnly onFocus={(e) => e.target.select()} />
                  </label>
                  <button
                    className="button outline compact"
                    onClick={() =>
                      void navigator.clipboard
                        .writeText(link)
                        .then(() => notify('邀请链接已复制'))
                        .catch(() => notify('浏览器未允许复制，请手动选中链接复制。'))
                    }
                  >
                    <Copy size={15} />
                    复制邀请链接
                  </button>
                </div>
              )}
              <div className="invites-list">
                {data.invites.map((i) => (
                  <div key={i.id}>
                    <span>
                      {i.email}
                      <small>
                        {i.used_by
                          ? '已领取'
                          : i.revoked
                            ? '已撤销'
                            : new Date(i.expires_at) < new Date()
                              ? '已过期'
                              : `有效至 ${date(i.expires_at)}`}
                      </small>
                    </span>
                    {!i.used_by && !i.revoked && (
                      <button
                        className="text-button danger"
                        disabled={busy}
                        onClick={() =>
                          void perform(() => api(`/invites/${i.id}/revoke`, {}), '邀请已撤销')
                        }
                      >
                        撤销
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </section>
            <section className="panel">
              <h2>安排下一场共读</h2>
              <p className="muted">保存后会结束当前场次；笔记与已发布成果仍保留。</p>
              <ActionForm
                busy={busy}
                label="开始新的共读场次"
                submit={(f) => {
                  if (!confirm('结束当前场次并开始新的共读？未发布的成果草稿不会自动保存。'))
                    return Promise.resolve(false);
                  return perform(
                    () =>
                      api('/sessions', { title: f.title, bookId: f.bookId, leaderId: f.leaderId }),
                    '新的共读已开始',
                  );
                }}
              >
                <Input name="title" label="本场名称" />
                <label className="field">
                  共读书目
                  <select name="bookId">
                    {data.books.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.title}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  本场领读人
                  <select name="leaderId">
                    {data.members
                      .filter((m) => m.status === 'resident')
                      .map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                  </select>
                </label>
              </ActionForm>
            </section>
          </div>
          <details className="panel create-panel">
            <summary>
              <BookOpen size={18} />
              导入有使用权的正式书目
            </summary>
            <p className="muted">
              只导入你主动提供的文本，不扫描或上传私人知识库。用空行分段，2—200 段，最多 60,000
              字符。
            </p>
            <ActionForm
              busy={busy}
              label="导入书目"
              submit={(f) =>
                perform(
                  () =>
                    api('/books', {
                      title: f.title,
                      author: f.author,
                      source: f.source,
                      content: f.content,
                      hasRights: f.hasRights === 'on',
                    }),
                  '书目已保存，请在新场次中选择',
                )
              }
            >
              <div className="two-fields">
                <Input name="title" label="书名" />
                <Input name="author" label="作者" />
              </div>
              <Input name="source" label="来源与使用权说明" maxLength={1000} />
              <Area name="content" label="共读原文（空行分段）" maxLength={60000} rows={8} />
              <label className="checkbox">
                <input type="checkbox" name="hasRights" required />
                我确认有权在本小组使用这份文本
              </label>
            </ActionForm>
          </details>
        </>
      )}
    </>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
