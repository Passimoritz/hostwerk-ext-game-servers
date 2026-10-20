import { useEffect, useMemo, useState } from 'react';
import { Gamepad2, Play, Download, ShieldCheck, Archive, Search, Plus, Trash2, Settings2, TerminalSquare, Info, RefreshCw, Monitor, ExternalLink, Wrench, FolderOpen, Users, LayoutDashboard, Network, BookOpen, Copy, Map as MapIcon, Tag, Send, Lock, CalendarClock, Cpu, Save, Rocket, Check, RotateCcw, FileText, Boxes, KeyRound, SlidersHorizontal } from 'lucide-react';
import { get, post, put, del, useApi, useStore, waitJob, IS_LINUX, fmtBytes, fmtDate, isElectron, openExternal, useRefresh } from '@hostwerk/api';
import { Btn, Tabs, Seg, Field, Switch, SettingRow, Empty, Loading, Callout, StatusPill, Modal, Progress, toast, confirmDialog, InfoTip } from '@hostwerk/ui';
import { SvcImage, Logo, noImportTab, serviceMenu, useNew, FavMark, FavButton, favSort, ServiceButtons, AddTile, useExtContrib, ExtTabView, askDockerAutostart } from '@hostwerk/kit';
import { FileBrowser } from '@hostwerk/files';
import { Editor } from '@hostwerk/editor';
import { t } from '@hostwerk/i18n';
import './style.css';

/*
 * Game servers – two ways, one interface:
 *  - LinuxGSM (Linux native, Windows through Docker): every LinuxGSM game, its commands and its .cfg
 *  - Steam server tools through SteamCMD (natively where the tool exists, else Docker): every Steam dedicated server,
 *    ready-made start lines for popular games, a custom start line for the rest
 * Live values come from the server itself through the Steam query (A2S). The empty page sets everything up in one go:
 * pick a game → Docker (if needed) → install → start, as ONE job with numbered steps.
 */
const BASE = '#/ext/game-servers';
const isSteam = (s) => s.method === 'steam' || s.kind === 'steam';
/** Game logo: LinuxGSM icon or Steam capsule – loaded once visible; without internet a monogram stays. */
function GameLogo({ short, appid, size = 28, name }) {
  const src = appid ? `https://cdn.cloudflare.steamstatic.com/steam/apps/${Number(appid)}/capsule_sm_120.jpg` : short ? `https://raw.githubusercontent.com/GameServerManagers/LinuxGSM/master/lgsm/data/gameicons/${short}-icon.png` : null;
  return <Logo src={src} name={name || short} className="game-logo" size={size} />;
}
const shortOf = (s) => (isSteam(s) ? null : s.short || String(s.game || '').replace(/server$/, ''));
const GameIcon = ({ s, size = 30, className = 'svc-icon' }) => <SvcImage kind="game" id={s.id} name={s.name} className={className} size={size} fallback={<GameLogo short={shortOf(s)} appid={isSteam(s) ? s.gameAppId : null} size={size} name={s.gameName || s.name} />} />;
const methodLabel = (s) => `${isSteam(s) ? 'SteamCMD' : 'LinuxGSM'}${s.docker ? ' · Docker' : ''}`;
const isInstalling = (jobs, id) => { const list = Object.values(jobs || {}).filter((j) => j.state === 'running'); return list.find((j) => j.key === `game-quick-${id}`) || list.find((j) => j.key === `game-create-${id}`) || null; };
const innerJob = (jobs, id) => Object.values(jobs || {}).find((j) => j.key === `game-create-${id}` && j.state === 'running') || null;
const stateOf = (s, installing) => (s.running ? 'running' : s.installed ? 'stopped' : installing ? 'starting' : 'error');
const stateLabel = (s, installing) => (s.installed ? undefined : installing ? t('Installing …') : t('not installed'));
const fmtTime = (sec) => { const m = Math.floor((sec || 0) / 60); return m >= 60 ? t('{h} h {m} min', { h: Math.floor(m / 60), m: m % 60 }) : t('{m} min', { m }); };
const copy = (x) => navigator.clipboard.writeText(x).then(() => toast.success('Address copied'));
const cmdLabel = (s, cmd) => (s.commands && s.commands[cmd] ? t(s.commands[cmd]) : cmd);
// Game names stay as they are
const POPULAR = [['Valheim', '#d97706'], ['Palworld', '#38bdf8'], ['Rust', '#ce422b'], ['Terraria', '#22c55e'], ['Satisfactory', '#f59e0b'], ['ARK', '#64748b'], ['7 Days to Die', '#b91c1c'], ['Project Zomboid', '#84cc16']];
const goServer = (id, tab = '') => { location.hash = `${BASE.slice(1)}/${id}${tab ? `/${tab}` : ''}`; };

/* ---------------------------------------------------------------- one-step setup */

/** Steps of the setup flow, shown before and while it runs. */
function SetupSteps({ steps, current = 0, done = false }) {
  return (
    <ol className="gs-steps">
      {steps.map((st, i) => {
        const state = done || i + 1 < current ? 'done' : i + 1 === current ? 'now' : 'next';
        return (
          <li key={st.id} className={`gs-step ${state}`}>
            <span className="gs-step-dot" aria-hidden="true">{state === 'done' ? <Check size={12} /> : i + 1}</span>
            <div className="grow"><div className="small bold">{st.title}</div>{st.text && <div className="tiny muted">{st.text}</div>}</div>
            <span className="tiny muted">{state === 'done' ? t('done') : state === 'now' ? t('running …') : ''}</span>
          </li>
        );
      })}
    </ol>
  );
}
/** Step list for a pick (before starting) – Docker only when this way needs it and it is not running yet. */
function plannedSteps(pick, env) {
  const out = [];
  if (pick.needsDocker && !env.docker) out.push({ id: 'docker', title: env.dockerInstalled ? t('Start Docker') : t('Set up Docker'), text: env.dockerInstalled ? t('The engine is set up but off – Hostwerk starts it.') : t('Hostwerk sets up its own Docker engine (no Docker Desktop) – a few minutes, Windows may ask for administrator rights.') });
  out.push({ id: 'install', title: t('Install {game}', { game: pick.name }), text: pick.method === 'steam' ? t('Through SteamCMD, straight from Steam – depending on the game a few GB.') : t('Through LinuxGSM – it loads the game through SteamCMD or from the maker.') });
  out.push({ id: 'start', title: t('Start the server'), text: t('Then it shows up in the list with its address.') });
  return out;
}

