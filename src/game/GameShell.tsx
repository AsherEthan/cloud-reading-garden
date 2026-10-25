import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  BookOpen,
  Coins,
  Users,
  ShoppingBag,
  Map as MapIcon,
  Settings,
  X,
  Leaf,
  ChevronUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  LogOut,
  NotebookPen,
  Hand,
  Heart,
  Lightbulb,
  ArrowLeft,
} from 'lucide-react';
import {
  POINTS,
  SPAWN,
  route,
  walkable,
  nearPoint,
  type Position,
  type Place,
} from '../../shared/world.mjs';
import { api, message, date } from '../api';
import type { AppState, WorldPlayer } from '../types';
import { createWorldRenderer, OUTFITS, type WorldView } from './renderer';
import './game.css';

const locations = [
  { id: 'garden', label: '共读庭院', icon: Leaf, title: '云间庭院' },
  { id: 'reading', label: '共读室', icon: BookOpen, title: '云间书屋 · 一起读一会儿' },
  { id: 'wallet', label: '功德账簿', icon: Coins, title: '功德账房 · 我的收支与贡献' },
  { id: 'market', label: '愿力集市', icon: ShoppingBag, title: '善友集市 · 任务、服务与委托' },
  { id: 'members', label: '善友与邀请', icon: Users, title: '迎新小屋 · 善友与邀请' },
];
type Props = {
  data: AppState;
  active: string;
  online: boolean;
  busy: boolean;
  notice: string;
  onDismiss: () => void;
  onNavigate: (panel: string, section?: string) => void;
  onLogout: () => void;
  children: ReactNode;
};
export function GameShell({
  data,
  active,
  online,
  busy,
  notice,
  onDismiss,
  onNavigate,
  onLogout,
  children,
}: Props) {
  const [players, setPlayers] = useState<WorldPlayer[]>(data.world || []);
  const [position, setPosition] = useState<Position>(
    () => data.world?.find((p) => p.id === data.user.id) || SPAWN,
  );
  const [talk, setTalk] = useState<Place | null>(null);
  const [extra, setExtra] = useState('');
  const [hint, setHint] = useState('点击地面漫步，走近建筑后按 E 互动。');
  const [skin, setSkin] = useState(() => {
    try {
      return Number(localStorage.getItem(`garden-outfit:${data.user.id}`)) % 6 || 0;
    } catch {
      return 0;
    }
  });
  const [clock, setClock] = useState(new Date());
  const [graphicsError, setGraphicsError] = useState('');
  const canvas = useRef<HTMLCanvasElement>(null);
  const worldView = useRef<WorldView | null>(null);
  const positionRef = useRef(position);
  const playersRef = useRef(players);
  const pathRef = useRef<Position[]>([]);
  const pendingPlace = useRef<Place | null>(null);
  const stepping = useRef(false);
  const lastMove = useRef(0);
  const lastWorldUpdate = useRef(performance.now());
  const inputRef = useRef({ online, active, extra, talk, skin });
  inputRef.current = { online, active, extra, talk, skin };
  const actionRef = useRef({ onNavigate, setHint });
  actionRef.current = { onNavigate, setHint };
  const windowRef = useRef<HTMLDivElement>(null);
  const nearest = nearPoint(position);
  const self = (): WorldPlayer => ({
    id: data.user.id,
    name: data.user.name,
    ...positionRef.current,
    facing: 'down',
    skin: inputRef.current.skin,
    moving: false,
    emote: '',
    emoteUntil: 0,
  });
  const updatePlayers = (next: WorldPlayer[]) => {
    lastWorldUpdate.current = performance.now();
    playersRef.current = next;
    setPlayers(next);
    const mine = next.find((p) => p.id === data.user.id);
    if (mine) {
      positionRef.current = { x: mine.x, y: mine.y };
      setPosition({ x: mine.x, y: mine.y });
    }
  };
  useEffect(() => {
    updatePlayers(data.world || []);
  }, [data.world]);
  useEffect(() => {
    const receive = (e: Event) => updatePlayers((e as CustomEvent<WorldPlayer[]>).detail);
    window.addEventListener('cloud-world', receive);
    const timer = setInterval(() => setClock(new Date()), 30000);
    return () => {
      window.removeEventListener('cloud-world', receive);
      clearInterval(timer);
    };
  }, [data.user.id]);
  useEffect(() => {
    if (active !== 'garden' || extra || talk) {
      pathRef.current = [];
      pendingPlace.current = null;
    }
  }, [active, extra, talk]);
  useEffect(() => {
    if (active !== 'garden' || extra) windowRef.current?.focus();
  }, [active, extra]);

  const step = async (next: Position) => {
    if (stepping.current || !inputRef.current.online) return;
    const from = positionRef.current;
    if (!walkable(next.x, next.y)) {
      pathRef.current = [];
      setHint('这里不能通行，沿着小路走走吧。');
      return;
    }
    stepping.current = true;
    const facing =
      next.x > from.x ? 'right' : next.x < from.x ? 'left' : next.y < from.y ? 'up' : 'down';
    try {
      await api('/world/move', { ...next, facing, skin: inputRef.current.skin });
      positionRef.current = next;
      setPosition(next);
      lastMove.current = performance.now();
      if (!pathRef.current.length && pendingPlace.current) {
        setTalk(pendingPlace.current);
        pendingPlace.current = null;
      }
    } catch (error) {
      pathRef.current = [];
      pendingPlace.current = null;
      setHint(message(error));
      const state = await api<AppState>('/state').catch(() => null);
      if (state) updatePlayers(state.world);
    } finally {
      stepping.current = false;
    }
  };
  const go = (destination: Position, place: Place | null = null) => {
    if (!online) {
      setHint('正在重新连接，连接恢复后就可以走动。');
      return;
    }
    const path = route(positionRef.current, destination);
    if (!path.length) {
      if (place && nearPoint(positionRef.current)?.id === place.id) setTalk(place);
      else setHint('这条路暂时走不通，请选择草地或小路。');
      return;
    }
    pathRef.current = path;
    pendingPlace.current = place;
    setHint(place ? `正走向${place.name}…` : '沿着小路，慢慢走。');
    canvas.current?.focus();
  };
  const moveDirection = (dx: number, dy: number) => {
    if (performance.now() - lastMove.current < 110) return;
    pathRef.current = [];
    pendingPlace.current = null;
    void step({ x: positionRef.current.x + dx, y: positionRef.current.y + dy });
  };
  const interact = () => {
    const p = nearPoint(positionRef.current);
    if (p) setTalk(p);
    else setHint('靠近一处建筑或公告板，再按 E 互动。');
  };
  useEffect(() => {
    const interval = setInterval(() => {
      const state = inputRef.current;
      if (state.active !== 'garden' || state.extra || state.talk || stepping.current) return;
      const next = pathRef.current.shift();
      if (next) void step(next);
    }, 155);
    const key = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      const state = inputRef.current;
      if (e.key === 'Escape') {
        setTalk(null);
        setExtra('');
        actionRef.current.onNavigate('garden');
        canvas.current?.focus();
        return;
      }
      if (
        (e.target instanceof HTMLElement &&
          e.target.closest('input,textarea,select,[contenteditable=true]')) ||
        state.active !== 'garden' ||
        state.extra ||
        state.talk ||
        (e.target instanceof HTMLElement && e.target.closest('button,a'))
      )
        return;
      const directions: Record<string, number[]> = {
        ArrowUp: [0, -1],
        w: [0, -1],
        W: [0, -1],
        ArrowDown: [0, 1],
        s: [0, 1],
        S: [0, 1],
        ArrowLeft: [-1, 0],
        a: [-1, 0],
        A: [-1, 0],
        ArrowRight: [1, 0],
        d: [1, 0],
        D: [1, 0],
      };
      if (directions[e.key]) {
        e.preventDefault();
        moveDirection(directions[e.key][0], directions[e.key][1]);
      } else if (e.key.toLowerCase() === 'e' || e.code === 'Space') {
        e.preventDefault();
        interact();
      } else if (e.key.toLowerCase() === 'm') {
        e.preventDefault();
        setExtra('map');
      } else if (e.key.toLowerCase() === 'j') {
        e.preventDefault();
        setExtra('journal');
      } else if (/^[1-5]$/.test(e.key)) {
        e.preventDefault();
        actionRef.current.onNavigate(locations[Number(e.key) - 1].id);
      }
    };
    window.addEventListener('keydown', key);
    return () => {
      clearInterval(interval);
      window.removeEventListener('keydown', key);
    };
  }, [data.user.id]);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    let view: WorldView;
    try {
      view = createWorldRenderer(element);
      worldView.current = view;
      setGraphicsError('');
    } catch {
      setGraphicsError(
        '此浏览器未能启动 3D 场景。请开启硬件加速或换用新版浏览器；下方工具栏仍可直接共读、查看账簿和管理邀请。',
      );
      return;
    }
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0;
    let previousFrame = -Infinity;
    let contextLost = false;
    const lost = (event: Event) => {
      event.preventDefault();
      contextLost = true;
      setGraphicsError('3D 显示连接已中断，正在等待恢复。你仍可使用下方工具栏打开共读和账簿。');
    };
    const restored = () => {
      contextLost = false;
      setGraphicsError('');
    };
    element.addEventListener('webglcontextlost', lost);
    element.addEventListener('webglcontextrestored', restored);
    const resize = new ResizeObserver(([entry]) => {
      view.resize(entry.contentRect.width, entry.contentRect.height);
    });
    resize.observe(element);
    const draw = (time: number) => {
      frame = requestAnimationFrame(draw);
      if (document.hidden || contextLost || time - previousFrame < 1000 / 30) return;
      previousFrame = time;
      const next = playersRef.current
        .filter((p) => p.id !== data.user.id)
        .map((p) => ({ ...p, moving: p.moving && time - lastWorldUpdate.current < 250 }));
      const mine = playersRef.current.find((p) => p.id === data.user.id) || self();
      view.setDestination(pathRef.current.at(-1) || null);
      view.render(
        [
          ...next,
          {
            ...mine,
            ...positionRef.current,
            skin: inputRef.current.skin,
            moving: time - lastMove.current < 220,
          },
        ],
        data.user.id,
        time,
        motion.matches,
      );
    };
    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      element.removeEventListener('webglcontextlost', lost);
      element.removeEventListener('webglcontextrestored', restored);
      worldView.current = null;
      view.dispose();
    };
  }, [data.user.id]);
  const clickWorld = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (active !== 'garden' || extra || talk || graphicsError) return;
    const hit = worldView.current?.pick(e.clientX, e.clientY);
    if (!hit) return;
    const place = POINTS.find(
      (p) =>
        p.id === hit.placeId ||
        Math.abs(p.x - hit.position.x) + Math.abs(p.y - hit.position.y) <= 1,
    );
    if (place) go({ x: place.x, y: place.y }, place);
    else go(hit.position);
  };
  const openPlace = (place: Place) => {
    setTalk(null);
    if (place.panel === 'journal') setExtra('journal');
    else
      onNavigate(
        place.panel,
        place.id === 'services' ? 'services' : place.id === 'bounties' ? 'bounties' : undefined,
      );
  };
  const emote = async (value: string) => {
    try {
      await api('/world/emote', { emote: value });
    } catch (e) {
      setHint(message(e));
    }
  };
  const overlay = active !== 'garden' || Boolean(extra);
  const close = () => {
    setExtra('');
    onNavigate('garden');
    canvas.current?.focus();
  };
  return (
    <div className="game-shell">
      <canvas
        ref={canvas}
        className="world-canvas"
        tabIndex={0}
        role="application"
        aria-label="3D 共读庭院。方向键或 WASD 移动，点击地面寻路，靠近建筑后按 E 互动。按 M 打开地图，按 J 打开手记。"
        onPointerDown={clickWorld}
      />
      {graphicsError && (
        <div className="graphics-fallback pixel-frame" role="alert">
          {graphicsError}
        </div>
      )}
      <header className="game-hud">
        <div className="game-brand pixel-frame">
          <Leaf size={21} />
          <div>
            <strong>云间共读</strong>
            <small>一卷书 · 一座小小的世界</small>
          </div>
        </div>
        <div className="game-clock pixel-frame">
          <span className="sun-icon">☀</span>
          <div>
            <strong>
              {clock.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })} · 晴
            </strong>
            <small>
              {clock.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} · 本地时间
            </small>
          </div>
          <span className="top-balance">
            <Coins size={16} />
            {data.wallet.balance} GC
          </span>
        </div>
      </header>
      <div className="game-player-card pixel-frame">
        <span
          className="pixel-portrait"
          style={{ '--shirt': OUTFITS[skin] } as React.CSSProperties}
        >
          <i />
          <b />
        </span>
        <div>
          <h1>你好，{data.user.name}。</h1>
          <span>
            {data.user.role === 'owner'
              ? '庭院管理人'
              : data.user.status === 'probation'
                ? '试住善友'
                : '常住善友'}{' '}
            · {online ? '已连接' : '正在重连'}
          </span>
        </div>
        <button
          aria-label="角色装扮与设置"
          title="角色装扮与设置"
          onClick={() => setExtra('settings')}
        >
          <Settings size={17} />
        </button>
      </div>
      <aside className="game-session-card pixel-frame">
        <span className="game-card-label">此刻的共读</span>
        <strong>{data.book?.title || '等待下一场相聚'}</strong>
        <p>
          {data.participants.find((p) => p.id === data.session?.leader_id)?.name || '待安排'}领读 ·{' '}
          {data.participants.filter((p) => p.online).length} 位善友在场
        </p>
        <button onClick={() => onNavigate('reading')}>
          前往书屋 <span>→</span>
        </button>
      </aside>
      <div className="game-tools">
        <button
          className="pixel-frame"
          aria-label="打开庭院地图"
          title="地图 M"
          onClick={() => setExtra('map')}
        >
          <MapIcon size={20} />
        </button>
        <button
          className="pixel-frame"
          aria-label="打开共读手记"
          title="手记 J"
          onClick={() => setExtra('journal')}
        >
          <NotebookPen size={20} />
        </button>
        <button
          className="pixel-frame"
          aria-label="向善友挥手"
          title="挥手"
          disabled={!online}
          onClick={() => void emote('wave')}
        >
          <Hand size={20} />
        </button>
        <button
          className="pixel-frame"
          aria-label="向善友送出善意"
          title="送出善意，不消耗功德币"
          disabled={!online}
          onClick={() => void emote('heart')}
        >
          <Heart size={20} />
        </button>
        <button
          className="pixel-frame"
          aria-label="我有一个想法"
          title="我有一个想法"
          disabled={!online}
          onClick={() => void emote('idea')}
        >
          <Lightbulb size={20} />
        </button>
      </div>
      {notice && (
        <div role="status" className="game-toast pixel-frame">
          {notice}
          <button onClick={onDismiss} aria-label="关闭提示">
            <X size={15} />
          </button>
        </div>
      )}
      {!overlay && !talk && (
        <div className="world-prompt">
          <span>{nearest ? `你来到了${nearest.name}` : hint}</span>
          {nearest && (
            <button className="pixel-frame" onClick={interact}>
              <kbd>E</kbd> 与{nearest.name}互动
            </button>
          )}
        </div>
      )}
      <output
        className="game-coordinate"
        data-testid="world-position"
        data-x={position.x}
        data-y={position.y}
      >
        庭院 · {position.x}, {position.y} <span>Three.js · 3D</span>
      </output>
      {!overlay && (
        <div className="game-dpad" aria-label="触屏方向控制">
          <button aria-label="向上移动" onClick={() => moveDirection(0, -1)}>
            <ChevronUp />
          </button>
          <button aria-label="向左移动" onClick={() => moveDirection(-1, 0)}>
            <ChevronLeft />
          </button>
          <button aria-label="向下移动" onClick={() => moveDirection(0, 1)}>
            <ChevronDown />
          </button>
          <button aria-label="向右移动" onClick={() => moveDirection(1, 0)}>
            <ChevronRight />
          </button>
        </div>
      )}
      <nav className="game-hotbar pixel-frame" aria-label="主要导航">
        {locations.map((item, index) => (
          <button
            key={item.id}
            aria-label={item.label}
            className={active === item.id && !extra ? 'selected' : ''}
            aria-current={active === item.id ? 'page' : undefined}
            onClick={() => {
              setExtra('');
              setTalk(null);
              onNavigate(item.id);
            }}
            title={`${item.label} [${index + 1}]`}
          >
            <kbd>{index + 1}</kbd>
            <item.icon size={23} />
            <span>{item.label}</span>
          </button>
        ))}
      </nav>
      <div className="game-controls-hint">
        WASD / ↑↓←→ 移动 <span>·</span> E 互动 <span>·</span> M 地图 <span>·</span> Esc 返回
      </div>
      {talk && (
        <section className="npc-dialog pixel-frame" role="dialog" aria-label={`${talk.name}互动`}>
          <span className="npc-portrait">
            <BookOpen size={35} />
          </span>
          <div>
            <small>庭院指引 · {talk.name}</small>
            <h2>{talk.subtitle}</h2>
            <p>
              {talk.id === 'bounties'
                ? `目前有 ${data.bounties.filter((b) => b.state === 'open').length} 项待领取任务。奖励只来自真实交付，不来自走路或表情。`
                : talk.id === 'reading'
                  ? '伙伴们在书屋等你。可以发问，也可以只是安静地读一会儿。'
                  : talk.id === 'wallet'
                    ? '这里记录真实的收支与贡献。功德币不是修为，也不能兑换现金。'
                    : '慢慢来，每一份理解都有属于自己的生长节奏。'}
            </p>
            <div className="button-row">
              <button className="button" onClick={() => openPlace(talk)}>
                {talk.id === 'reading'
                  ? '进入书屋'
                  : talk.id === 'bounties'
                    ? '查看贡献悬赏'
                    : talk.id === 'services'
                      ? '逛逛善友服务'
                      : talk.id === 'journal'
                        ? '翻开共读手记'
                        : talk.id === 'wallet'
                          ? '查看我的账簿'
                          : '走进迎新小屋'}{' '}
                <span aria-hidden="true">→</span>
              </button>
              <button
                className="text-button"
                onClick={() => {
                  setTalk(null);
                  canvas.current?.focus();
                }}
              >
                再逛一会儿
              </button>
            </div>
          </div>
          <button className="game-close" aria-label="结束互动" onClick={() => setTalk(null)}>
            <X size={17} />
          </button>
        </section>
      )}
      {overlay && (
        <div className="game-window-shade">
          <section
            className="game-window pixel-frame"
            role="dialog"
            aria-modal="false"
            aria-label={
              extra === 'map'
                ? '庭院地图'
                : extra === 'journal'
                  ? '共读手记'
                  : extra === 'settings'
                    ? '角色装扮'
                    : locations.find((p) => p.id === active)?.title
            }
          >
            <header className="game-window-title">
              <span>
                {extra === 'map'
                  ? '庭院地图 · 想去哪里走走？'
                  : extra === 'journal'
                    ? '共读手记 · 我们留下来的理解'
                    : extra === 'settings'
                      ? '角色装扮 · 做你自己'
                      : locations.find((p) => p.id === active)?.title}
              </span>
              <button aria-label="回到庭院" title="回到庭院 Esc" onClick={close}>
                <X size={20} />
              </button>
            </header>
            <div ref={windowRef} tabIndex={-1} className="game-window-body">
              {!extra && children}
              {extra === 'map' && (
                <>
                  <p className="game-intro">
                    点击目的地，角色会沿小路走过去。也可以用下方工具栏直接打开功能。
                  </p>
                  <div className="place-cards">
                    {POINTS.map((p) => (
                      <button
                        className="place-card pixel-frame"
                        aria-label={`走到${p.name}`}
                        key={p.id}
                        onClick={() => {
                          setExtra('');
                          onNavigate('garden');
                          go({ x: p.x, y: p.y }, p);
                        }}
                      >
                        <span>
                          {p.kind === 'library'
                            ? '▤'
                            : p.kind === 'bank'
                              ? '◈'
                              : p.kind === 'tree'
                                ? '♧'
                                : '⌂'}
                        </span>
                        <strong>走到{p.name}</strong>
                        <small>{p.subtitle}</small>
                      </button>
                    ))}
                  </div>
                  <p className="game-intro">
                    地图中显示的善友是真实在线成员；角色位置与表情会同步。装扮仅用于表达，不增加任何权限。
                  </p>
                </>
              )}
              {extra === 'journal' && (
                <>
                  <h2>本场的理解卡片</h2>
                  <p className="muted">这里只展示你自己的笔记；他人的私人想法不会出现在这里。</p>
                  {data.notes
                    .filter((n) => n.user_id === data.user.id)
                    .map((n) => (
                      <article className="panel journal-card" key={n.id}>
                        <small>
                          {n.shared ? '庭院可见' : '仅自己'} · {date(n.created_at)}
                        </small>
                        <p className="prose">{n.body}</p>
                      </article>
                    ))}
                  {!data.notes.some((n) => n.user_id === data.user.id) && (
                    <div className="empty">手记还是空白的。去书屋，写下第一个问题吧。</div>
                  )}
                  <h2 className="journal-heading">共同成果</h2>
                  {data.history.map((h) => (
                    <details className="panel journal-card" key={h.id}>
                      <summary>{h.title}</summary>
                      <p className="prose">{h.artifact}</p>
                    </details>
                  ))}
                  {!data.history.length && (
                    <p className="muted">
                      还没有已发布的共同成果。理解不会因为一次相聚结束而消失。
                    </p>
                  )}
                  <button
                    className="button"
                    onClick={() => {
                      setExtra('');
                      onNavigate('reading');
                    }}
                  >
                    去书屋写一张卡片 <BookOpen size={16} />
                  </button>
                </>
              )}
              {extra === 'settings' && (
                <>
                  <h2>挑一件喜欢的衣服</h2>
                  <p className="muted">只改变角色外观，不消耗功德币，也不代表身份或等级。</p>
                  <div className="outfit-options">
                    {OUTFITS.map((color, index) => (
                      <button
                        key={color}
                        aria-label={`选择第 ${index + 1} 套装扮`}
                        aria-pressed={index === skin}
                        style={{ '--shirt': color } as React.CSSProperties}
                        onClick={async () => {
                          setSkin(index);
                          try {
                            localStorage.setItem(`garden-outfit:${data.user.id}`, String(index));
                            await api('/world/move', {
                              ...positionRef.current,
                              skin: index,
                              facing: 'down',
                            });
                          } catch (e) {
                            setHint(message(e));
                          }
                        }}
                      >
                        <span className="pixel-portrait">
                          <i />
                          <b />
                        </span>
                      </button>
                    ))}
                  </div>
                  <div className="panel">
                    <h3>这座庭院的小约定</h3>
                    <p>
                      走路、表情和装扮不发币，不做在线时长奖励。基本共读始终免费。表情是主动表达，不是读心或情绪识别。
                    </p>
                  </div>
                  <button className="button outline" disabled={busy} onClick={onLogout}>
                    <LogOut size={16} />
                    退出庭院
                  </button>
                </>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

export function WorldBackdrop() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    let view: WorldView;
    try {
      view = createWorldRenderer(element, true);
    } catch {
      setFailed(true);
      return;
    }
    const draw = () => {
      const bounds = element.getBoundingClientRect();
      view.resize(bounds.width, bounds.height);
      view.render([], '', performance.now(), true);
    };
    const resize = new ResizeObserver(draw);
    resize.observe(element);
    const restored = () => {
      setFailed(false);
      draw();
    };
    const lost = (event: Event) => {
      event.preventDefault();
      setFailed(true);
    };
    element.addEventListener('webglcontextlost', lost);
    element.addEventListener('webglcontextrestored', restored);
    return () => {
      resize.disconnect();
      element.removeEventListener('webglcontextlost', lost);
      element.removeEventListener('webglcontextrestored', restored);
      view.dispose();
    };
  }, []);
  return (
    <div className="entry-pixel-world" aria-hidden="true">
      <canvas ref={canvas} />
      <span>{failed ? '一卷书，一处相聚。' : '从一段文字，走进一个立体的小世界。'}</span>
    </div>
  );
}