function QuickStart({ onMore, onDone }) {
  const d = useApi('/games/quick-picks', [], { live: false });
  const [sel, setSel] = useState(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  if (!d.data) return <div className="card"><Loading /></div>;
  const env = d.data;
  const steps = sel ? plannedSteps(sel, env) : [];
  const go = async () => {
    setBusy(true);
    try {
      const body = sel.method === 'steam' ? { method: 'steam', appid: sel.appid } : { method: 'lgsm', game: sel.game };
      const r = await post('/games', { ...body, name: name || sel.name, start: true, installDocker: true });
      toast(t('“{name}” is being set up – progress on its page.', { name: name || sel.name }));
      onDone(); goServer(r.id);
    } catch (e) { toast.error(e.message); }
    setBusy(false);
  };
  return (
    <div className="card">
      <div className="card-head"><Rocket size={16} /><h3>Set up your first game server</h3><span className="small muted">{t('One click – Hostwerk does the rest')}</span></div>
      <div className="card-body stack">
        {!sel ? (
          <>
            <div className="label">1. Pick a game</div>
            <div className="game-tiles">
              {env.picks.map((p) => (
                <button key={p.key} type="button" className="game-tile" onClick={() => { setSel(p); setName(''); }} title={p.name}>
                  <GameLogo short={p.short} appid={p.method === 'steam' ? p.gameAppId : null} size={40} name={p.name} />
                  <span className="ellipsis">{p.name}</span>
                  <span className="tiny muted">{p.method === 'steam' ? 'SteamCMD' : 'LinuxGSM'}{p.needsDocker ? ' · Docker' : ''}</span>
                </button>
              ))}
            </div>
            <div className="row-tight"><Btn className="ghost sm" icon={Search} onClick={onMore}>All games …</Btn><span className="tiny muted">{t('Every LinuxGSM game and every Steam server tool')}</span></div>
          </>
        ) : (
          <>
            <div className="game-pick">
              <GameLogo short={sel.short} appid={sel.method === 'steam' ? sel.gameAppId : null} size={56} name={sel.name} />
              <div className="grow stack gs-tight">
                <div><b className="gs-title">{sel.name}</b><div className="tiny muted">{sel.method === 'steam' ? t('Steam server tool through SteamCMD') : t('LinuxGSM')}{sel.needsDocker ? t(' · runs as a Docker container') : ''}</div></div>
                <Field label="Name of the server"><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={sel.name} /></Field>
              </div>
              <button type="button" className="btn ghost sm" onClick={() => setSel(null)}>Other game</button>
            </div>
            <div className="label">2. What happens</div>
            <SetupSteps steps={steps} />
            <div className="row-tight"><Btn className="primary" icon={Rocket} busy={busy} onClick={go}>Set up</Btn><span className="tiny muted">{t('You can follow every step – it keeps running when you leave the page.')}</span></div>
          </>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- create dialog (both methods) */

function SteamPicker({ sel, setSel }) {
  const [q, setQ] = useState('');
  const [page, setPage] = useState({ items: [], total: 0, list: null });
  const [busy, setBusy] = useState(false);
  const [loadingFull, setLoadingFull] = useState(false);
  const load = async (query, offset = 0) => {
    setBusy(true);
    try {
      const r = await get(`/games/steam/apps?q=${encodeURIComponent(query)}&offset=${offset}&limit=40`);
      setPage((p) => ({ ...r, items: offset ? [...p.items, ...r.items] : r.items }));
    } catch (e) { toast.error(e.message); }
    setBusy(false);
  };
  useEffect(() => { const x = setTimeout(() => load(q), q ? 250 : 0); return () => clearTimeout(x); }, [q]); // eslint-disable-line react-hooks/exhaustive-deps
  const loadFull = async () => {
    setLoadingFull(true);
    try { const st = await post('/games/steam/apps/refresh', { force: !!(page.list && page.list.full) }); toast.success(t('{n} Steam server tools found', { n: st.count })); load(q); } catch (e) { toast.error(e.message); }
    setLoadingFull(false);
  };
  const st = page.list;
  return (
    <div className="stack">
      <div className="input-icon"><Search /><input className="input" aria-label={t('Search server tool')} placeholder="Search game or Steam app id (e.g. Valheim, 896660) …" value={q} onChange={(e) => setQ(e.target.value)} autoFocus /></div>
      {st && (
        <div className="row-tight tiny muted gs-wrap">
          {st.full ? t('{n} built-in plus {m} from Steam (list from {date}, {size} on disk)', { n: st.builtIn, m: st.count, date: fmtDate(st.fetchedAt), size: fmtBytes(st.bytes) }) : t('{n} server tools built in.', { n: st.builtIn })}
          <Btn className="xs ghost" icon={RefreshCw} busy={loadingFull} onClick={loadFull}>{st.full ? t('Refresh list') : t('Load every Steam server tool')}</Btn>
          <InfoTip inline title="Small and once">Hostwerk reads Steam's app list once as a stream, keeps only server tools (a few hundred KB, gzipped) and reuses them for 7 days. Searching happens in Hostwerk – only one page at a time reaches this window.</InfoTip>
        </div>
      )}
      <div className="stack gs-list" role="listbox" aria-label={t('Steam server tools')}>
        {page.items.map((a) => {
          const off = !!a.plan.reason;
          return (
            <button key={a.appid} type="button" role="option" aria-selected={sel && sel.appid === a.appid} className={`list-item game-row ${sel && sel.appid === a.appid ? 'active' : ''}`} disabled={off} onClick={() => setSel(a)} title={off ? (a.plan.reason === 'login' ? t('Needs a Steam account that owns the game') : t('Not available on this system')) : a.name}>
              <GameLogo appid={a.game} size={28} name={a.name} />
              <div className="grow small ellipsis"><b>{a.name}</b>{a.profile && <span className="badge accent gs-ml">{t('ready-made start')}</span>}{a.plan.needsDocker && <span className="badge gs-ml">Docker</span>}{off && <span className="badge warn gs-ml">{a.plan.reason === 'login' ? t('Steam login') : t('other system')}</span>}</div>
              <span className="tiny muted mono">{a.appid}</span>
            </button>
          );
        })}
        {!busy && page.items.length === 0 && <div className="small muted gs-pad">{t('Nothing found.')}{st && !st.full ? ` ${t('Load every Steam server tool to search all of them.')}` : ''}</div>}
        {busy && <Loading />}
      </div>
      {page.items.length < page.total && <Btn className="ghost sm" busy={busy} onClick={() => load(q, page.items.length)}>{t('Show more ({n} left)', { n: page.total - page.items.length })}</Btn>}
    </div>
  );
}

function CreateDialog({ onClose, onDone, linux }) {
  const [method, setMethod] = useState(linux ? 'lgsm' : 'steam');
  const [cat, setCat] = useState(null);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (method === 'lgsm' && !cat) get('/games/catalog').then(setCat).catch((e) => toast.error(e.message)); }, [method]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setSel(null); setName(''); }, [method]);
  const list = cat ? cat.games.filter((g) => !q || `${g.name} ${g.game} ${g.hint || ''}`.toLowerCase().includes(q.toLowerCase())) : [];
  const favs = cat ? cat.games.filter((g) => g.hint) : [];
  const create = async () => {
    setBusy(true);
    try {
      const body = method === 'steam' ? { method: 'steam', appid: sel.appid, name: name || sel.name.replace(/\s*(dedicated server|server)$/i, '') } : { method: 'lgsm', game: sel.game, name: name || sel.hint || sel.name, mode: linux ? 'native' : 'docker' };
      const r = await post('/games', { ...body, start: true });
      toast('The server is being set up – depending on the game this can take long (download through SteamCMD).');
      onDone(); goServer(r.id);
    } catch (e) { toast.error(e.message); }
    setBusy(false);
  };
  const steamCustom = method === 'steam' && sel && sel.plan && sel.plan.custom;
  return (
    <Modal title="Create game server" subtitle="LinuxGSM or a Steam server tool – installed through SteamCMD" onClose={onClose} size="lg" footer={<><Btn onClick={onClose}>Cancel</Btn><Btn className="primary" icon={Plus} busy={busy} disabled={!sel} onClick={create}>Create & start</Btn></>}>
      <div className="stack">
        <Seg value={method} onChange={setMethod} options={[{ id: 'steam', label: 'Steam (SteamCMD)', icon: Boxes }, { id: 'lgsm', label: 'LinuxGSM', icon: TerminalSquare }]} />
        <div className="tiny muted">{method === 'steam' ? t('Every Steam game with a dedicated server tool – natively on this PC where the tool exists, else in Docker. Updates: SteamCMD on every start.') : linux ? t('More than 100 games with tried and tested scripts – natively on this Linux machine.') : t('More than 100 games with tried and tested scripts – on Windows in a Docker container.')}</div>
        {sel ? (
          <div className="game-pick">
            {method === 'steam' ? <GameLogo appid={sel.game} size={56} name={sel.name} /> : <GameLogo short={sel.short} size={56} name={sel.name} />}
            <div className="grow stack gs-tight">
              <div><b className="gs-title">{sel.name}</b>
                <div className="tiny muted">{method === 'steam' ? t('Steam app {id}{docker}', { id: sel.appid, docker: sel.plan.needsDocker ? t(' · runs as a Docker container') : '' }) : t('LinuxGSM script {game} · {os}', { game: sel.game, os: sel.os })}{method === 'lgsm' && !linux ? t(' · runs as a Docker container') : ''}</div>
              </div>
              <Field label="Name of the server"><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={method === 'steam' ? sel.name.replace(/\s*(dedicated server|server)$/i, '') : sel.hint || sel.name} /></Field>
              {steamCustom && <div className="tiny gs-warn">{t('No ready-made start for this tool yet – after installing, choose the program and parameters under Settings → Start.')}</div>}
            </div>
            <button type="button" className="btn ghost sm" onClick={() => setSel(null)}>Other game</button>
          </div>
        ) : method === 'steam' ? <SteamPicker sel={sel} setSel={setSel} /> : !cat ? <Loading /> : (
          <>
            <div className="input-icon"><Search /><input className="input" aria-label={t('Search game')} placeholder="Search game (e.g. Valheim, Rust, Terraria) …" value={q} onChange={(e) => setQ(e.target.value)} autoFocus /></div>
            {!q && <div><div className="label gs-mb">Popular</div><div className="game-tiles">{favs.slice(0, 12).map((g) => <button key={g.game} type="button" className="game-tile" onClick={() => setSel(g)} title={g.name}><GameLogo short={g.short} size={40} name={g.name} /><span className="ellipsis">{t(g.hint || g.name)}</span></button>)}</div></div>}
            <div className="stack gs-list">
              {!q && <div className="label">{t('All games ({n})', { n: cat.games.length })}</div>}
              {(q ? list : cat.games).slice(0, 150).map((g) => <button key={g.game} type="button" className="list-item game-row" onClick={() => setSel(g)}><GameLogo short={g.short} size={28} name={g.name} /><div className="grow small ellipsis"><b>{g.name}</b>{g.hint && <span className="badge gs-ml">{t('popular')}</span>}</div><span className="tiny muted mono">{g.game}</span></button>)}
              {q && list.length === 0 && <div className="small muted gs-pad">No game found – LinuxGSM does not know it (yet). Try “Steam (SteamCMD)”.</div>}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

/* ---------------------------------------------------------------- detail tabs */

function useRun(s, reload) {
  const [busy, setBusy] = useState(null);
  const [out, setOut] = useState(null);
  const run = async (cmd, args) => {
    setBusy(cmd);
    try { const r = await post(`/games/${s.id}/${cmd}`, { args }); const j = await waitJob(r.job); setOut({ cmd, text: j.result.output || j.result.text }); toast.success(`${cmdLabel(s, cmd)}: ${j.result.text || 'ok'}`); } catch (e) { toast.error(e.message); }
    setBusy(null); reload();
  };
  return { busy, out, run };
}

function Connect({ s }) {
  if (!s.address) return <div className="small muted">{isSteam(s) ? t('No ports known yet – set them under Settings → Start.') : t('The address is known as soon as LinuxGSM reported the ports (Network tab → details).')}</div>;
  return (
    <div className="stack gs-tight">
      <div className="label">Connect</div>
      {[s.address.local, ...s.address.lan].map((a) => <div key={a} className="row-tight"><code className="grow ellipsis">{a}</code><button className="btn ghost xs icon" title="Copy" aria-label={t('Copy')} onClick={() => copy(a)}><Copy /></button></div>)}
      <div className="tiny muted">{t('For friends over the internet: switch on “Reachable from outside” in the settings or forward the ports.')} <a href={`${BASE}/${s.id}/network`}>{t('Open network')}</a></div>
    </div>
  );
}

const BASE_CMDS = ['start', 'stop', 'restart', 'monitor', 'details', 'postdetails', 'update', 'check-update', 'force-update', 'validate', 'backup', 'update-lgsm', 'test-alert', 'send-alert', 'console', 'debug', 'install', 'auto-install', 'skeleton', 'sponsor', 'donate', 'send'];

function OutputCard({ s, out }) {
  if (!out) return null;
  return <div className="card"><div className="card-head"><TerminalSquare size={16} /><h3>{t('Output: {cmd}', { cmd: cmdLabel(s, out.cmd) })}</h3></div><pre className="tiny gs-pre">{out.text}</pre></div>;
}

function OverviewTab({ s, reload }) {
  const live = s.live;
  const steam = isSteam(s);
  const { busy, out, run } = useRun(s, reload);
  const cmds = useApi(s.installed && !steam ? `/games/${s.id}/commands` : null, [s.id, s.installed], { live: false });
  const special = (cmds.data || []).filter((c) => !BASE_CMDS.includes(c.cmd) && !/^dev-/.test(c.cmd));
  return (
    <div className="stack">
      <div className="grid grid-4">
        <div className="card stat"><div className="k"><Users />{t('Players')}</div><div className="v">{live ? live.players : '–'}{live && <span className="muted gs-sub"> / {live.maxPlayers}</span>}</div><div className="s">{s.running ? (live ? (live.bots ? t('{n} bots', { n: live.bots }) : t('online')) : t('no query possible')) : t('Server stopped')}</div></div>
        <div className="card stat"><div className="k"><MapIcon />{t('Map')}</div><div className="v ellipsis gs-v">{(live && live.map) || '–'}</div><div className="s">{live && live.password ? <><Lock size={11} /> {t('with password')}</> : live ? t('open') : ''}</div></div>
        <div className="card stat"><div className="k"><Tag />{t('Version')}</div><div className="v ellipsis gs-v">{(live && live.version) || '–'}</div><div className="s">{live && live.vac ? t('VAC protected') : ''}</div></div>
        <div className="card stat"><div className="k"><Network />{t('Ports')}</div><div className="v">{(s.ports || []).length || '–'}</div><div className="s">{live ? t('Query on {port}', { port: live.queryPort }) : <a href={`${BASE}/${s.id}/network`}>{t('show →')}</a>}</div></div>
      </div>
      <div className="grid grid-2">
        <div className="stack">
          <div className="card">
            <div className="card-head"><Gamepad2 size={16} /><h3>State</h3><div className="right"><StatusPill state={s.running ? 'running' : 'stopped'} /></div></div>
            <div className="card-body stack">
              {live && live.name && <div className="mc-motd small ellipsis" title="Name in the server list">{live.name}</div>}
              <Connect s={s} />
              {steam && s.steam && s.steam.adminPassword && <div className="row-tight tiny"><KeyRound size={13} className="muted" /><span className="muted">{t('Admin/RCON password:')}</span><code>{s.steam.adminPassword}</code><button className="btn ghost xs icon" title="Copy" aria-label={t('Copy')} onClick={() => navigator.clipboard.writeText(s.steam.adminPassword).then(() => toast.success('Copied'))}><Copy /></button></div>}
              {steam && s.steam && s.steam.note && <div className="info-line"><Info size={13} /><span>{s.steam.note}</span></div>}
            </div>
          </div>
          <div className="card">
            <div className="card-head"><Wrench size={16} /><h3>Care</h3></div>
            <div className="card-body row gs-wrap">
              {!steam && <Btn icon={RefreshCw} busy={busy === 'check-update'} onClick={() => run('check-update')}>Check for updates</Btn>}
              <Btn icon={Download} busy={busy === 'update'} onClick={() => run('update')}>Update</Btn>
              <Btn icon={ShieldCheck} busy={busy === 'validate'} onClick={() => run('validate')}>Check files</Btn>
              <Btn icon={Archive} busy={busy === 'backup'} onClick={() => run('backup')}>Backup</Btn>
              {!steam && <Btn icon={RefreshCw} busy={busy === 'update-lgsm'} onClick={() => run('update-lgsm')}>Update LinuxGSM</Btn>}
            </div>
            {special.length > 0 && (
              <div className="card-body stack gs-top">
                <div className="small bold">{t('Special for {game}', { game: s.gameName || s.name })}</div>
                <div className="row gs-wrap">{special.map((c) => <Btn key={c.cmd} className="sm" icon={Wrench} busy={busy === c.cmd} title={c.desc} onClick={async () => { if (/wipe|remove|delete/.test(c.cmd) && !(await confirmDialog({ title: t('Run {cmd}?', { cmd: c.cmd }), text: c.desc, confirm: 'Run', danger: true }))) return; run(c.cmd); }}>{cmdLabel(s, c.cmd)}</Btn>)}</div>
                <div className="tiny muted">LinuxGSM offers these commands exactly for this game – Hostwerk reads them by itself.</div>
              </div>
            )}
            <div className="card-body tiny muted gs-top">{t('Start with Hostwerk, monitor, updates, limits and the schedule are under Settings.')} <a href={`${BASE}/${s.id}/settings`}>{t('Open settings')}</a></div>
          </div>
        </div>
        <div className="stack">
          <OutputCard s={s} out={out} />
          <GuidesCard s={s} compact />
        </div>
      </div>
    </div>
  );
}

function GuidesCard({ s, compact }) {
  const links = s.links || [];
  return (
    <div className="card">
      <div className="card-head"><BookOpen size={16} /><h3>Guides</h3>{compact && <div className="right"><a className="small" href={`${BASE}/${s.id}/guides`}>{t('all →')}</a></div>}</div>
      {(compact ? links.slice(0, 3) : links).map((l) => (
        <a key={l.id} className="list-item" href={l.url} onClick={(e) => { e.preventDefault(); openExternal(l.url); }}>
          <BookOpen size={15} className="muted" />
          <div className="grow small"><b>{t(l.label)}</b><div className="tiny muted">{t(l.text)}</div></div>
          <ExternalLink size={14} className="muted" />
        </a>
      ))}
    </div>
  );
}

function GuidesTab({ s }) {
  const steam = isSteam(s);
  return (
    <div className="grid grid-2">
      <GuidesCard s={s} />
      <div className="card">
        <div className="card-head"><Info size={16} /><h3>How this server runs</h3></div>
        <div className="card-body stack small">
          {steam ? <>
            <div>{t('The server is the Steam server tool {appid}, installed and updated with SteamCMD (anonymous login){where}.', { appid: s.appid, where: s.docker ? t(' in a Docker container') : t(' right on this PC') })}</div>
            <div>{t('Hostwerk starts it with the start line from Settings → Start – ready-made for popular games, your own for every other tool.')}</div>
          </> : <>
            <div>{t('The server runs through LinuxGSM (script {script})', { script: s.script })}{s.docker ? t(' in the official LinuxGSM Docker container') : t(' right on this Linux machine')}. {t('Installation and updates are downloaded by SteamCMD or the maker.')}</div>
            <div>{t('Settings are in {file} (Settings tab) – all possible options are shown in _default.cfg next to it. Game files (worlds, rules) are under serverfiles/ (Files tab).', { file: `${s.script}.cfg` })}</div>
          </>}
          <div>Hostwerk reads players, map and version through the Steam server query – that works for most Steam games. Games without this query show “–”.</div>
          {!steam && (
            <div className="row-tight gs-wrap">
              <Btn className="sm" icon={ExternalLink} onClick={() => openExternal(`https://linuxgsm.com/servers/${s.script}/`)}>{`LinuxGSM: ${s.script}`}</Btn>
              <Btn className="sm ghost" icon={ExternalLink} onClick={() => openExternal('https://docs.linuxgsm.com/commands')}>All LinuxGSM commands</Btn>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ConsoleTab({ s }) {
  const [cons, setCons] = useState(null);
  const [cmd, setCmd] = useState('');
  const [sending, setSending] = useState(false);
  const [reply, setReply] = useState(null);
  useEffect(() => { const load = () => get(`/games/${s.id}/console?n=400`).then((r) => setCons(r.lines)).catch(() => setCons([])); load(); const x = setInterval(load, 4000); return () => clearInterval(x); }, [s.id]);
  const send = async (e) => { e.preventDefault(); if (!cmd.trim()) return; setSending(true); try { const r = await post(`/games/${s.id}/send`, { command: cmd }); setReply(r && r.output ? r.output : null); setCmd(''); } catch (er) { toast.error(er.message); } setSending(false); };
  const steam = isSteam(s);
  return (
    <div className="card">
      <div className="card-head"><TerminalSquare size={16} /><h3>Console</h3><span className="small muted">{s.docker ? t('container output (every 4 s)') : steam ? t('server output (every 4 s)') : t('log/console (every 4 s)')}</span>
        {!s.docker && !steam && <div className="right"><Btn className="xs" icon={TerminalSquare} onClick={() => { location.hash = `/terminal?cwd=${encodeURIComponent(s.dir)}&cmd=${encodeURIComponent(`./${s.script} console`)}`; }}>Live in the terminal (tmux)</Btn></div>}
      </div>
      {!cons ? <Loading /> : <pre className="tiny console-pre gs-console">{cons.join('\n') || t('(no console output yet)')}</pre>}
      {reply && <pre className="tiny gs-reply">{reply}</pre>}
      {s.canSend ? (
        <form className="card-body row-tight gs-top" onSubmit={send}>
          <input className="input mono grow" aria-label={t('Command to the server')} value={cmd} onChange={(e) => setCmd(e.target.value)} placeholder={steam ? t('Command to the server (RCON, e.g. status)') : t('Command to the server (e.g. say Hello)')} disabled={!s.running} />
          <Btn className="primary" icon={Send} busy={sending} disabled={!s.running || !cmd.trim()} type="submit">Send</Btn>
        </form>
      ) : <div className="card-body tiny muted gs-top">{steam ? t('This game takes no console commands through Hostwerk – use its own admin tools or config files.') : t('This game takes no commands through LinuxGSM – use “Live in the terminal” for live input.')}</div>}
    </div>
  );
}

function PlayersTab({ s }) {
  const [d, setD] = useState(null);
  useEffect(() => { if (!s.running) return undefined; const load = () => get(`/games/${s.id}/players`).then(setD).catch(() => setD({ players: [] })); load(); const x = setInterval(load, 10000); return () => clearInterval(x); }, [s.id, s.running]);
  if (!s.running) return <div className="card"><Empty icon={Users} title="Server stopped" text="Players show up here as soon as the server runs." /></div>;
  if (!d) return <Loading />;
  if (!d.live) return <div className="card"><Empty icon={Users} title="No player list" text="The server does not answer the Steam server query – some games don't have it, others switched the query port off in their configuration." /></div>;
  const named = d.players.filter((p) => p.name);
  return (
    <div className="card">
      <div className="card-head"><Users size={16} /><h3>Online</h3><span className="small muted">{d.live.players} / {d.live.maxPlayers}{d.live.bots ? ` · ${t('{n} bots', { n: d.live.bots })}` : ''}</span></div>
      {named.length === 0 ? <div className="card-body small muted">{d.live.players > 0 ? t('Players are connecting right now (no names yet).') : t('Nobody is online right now.')}</div> : named.sort((a, b) => b.seconds - a.seconds).map((p) => (
        <div key={p.name} className="list-item"><Users size={15} className="muted" /><div className="grow small"><b>{p.name}</b></div><span className="tiny muted">{p.score ? `${t('{n} points', { n: p.score })} · ` : ''}{t('{time} online', { time: fmtTime(p.seconds) })}</span></div>
      ))}
    </div>
  );
}

function NetworkTab({ s }) {
  const [details, setDetails] = useState(null);
  const load = () => get(`/games/${s.id}/details`).then(setDetails).catch((e) => { toast.error(e.message); setDetails({ text: '', ports: s.ports || [] }); });
  useEffect(() => { load(); }, [s.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useRefresh(load); // reload quietly after installing, changes and finished jobs
  if (!details) return <Loading />;
  return (
    <div className="grid split-side">
      <div className="card"><div className="card-head"><ExternalLink size={16} /><h3>Ports</h3></div>
        {details.ports.length === 0 ? <div className="card-body small muted">{isSteam(s) ? t('No ports known – set them under Settings → Start.') : t('No ports found (server installed?).')}</div> : details.ports.map((p, i) => <div key={i} className="list-item"><div className="grow small"><b>{t(p.name)}</b> <span className="mono">{p.port}/{p.proto}</span>{s.live && s.live.queryPort === p.port && <span className="badge gs-ml">{t('Query')}</span>}</div><a className="btn xs" href={`#/live/router?port=${p.port}&proto=${p.proto}&name=${encodeURIComponent(s.name)}`}>{t('Forward')}</a></div>)}
        <div className="card-body"><Connect s={s} /></div>
      </div>
      {isSteam(s) ? (
        <div className="card"><div className="card-head"><Info size={16} /><h3>Ports of this server</h3></div><div className="card-body small stack">
          <div>{s.steam && s.steam.profile ? t('The ports come from the ready-made start for this game and follow the game port you set.') : t('List the ports of this tool under Settings → Start (e.g. 27015/udp).')}</div>
          <div className="muted">{t('“Reachable from outside” (Settings) opens exactly these ports in the firewall and the router while the server runs.')}</div>
        </div></div>
      ) : (
        <div className="card"><div className="card-head"><Info size={16} /><h3>Details (LinuxGSM)</h3><div className="right"><Btn className="xs ghost" icon={RefreshCw} onClick={load}>Reload</Btn></div></div><pre className="tiny gs-pre gs-tall">{details.text}</pre></div>
      )}
    </div>
  );
}

/* ---------- settings ---------- */

function SaveBtn({ busy, onClick, disabled }) { return <Btn className="sm primary" icon={Save} busy={busy} disabled={disabled} onClick={onClick}>Save</Btn>; }

function GeneralCard({ s, reload }) {
  const steam = isSteam(s);
  const q = useApi(`/games/${s.id}/quick`, [s.id], { live: false });
  const [f, setF] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (steam) setF({ name: s.name, port: String(s.port || ''), maxPlayers: String(s.maxPlayers || ''), password: s.password || '' });
    else if (q.data && q.data.keys) setF({ name: s.name, ...q.data.values });
    else if (q.error) setF({ name: s.name }); // e.g. Docker engine off – the name stays editable
  }, [s.id, q.data, q.error]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!f) return <div className="card"><Loading /></div>;
  const fields = steam ? (s.steam && s.steam.fields) || [] : (q.data && q.data.keys) || [];
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = async () => {
    setBusy(true);
    try {
      if (f.name !== s.name) await put(`/games/${s.id}`, { name: f.name });
      if (steam) await put(`/games/${s.id}/quick`, { port: Number(f.port), maxPlayers: Number(f.maxPlayers), password: f.password });
      else { const { name, ...rest } = f; const r = await put(`/games/${s.id}/quick`, rest); if (r.changed) toast(s.running ? t('Saved – takes effect after a restart') : t('Saved')); }
      toast.success('Saved'); reload(); q.reload();
    } catch (e) { toast.error(e.message); }
    setBusy(false);
  };
  const LGSM_LABEL = { servername: t('Name in the server list'), port: t('Game port'), queryport: t('Query port'), maxplayers: t('Max players'), serverpassword: t('Password'), startparameters: t('Start parameters') };
  return (
    <div className="card">
      <div className="card-head"><SlidersHorizontal size={16} /><h3>General</h3><div className="right"><SaveBtn busy={busy} onClick={save} /></div></div>
      <div className="card-body stack">
        <Field label="Name in Hostwerk"><input className="input" value={f.name} maxLength={60} onChange={set('name')} /></Field>
        {steam ? (
          <div className="grid grid-3">
            {fields.includes('port') && <Field label="Game port"><input className="input mono" inputMode="numeric" value={f.port} onChange={set('port')} /></Field>}
            {fields.includes('maxPlayers') && <Field label="Max players"><input className="input mono" inputMode="numeric" value={f.maxPlayers} onChange={set('maxPlayers')} /></Field>}
            {fields.includes('password') && <Field label="Password" hint={s.steam && s.steam.passwordMin ? t('At least {n} characters', { n: s.steam.passwordMin }) : t('Empty = open server')}><input className="input mono" value={f.password} onChange={set('password')} autoComplete="off" /></Field>}
          </div>
        ) : fields.filter((k) => k !== 'startparameters').length > 0 && (
          <div className="grid grid-3">{fields.filter((k) => k !== 'startparameters').map((k) => <Field key={k} label={LGSM_LABEL[k] || k}><input className="input mono" value={f[k] ?? ''} onChange={set(k)} autoComplete="off" /></Field>)}</div>
        )}
        {!steam && fields.includes('startparameters') && <Field label={LGSM_LABEL.startparameters} hint={t('LinuxGSM fills ${…} values itself – keep them.')}><input className="input mono" value={f.startparameters ?? ''} onChange={set('startparameters')} /></Field>}
        {steam && fields.length < 4 && <div className="tiny muted">{(s.steam && s.steam.note) || t('This game reads further settings from its config file (Settings → Config files).')}</div>}
        {!steam && q.error && <div className="tiny gs-warn">{q.error}</div>}
        {!steam && !q.error && !fields.length && <div className="tiny muted">{t('This game has no common settings – use the .cfg (Settings → Config file).')}</div>}
        <div className="tiny muted">{s.running ? t('Changes take effect after a restart.') : t('Changes take effect with the next start.')}{s.docker && !steam ? ` ${t('In Docker mode a new game port moves the published ports along – the container is created anew on the next (re)start.')}` : ''}</div>
      </div>
    </div>
  );
}

function BehaviourCard({ s, reload }) {
  const steam = isSteam(s);
  const set = async (k, v) => { try { await put(`/games/${s.id}`, { [k]: v }); reload(); } catch (e) { toast.error(e.message); } };
  return (
    <div className="card">
      <div className="card-head"><Settings2 size={16} /><h3>Behaviour</h3></div>
      <div className="card-body stack">
        <SettingRow title="Start with Hostwerk" text="Start automatically when Hostwerk (service) starts."><Switch checked={!!s.autostart} onChange={(v) => set('autostart', v)} /></SettingRow>
        <SettingRow title="Restart after a crash" text={steam ? t('Hostwerk checks every minute and restarts a crashed server (at most 3 times in 30 minutes).') : s.docker ? t('Hostwerk restarts a crashed container.') : t('“monitor” every 5 minutes – LinuxGSM restarts the server after a crash.')}><Switch checked={s.monitor !== false} onChange={(v) => set('monitor', v)} /></SettingRow>
        <SettingRow title={steam ? t('Update on start') : t('Update automatically')} text={steam ? t('SteamCMD checks for a new version before every start – takes a few seconds when nothing is new.') : s.docker ? t('In Docker mode the game updates itself on every start of the server.') : t('Every 6 hours – only when the server is stopped or nobody plays.')}><Switch checked={(s.docker && !steam) || s.autoUpdate !== false} disabled={s.docker && !steam} onChange={(v) => set('autoUpdate', v)} /></SettingRow>
        {s.outside && s.outside.supported && (
          <SettingRow title="Reachable from outside" text={!s.outside.router ? t('Opens the ports in the firewall while the server runs. For the router too, install “Router & port forwarding”.') : s.outside.auto ? t('While the server runs, Hostwerk opens its ports in the firewall and the router – when it stops, they close again.') : t('Opens the ports in the firewall while the server runs. Turn on the automatic mode under Live → Router so the router follows too.')}>
            <Switch checked={!!s.public} onChange={(v) => set('public', v)} />
          </SettingRow>
        )}
      </div>
    </div>
  );
}

function LimitsCard({ s, reload }) {
  const [f, setF] = useState({ cpus: String((s.limits && s.limits.cpus) || ''), memoryMb: String((s.limits && s.limits.memoryMb) || '') });
  const [busy, setBusy] = useState(false);
  if (!s.docker) return null;
  const save = async () => {
    setBusy(true);
    try { const r = await put(`/games/${s.id}/limits`, { cpus: Number(f.cpus) || 0, memoryMb: Number(f.memoryMb) || 0 }); toast.success(r.live ? t('Limits apply right away') : t('Saved – takes effect with the next start')); reload(); } catch (e) { toast.error(e.message); }
    setBusy(false);
  };
  return (
    <div className="card">
      <div className="card-head"><Cpu size={16} /><h3>Resources (Docker)</h3><div className="right"><SaveBtn busy={busy} onClick={save} /></div></div>
      <div className="card-body stack">
        <div className="grid grid-2">
          <Field label="CPU cores" hint={t('e.g. 2 or 1.5 – empty = no limit')}><input className="input mono" inputMode="decimal" value={f.cpus} onChange={(e) => setF({ ...f, cpus: e.target.value })} placeholder="–" /></Field>
          <Field label="Memory (MB)" hint={t('e.g. 8192 – empty = no limit')}><input className="input mono" inputMode="numeric" value={f.memoryMb} onChange={(e) => setF({ ...f, memoryMb: e.target.value })} placeholder="–" /></Field>
        </div>
        <div className="tiny muted">{t('A server that needs more memory than allowed is ended by Docker – leave room above what the game recommends.')}</div>
      </div>
    </div>
  );
}

function StartCard({ s, reload }) {
  const st = s.steam || {};
  const [f, setF] = useState({ customExe: (s.custom && s.custom.exe) || '', customArgs: (s.custom && s.custom.args) || '', extraArgs: s.extraArgs || '', customPorts: (s.customPorts || []).map((p) => `${p.port}/${p.proto.toLowerCase()}`).join(', ') });
  const [busy, setBusy] = useState(false);
  const save = async () => { setBusy(true); try { await put(`/games/${s.id}/quick`, f); toast.success(s.running ? t('Saved – takes effect after a restart') : t('Saved')); reload(); } catch (e) { toast.error(e.message); } setBusy(false); };
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <div className="card">
      <div className="card-head"><Rocket size={16} /><h3>Start</h3><div className="right"><SaveBtn busy={busy} onClick={save} /></div></div>
      <div className="card-body stack">
        {st.profile && <div className="tiny muted">{t('Ready-made start for {game}: {exe}', { game: s.gameName, exe: st.exe || '–' })}</div>}
        <Field label={st.profile ? t('Own start program (optional)') : t('Start program')} hint={t('Path inside the server folder, e.g. MyServer.exe or bin/server.x86_64')}><input className="input mono" value={f.customExe} onChange={set('customExe')} placeholder={st.profile ? st.exe || '' : 'Server.exe'} /></Field>
        <Field label={st.profile ? t('Own parameters instead of the ready-made ones (optional)') : t('Parameters')} hint={t('Quotes group words – nothing is passed to a shell.')}><input className="input mono" value={f.customArgs} onChange={set('customArgs')} placeholder={st.profile ? t('(ready-made)') : '-batchmode -port 27015'} /></Field>
        <Field label="Extra parameters" hint={t('Added at the end, e.g. a server token or a mod list.')}><input className="input mono" value={f.extraArgs} onChange={set('extraArgs')} placeholder="+sv_setsteamaccount TOKEN" /></Field>
        <Field label={st.profile ? t('Own port list (optional)') : t('Ports')} hint={t('For forwarding and the player query, e.g. 27015/udp, 27016/tcp')}><input className="input mono" value={f.customPorts} onChange={set('customPorts')} placeholder={(s.ports || []).map((p) => `${p.port}/${String(p.proto).toLowerCase()}`).join(', ') || '27015/udp'} /></Field>
      </div>
    </div>
  );
}

function BackupSetCard({ s, reload }) {
  const [f, setF] = useState({ saves: s.saves || '', backupKeep: String(s.backupKeep || 10) });
  const [busy, setBusy] = useState(false);
  const save = async () => { setBusy(true); try { await put(`/games/${s.id}/quick`, { saves: f.saves, backupKeep: Number(f.backupKeep) }); toast.success('Saved'); reload(); } catch (e) { toast.error(e.message); } setBusy(false); };
  return (
    <div className="card">
      <div className="card-head"><Archive size={16} /><h3>Backups</h3><div className="right"><SaveBtn busy={busy} onClick={save} /></div></div>
      <div className="card-body stack">
        <div className="grid grid-2">
          <Field label="What to back up" hint={t('Folder inside the server folder (worlds, saves).')}><input className="input mono" value={f.saves} onChange={(e) => setF({ ...f, saves: e.target.value })} placeholder="saves" /></Field>
          <Field label="Keep" hint={t('Newest backups to keep')}><input className="input mono" inputMode="numeric" value={f.backupKeep} onChange={(e) => setF({ ...f, backupKeep: e.target.value })} /></Field>
        </div>
        {!s.saves && <div className="tiny gs-warn">{t('This game keeps its saves outside the server folder – back them up with Hostwerk’s own backups or set a folder here.')}</div>}
      </div>
    </div>
  );
}

function RemoveCard({ s }) {
  const removeAll = async () => { if (await confirmDialog({ title: t('Remove “{name}”?', { name: s.name }), text: 'Stop the server and remove it from Hostwerk. The files in the folder are deleted too.', confirm: 'Remove', danger: true, typeToConfirm: s.name })) { await del(`/games/${s.id}?files=1`); toast.success('Removed'); location.hash = BASE; } };
  const removeListOnly = async () => { if (await confirmDialog({ title: 'Only remove from Hostwerk?', text: 'The folder stays.', confirm: 'Remove' })) { await del(`/games/${s.id}`); location.hash = BASE; } };
  return (
    <div className="card">
      <div className="card-head"><Trash2 size={16} /><h3>Remove</h3></div>
      <div className="card-body row"><Btn className="danger" icon={Trash2} onClick={removeAll}>Delete server</Btn><Btn className="ghost" onClick={removeListOnly}>Only from the list</Btn></div>
    </div>
  );
}

function SettingsTab({ s, reload }) {
  const steam = isSteam(s);
  return (
    <div className="grid grid-2 gs-start">
      <div className="stack">
        <GeneralCard s={s} reload={reload} />
        {steam && <StartCard s={s} reload={reload} />}
      </div>
      <div className="stack">
        <BehaviourCard s={s} reload={reload} />
        <LimitsCard s={s} reload={reload} />
        {steam && <BackupSetCard s={s} reload={reload} />}
        <RemoveCard s={s} />
      </div>
    </div>
  );
}

function LgsmConfig({ s }) {
  const [cfg, setCfg] = useState(null);
  useEffect(() => { get(`/games/${s.id}/config`).then(setCfg).catch((e) => toast.error(e.message)); }, [s.id]);
  if (!cfg) return <Loading />;
  return (
    <div className="grid split-side">
      <div className="card gs-editor"><div className="card-head"><FileText size={16} /><h3>{`${s.script}.cfg`}</h3><div className="right"><Btn className="sm primary" icon={Save} onClick={async () => { try { await put(`/games/${s.id}/config`, { content: cfg.content }); toast.success('Saved – takes effect after a restart'); } catch (e) { toast.error(e.message); } }}>Save</Btn></div></div><Editor value={cfg.content} onChange={(v) => setCfg({ ...cfg, content: v })} lang="shell" /></div>
      <div className="card"><div className="card-head"><Info size={16} /><h3>All options (_default.cfg)</h3></div><div className="card-body tiny muted">Copy a line, paste it on the left and change the value – the left side only holds your changes.</div><pre className="tiny gs-pre gs-tall">{cfg.defaults}</pre></div>
    </div>
  );
}

function SteamConfig({ s, reload }) {
  const files = (s.steam && s.steam.configs) || [];
  const [cur, setCur] = useState(files[0] ? files[0].path : '');
  const [doc, setDoc] = useState(null);
  const [busy, setBusy] = useState(false);
  const [add, setAdd] = useState('');
  useEffect(() => { if (!cur) { setDoc(null); return; } setDoc(null); get(`/games/${s.id}/textfile?path=${encodeURIComponent(cur)}`).then(setDoc).catch((e) => { toast.error(e.message); setDoc({ path: cur, content: '', exists: false }); }); }, [s.id, cur]);
  const save = async () => { setBusy(true); try { setDoc(await put(`/games/${s.id}/textfile`, { path: cur, content: doc.content })); toast.success(s.running ? t('Saved – takes effect after a restart') : t('Saved')); reload(); } catch (e) { toast.error(e.message); } setBusy(false); };
  const addFile = async (e) => { e.preventDefault(); if (!add.trim()) return; try { await put(`/games/${s.id}/quick`, { extraConfig: add.trim() }); setCur(add.trim()); setAdd(''); reload(); } catch (er) { toast.error(er.message); } };
  return (
    <div className="grid split-side">
      <div className="card gs-editor">
        <div className="card-head"><FileText size={16} /><h3 className="ellipsis">{cur || t('Config files')}</h3><div className="right">{cur && <SaveBtn busy={busy} disabled={!doc} onClick={save} />}</div></div>
        {!cur ? <Empty icon={FileText} title="No config file known" text="Add the file of this game on the right – or edit any file in the Files tab." /> : !doc ? <Loading /> : <>
          {!doc.exists && <div className="info-line"><Info size={13} /><span>{t('The file does not exist yet – many games create it on the first start. Saving creates it.')}</span></div>}
          <Editor value={doc.content} onChange={(v) => setDoc({ ...doc, content: v })} filename={cur} />
        </>}
      </div>
      <div className="card">
        <div className="card-head"><FolderOpen size={16} /><h3>Config files</h3></div>
        {files.map((f) => (
          <button key={f.path} type="button" className={`list-item game-row ${cur === f.path ? 'active' : ''}`} onClick={() => setCur(f.path)}>
            <FileText size={15} className="muted" /><div className="grow small ellipsis mono">{f.path}</div>{f.exists === false && <span className="badge">{t('not yet')}</span>}
          </button>
        ))}
        <form className="card-body row-tight gs-top" onSubmit={addFile}><input className="input mono grow" aria-label={t('Add a config file')} placeholder="path/inside/the/server.ini" value={add} onChange={(e) => setAdd(e.target.value)} /><Btn className="sm" icon={Plus} type="submit" disabled={!add.trim()}>Add</Btn></form>
        {s.steam && s.steam.note && <div className="card-body tiny muted">{s.steam.note}</div>}
      </div>
    </div>
  );
}

const TASK_CMDS = [['restart', 'Restart'], ['backup', 'Backup'], ['update', 'Update'], ['start', 'Start'], ['stop', 'Stop']];
function ScheduleTab({ s }) {
  const tasks = useApi('/tasks', [], { live: false, poll: true });
  const [f, setF] = useState({ command: 'restart', time: '05:00' });
  const [busy, setBusy] = useState(false);
  const mine = ((tasks.data && tasks.data.list) || []).filter((x) => x.action && x.action.type === 'game' && x.action.target === s.id);
  const label = (cmd) => t((TASK_CMDS.find((x) => x[0] === cmd) || [cmd, cmd])[1]);
  const add = async () => {
    if (!/^\d{2}:\d{2}$/.test(f.time)) { toast.error(t('Time as HH:MM')); return; }
    setBusy(true);
    try { await post('/tasks', { name: `${s.name}: ${label(f.command)}`, action: { type: 'game', target: s.id, command: f.command }, schedule: { mode: 'daily', time: f.time }, notify: 'error' }); toast.success('Planned'); tasks.reload(); } catch (e) { toast.error(e.message); }
    setBusy(false);
  };
  return (
    <div className="grid split-side">
      <div className="card">
        <div className="card-head"><CalendarClock size={16} /><h3>Planned for this server</h3><div className="right"><a className="btn xs ghost" href="#/aufgaben">{t('All tasks')}</a></div></div>
        {!tasks.data ? <Loading /> : mine.length === 0 ? <div className="card-body small muted">{t('Nothing planned yet – e.g. a restart every night keeps long-running servers fresh.')}</div> : mine.map((x) => (
          <div key={x.id} className="list-item">
            <CalendarClock size={15} className="muted" />
            <div className="grow small"><b>{label(x.action.command)}</b><div className="tiny muted">{x.schedule && x.schedule.mode === 'daily' ? t('daily at {time}', { time: x.schedule.time }) : x.actionLabel}{x.nextRun ? ` · ${t('next: {when}', { when: fmtDate(x.nextRun) })}` : ''}{x.lastStatus ? ` · ${t('last: {s}', { s: x.lastStatus })}` : ''}</div></div>
            {!x.enabled && <span className="badge">{t('off')}</span>}
            <Btn className="xs ghost danger" icon={Trash2} aria-label={t('Delete')} onClick={async () => { if (await confirmDialog({ title: 'Delete the planned task?', text: x.name, confirm: 'Delete', danger: true })) { await del(`/tasks/${x.id}`); tasks.reload(); } }} />
          </div>
        ))}
      </div>
      <div className="card">
        <div className="card-head"><Plus size={16} /><h3>Plan something</h3></div>
        <div className="card-body stack">
          <Field label="What"><select className="select" value={f.command} onChange={(e) => setF({ ...f, command: e.target.value })}>{TASK_CMDS.map(([id, l]) => <option key={id} value={id}>{t(l)}</option>)}</select></Field>
          <Field label="Every day at"><input className="input mono" type="time" value={f.time} onChange={(e) => setF({ ...f, time: e.target.value })} /></Field>
          <Btn className="primary" icon={CalendarClock} busy={busy} onClick={add}>Plan</Btn>
          <div className="tiny muted">{t('Runs through Hostwerk’s tasks – with history, retries and notifications. Other rhythms (weekdays, cron) are set there.')}</div>
        </div>
      </div>
    </div>
  );
}

function BackupsTab({ s, reload }) {
  const list = useApi(`/games/${s.id}/backups`, [s.id], { live: false, poll: true });
  const { busy, run } = useRun(s, () => { reload(); list.reload(); });
  const steam = isSteam(s);
  const restore = async (b) => {
    if (!(await confirmDialog({ title: t('Restore {file}?', { file: b.file }), text: t('The current state of “{dir}” is kept next to it as a copy. The server has to be stopped.', { dir: s.saves || '' }), confirm: 'Restore', danger: true }))) return;
    try { const r = await post(`/games/${s.id}/backups/${encodeURIComponent(b.file)}/restore`); toast.success(r.text || 'Restored'); } catch (e) { toast.error(e.message); }
  };
  return (
    <div className="card">
      <div className="card-head"><Archive size={16} /><h3>Backups</h3><span className="small muted">{steam ? t('of {dir} in backups/', { dir: s.saves || '–' }) : t('backups/ in the server folder')}</span><div className="right"><Btn className="sm primary" icon={Archive} busy={busy === 'backup'} onClick={() => run('backup')}>Back up now</Btn></div></div>
      {s.docker ? <div className="card-body small muted">In Docker mode backups are in the container's volume (Files tab → backups).</div> : !list.data ? <Loading /> : list.data.length === 0 ? <div className="card-body small muted">{steam ? t('No backups yet. Plan a daily backup under Settings → Schedule.') : t('No backups yet. LinuxGSM backs up the whole server (and stops it briefly for that).')}</div> : list.data.map((b) => (
        <div key={b.file} className="list-item"><Archive size={15} className="muted" /><div className="grow small"><b className="mono">{b.file}</b><div className="tiny muted">{fmtDate(b.time)} · {fmtBytes(b.size)}</div></div>
          {steam && /\.zip$/.test(b.file) && <Btn className="xs ghost" icon={RotateCcw} disabled={s.running} title={s.running ? t('Stop the server first') : undefined} onClick={() => restore(b)}>Restore</Btn>}
          <Btn className="xs ghost danger" icon={Trash2} onClick={async () => { if (await confirmDialog({ title: 'Delete backup?', text: b.file, confirm: 'Delete', danger: true })) { await del(`/games/${s.id}/backups/${encodeURIComponent(b.file)}`); list.reload(); } }}>Delete</Btn></div>
      ))}
    </div>
  );
}

function CommandsTab({ s, reload }) {
  const cmds = useApi(`/games/${s.id}/commands`, [s.id], { live: false });
  const { busy, out, run } = useRun(s, reload);
  return (
    <div className="stack">
      <div className="card"><div className="card-head"><Wrench size={16} /><h3>LinuxGSM commands</h3><span className="small muted mono">{`./${s.script} <command>`}</span></div>
        {(cmds.data || []).filter((c) => !/^(console|debug|install|auto-install|skeleton|sponsor|donate)$/.test(c.cmd) && !/^dev-/.test(c.cmd)).map((c) => <div key={c.cmd} className="list-item"><code className="small">{c.cmd}</code>{c.short && <span className="tiny muted mono">{c.short}</span>}<div className="grow small">{s.commands[c.cmd] ? cmdLabel(s, c.cmd) : c.desc}{s.commands[c.cmd] && c.desc ? <span className="tiny muted"> – {c.desc}</span> : null}</div><Btn className="xs" busy={busy === c.cmd} disabled={!!busy} onClick={() => run(c.cmd)}>Run</Btn></div>)}
        <div className="card-body tiny muted">{t('The list comes straight from LinuxGSM for this game.')} <button className="link-btn tiny" onClick={() => get(`/games/${s.id}/commands?fresh=1`).then(() => cmds.reload())}>{t('Read again')}</button></div>
      </div>
      <OutputCard s={s} out={out} />
    </div>
  );
}

/** Not installed yet: the running setup job with its steps, or "continue". */
function InstallView({ s, job, inner, reload }) {
  const { busy, run } = useRun(s, reload);
  const removeUnfinished = async () => { if (await confirmDialog({ title: t('Remove “{name}”?', { name: s.name }), text: 'The started server is deleted.', confirm: 'Remove', danger: true })) { await del(`/games/${s.id}`); location.hash = BASE; reload(); } };
  const m = job && String(job.text || '').match(/^\D*?(\d+)\D+(\d+):\s*(.*)$/);
  const quick = job && String(job.key || '').startsWith('game-quick-');
  const total = m ? Number(m[2]) : 0;
  const names = total === 3 ? [t('Docker'), t('Install'), t('Start')] : [t('Install'), t('Start')];
  const steps = quick && total ? names.map((title, i) => ({ id: String(i), title, text: m && i + 1 === Number(m[1]) ? m[3] : '' })) : null;
  return (
    <div className="card">
      <div className="card-body stack game-install">
        <div className={`game-install-anim ${job ? 'busy' : ''}`}><GameIcon s={s} size={64} className="" /><span className="ring" /><span className="ring r2" /></div>
        {job ? <>
          <div className="bold gs-title">{t('Setting up …')}</div>
          {steps ? <div className="gs-steps-wrap"><SetupSteps steps={steps} current={Number(m[1])} /></div> : <div className="small muted">{job.text || t('Depending on the game this takes a few minutes (download through SteamCMD).')}</div>}
          <div className="gs-progress"><Progress value={job.progress} indeterminate={!job.progress} /></div>
          {(() => { const log = (inner && inner.log && inner.log.length ? inner.log : job.log) || []; return log.length > 0 && <pre className="code-block tiny gs-log">{log.slice(-8).join('\n')}</pre>; })()}
          <div className="tiny muted">{t('Settings, console and commands show up as soon as the installation is done.')}</div>
        </> : <>
          <div className="bold gs-title">{t('Installation not finished')}</div>
          <div className="small muted">{t('The setup was interrupted or failed – the job log says why. After a Windows restart (WSL) simply continue here.')}</div>
          <div className="row-tight"><Btn className="primary" icon={Download} busy={busy === 'auto-install'} onClick={() => run('auto-install')}>Continue installation</Btn><Btn className="ghost" icon={Trash2} onClick={removeUnfinished}>Remove</Btn></div>
        </>}
        <div className="gs-guides"><GuidesCard s={s} compact /></div>
      </div>
    </div>
  );
}

function Server({ s, tab, reload }) {
  const job = useStore((st) => isInstalling(st.jobs, s.id));
  const inner = useStore((st) => innerJob(st.jobs, s.id));
  const contrib = useExtContrib('game'); // tabs from other extensions
  const steam = isSteam(s);
  const groups = [
    { id: 'overview', label: t('Overview'), icon: LayoutDashboard, subs: [['overview', t('Overview'), LayoutDashboard], ['network', t('Network'), Network], ['guides', t('Guides'), BookOpen]] },
    { id: 'console', label: t('Console'), icon: TerminalSquare, subs: steam ? [['console']] : [['console', t('Console'), TerminalSquare], ['commands', t('All commands'), Wrench]] },
    { id: 'players', label: t('Players'), icon: Users, badge: s.live ? s.live.players : undefined, subs: [['players']], disabled: !s.running, title: s.running ? undefined : t('Only while the server runs – the player list comes live from the server') },
    { id: 'settings', label: t('Settings'), icon: Settings2, subs: [['settings', t('General'), SlidersHorizontal], ['config', steam ? t('Config files') : t('Config file'), FileText], ['schedule', t('Schedule'), CalendarClock]] },
    { id: 'backups', label: t('Backups'), icon: Archive, subs: [['backups']] },
    { id: 'files', label: t('Files'), icon: FolderOpen, subs: [['files']] },
  ];
  for (const x of contrib.tabs) groups.push({ id: x.key, label: x.label, icon: x.icon, subs: [[x.key]] });
  // A disabled area (e.g. players while stopped) is not shown – back to the overview
  const group = groups.find((g) => !g.disabled && g.subs.some(([sid]) => sid === tab)) || groups[0];
  const cur = group.subs.some(([sid]) => sid === tab) ? tab : group.subs[0][0];
  const go = (x) => goServer(s.id, x);
  return (
    <div className={`page fade-in ${cur === 'files' ? 'gs-wide' : ''}`}>
      <div className="page-head">
        <div>
          <div className="crumbs small gs-mb"><a href={BASE}>{t('Game servers')}</a><span>/</span>{s.name}</div>
          <h1><GameIcon s={s} className="ico" size={30} /> {s.name} <FavButton kind="game" id={s.id} /> <StatusPill state={stateOf(s, job)} label={stateLabel(s, job)} /></h1>
          <p>{s.gameName || s.script}{s.live && s.live.version ? ` ${s.live.version}` : ''} · {methodLabel(s)}{s.address ? ` · ${t('Port {port}', { port: s.address.port })}` : ''}{s.live ? ` · ${t('{n}/{max} players', { n: s.live.players, max: s.live.maxPlayers })}` : ''}</p>
        </div>
        <div className="actions">
          {isElectron && !s.docker && <Btn className="ghost" icon={ExternalLink} onClick={() => post('/app/open-path', { path: s.dir })}>Folder</Btn>}
          {s.installed && <ServiceButtons base={`/games/${s.id}`} state={s.running ? 'running' : 'stopped'} onError={(e) => toast.error(e.message)} />}
        </div>
      </div>
      {!s.installed ? <InstallView s={s} job={job} inner={inner} reload={reload} /> : <>
        <Tabs tabs={groups.map(({ subs, ...g }) => g)} value={group.id} onChange={(g) => go((groups.find((x) => x.id === g) || groups[0]).subs[0][0])} />
        {group.subs.length > 1 && <div className="sub-tabs"><Seg value={cur} onChange={go} options={group.subs.map(([sid, label, icon]) => ({ id: sid, label, icon }))} /></div>}
        {cur === 'overview' && <OverviewTab s={s} reload={reload} />}
        {cur === 'network' && <NetworkTab s={s} />}
        {cur === 'guides' && <GuidesTab s={s} />}
        {cur === 'console' && <ConsoleTab s={s} />}
        {cur === 'commands' && <CommandsTab s={s} reload={reload} />}
        {cur === 'players' && <PlayersTab s={s} />}
        {cur === 'settings' && <SettingsTab s={s} reload={reload} />}
        {cur === 'config' && (steam ? <SteamConfig s={s} reload={reload} /> : <LgsmConfig s={s} />)}
        {cur === 'schedule' && <ScheduleTab s={s} />}
        {cur === 'backups' && <BackupsTab s={s} reload={reload} />}
        {cur === 'files' && <div className="card gs-files">{s.docker && <div className="info-line"><Info size={13} /><span>{t('In Docker mode the files are in the volume of the Hostwerk Docker engine – the engine has to run.')}</span></div>}<FileBrowser root={`game:${s.id}`} /></div>}
        {contrib.tabs.filter((x) => x.key === cur).map((x) => <ExtTabView key={x.key} item={x} kind="game" id={s.id} />)}
      </>}
    </div>
  );
}

/* ---------------------------------------------------------------- every game server */

function GameCard({ s, installing, reload }) {
  const live = s.live;
  const state = stateOf(s, installing);
  return (
    <div className={`card svc-card mc-card ${s.running ? 'running' : 'stopped'}`} onClick={() => goServer(s.id)} onContextMenu={(e) => serviceMenu(e, {
      icon: { kind: 'game', id: s.id }, name: s.name, state: s.installed ? state : 'missing', base: `/games/${s.id}`, href: `${BASE}/${s.id}`, dir: s.docker ? null : s.dir,
      copy: s.address ? [[t('Copy address'), s.address.local]] : [],
      extra: s.installed ? [{ label: t('Update'), icon: Download, onClick: () => post(`/games/${s.id}/update`).catch((er) => toast.error(er.message)) }, { label: t('Backup'), icon: Archive, onClick: () => post(`/games/${s.id}/backup`).catch((er) => toast.error(er.message)) }, { label: t('Settings'), icon: Settings2, onClick: () => goServer(s.id, 'settings') }] : [],
      remove: async () => { if (await confirmDialog({ title: t('Remove “{name}”?', { name: s.name }), text: 'Stop the server and remove it from Hostwerk (files stay).', confirm: 'Remove', danger: true })) { await del(`/games/${s.id}`); reload(); } },
    })}>
      <div className="svc-top">
        <GameIcon s={s} className="mc-list-icon" size={40} />
        <FavMark kind="game" id={s.id} />
        <div className="grow gs-min">
          <div className="svc-title ellipsis">{s.name}</div>
          <div className="small muted ellipsis"><b>{s.gameName || s.script}</b>{live && live.version ? ` ${live.version}` : ''} · {methodLabel(s)}</div>
        </div>
        <StatusPill state={state} label={stateLabel(s, installing)} />
      </div>
      {live && live.name && <div className="mc-motd small ellipsis">{live.name}</div>}
      <div className="svc-meta">
        <div><div className="k">{t('Address')}</div><div className="v mono small">{s.address ? s.address.local : '–'}</div></div>
        <div><div className="k">{t('Players')}</div><div className="v">{live ? `${live.players} / ${live.maxPlayers}` : '–'}</div></div>
        {live && live.map && <div><div className="k">{t('Map')}</div><div className="v ellipsis small">{live.map}</div></div>}
      </div>
      <div className="svc-actions" onClick={(e) => e.stopPropagation()}>
        {s.installed ? <ServiceButtons base={`/games/${s.id}`} state={s.running ? 'running' : 'stopped'} size="sm" onError={(e) => toast.error(e.message)} />
          : installing ? <span className="small muted"><span className="spinner gs-spin" />{installing.text || t('installing …')}</span>
          : <Btn className="sm primary" icon={Download} onClick={() => post(`/games/${s.id}/auto-install`).then(reload).catch((er) => toast.error(er.message))}>Continue installation</Btn>}
      </div>
    </div>
  );
}

export function GamesPage({ path = [] }) {
  const [id, tab] = path;
  const d = useApi('/games', [], { live: false, poll: true });
  const [create, setCreate] = useState(false);
  const jobs = useStore((st) => st.jobs || {});
  useNew('game', () => setCreate(true));
  useEffect(() => { const x = setInterval(d.reload, 15000); return () => clearInterval(x); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const servers = (d.data && d.data.servers) || [];
  const totalPlayers = useMemo(() => servers.reduce((n, s) => n + ((s.live && s.live.players) || 0), 0), [servers]);
  if (!d.data) return <Loading />;
  const { linux, docker, dockerInstalled, requirements } = d.data;
  const startDocker = async () => { try { const r = await post('/docker/start'); toast('Docker engine is starting …'); await waitJob(r.job); toast.success('Docker is running'); d.reload(); askDockerAutostart(); } catch (e) { toast.error(e.message); } };
  const cur = id && servers.find((s) => s.id === id);
  if (cur) return <Server s={cur} tab={tab || 'overview'} reload={d.reload} />;
  if (id) return <div className="page"><Empty icon={Gamepad2} title="Server not found"><a className="btn" href={BASE}>{t('To the overview')}</a></Empty></div>;
  return (
    <div className="page fade-in">
      <div className="page-head">
        <div><h1><Gamepad2 size={22} /> Game servers</h1><p>Valheim, Palworld, Satisfactory, Rust, ARK and every other Steam server tool – through SteamCMD or LinuxGSM, with console, players, backups, updates and forwarding.</p></div>
        <div className="actions">
          {servers.some((s) => s.live) && <span className="pill info"><Users size={13} /> {t('{n} players online', { n: totalPlayers })}</span>}
          {servers.length > 0 && <Btn className="primary" icon={Plus} onClick={() => setCreate(true)}>New server</Btn>}
        </div>
      </div>
      <Tabs value="servers" onChange={() => {}} tabs={[{ id: 'servers', label: t('Servers'), icon: Gamepad2, badge: servers.length }, noImportTab(t('Game servers'))]} />
      {!linux && !docker && dockerInstalled && servers.some((s) => s.docker) && <Callout kind="warn" icon={Monitor} title="The Docker engine is not running right now" dismissible={false}>Servers in Docker containers need the engine. <Btn className="sm primary gs-ml" icon={Play} onClick={startDocker}>Start Docker</Btn></Callout>}
      {linux && requirements && (requirements.missing.length > 0 || requirements.root) && (
        <Callout kind="warn" title="Requirements" dismissible={false}>
          {requirements.root && <div className="small">{requirements.rootWarning}</div>}
          {requirements.missing.length > 0 && <div className="small">{t('Missing programs:')} <b>{requirements.missing.join(', ')}</b>{requirements.installCmd && <><br />{t('Install ({distro}):', { distro: requirements.distro })}<pre className="tiny gs-mt">{requirements.installCmd}</pre></>}</div>}
        </Callout>
      )}
      {servers.length === 0 ? (
        <div className="stack">
          <QuickStart onMore={() => setCreate(true)} onDone={d.reload} />
          {!IS_LINUX && <InfoTip title="Two ways on Windows" icon={Monitor}>Steam server tools run right on this PC (most games have a Windows version). Games that only exist for Linux – and every LinuxGSM game – run in Hostwerk’s own Docker engine; the setup installs it for you when needed.</InfoTip>}
        </div>
      ) : (
        <div className="grid grid-auto">
          {favSort('game', servers).map((s) => <GameCard key={s.id} s={s} installing={isInstalling(jobs, s.id)} reload={d.reload} />)}
          <AddTile onClick={() => setCreate(true)} title={t('Another game server')} text={t('Every Steam server tool and more than 100 LinuxGSM games')} chips={POPULAR.map(([label, color]) => ({ label, color }))} />
        </div>
      )}
      {create && <CreateDialog linux={linux} onClose={() => setCreate(false)} onDone={() => { setCreate(false); d.reload(); }} />}
    </div>
  );
}

export default {
  pages: { main: GamesPage },
  // Seitenleiste: Punkt je Server (läuft/gestoppt), leere Liste = „noch keiner eingerichtet“ (Hostwerk zeigt dann einen gestrichelten Kreis)
  nav: {
    tip: (o) => {
      const list = (o && Array.isArray(o.games)) ? o.games : [];
      return { text: t('Game servers through SteamCMD or LinuxGSM – on this PC or in Docker containers.'), lines: list.map((g) => ({ name: g.name, state: g.running ? 'running' : 'stopped', text: g.game || '' })) };
    },
  },
};
