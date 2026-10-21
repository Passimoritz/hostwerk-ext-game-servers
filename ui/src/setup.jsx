import { useEffect, useMemo, useState } from 'react';
import { Search, Plus, TerminalSquare, RefreshCw, Rocket, Check, Boxes, ArrowLeft, MemoryStick, Container, Monitor, FolderOpen, HardDrive, AlertTriangle } from 'lucide-react';
import { get, post, useApi, fmtDate } from '@hostwerk/api';
import { Btn, Seg, Field, Loading, Empty, Modal, toast, InfoTip, PathInput } from '@hostwerk/ui';
import { t } from '@hostwerk/i18n';
import { GameArt, GameLogo, goServer } from './common';

/* Game servers – one-step setup and the create dialog (pick a game → set it up), both ways (SteamCMD and LinuxGSM). */

/* ---------------------------------------------------------------- one-step setup */

/** Steps of the setup flow, shown before and while it runs. */
export function SetupSteps({ steps, current = 0, done = false }) {
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
export function plannedSteps(pick, env) {
  const out = [];
  if (pick.needsDocker && !env.docker) out.push({ id: 'docker', title: env.dockerInstalled ? t('Start Docker') : t('Set up Docker'), text: env.dockerInstalled ? t('The engine is set up but off – Hostwerk starts it.') : t('Hostwerk sets up its own Docker engine (no Docker Desktop) – a few minutes, Windows may ask for administrator rights.') });
  out.push({ id: 'install', title: t('Install {game}', { game: pick.name }), text: pick.method === 'steam' ? t('Through SteamCMD, straight from Steam – depending on the game a few GB.') : t('Through LinuxGSM – it loads the game through SteamCMD or from the maker.') });
  out.push({ id: 'start', title: t('Start the server'), text: t('Then it shows up in the list with its address.') });
  return out;
}

export function QuickStart({ onMore, onDone }) {
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
            <div className="gs-cards">
              {env.picks.map((p) => <PickCard key={p.key} pick={{ ...p, game: p.method === 'steam' ? p.gameAppId : p.game, appid: p.appid }} onPick={() => { setSel(p); setName(''); }} badge={p.needsDocker ? 'Docker' : null} />)}
            </div>
            <div className="row-tight"><Btn className="ghost" icon={Search} onClick={onMore}>All games …</Btn></div>
          </>
        ) : (
          <>
            <div className="game-pick">
              <GameLogo short={sel.short} appid={sel.method === 'steam' ? sel.gameAppId : null} size={56} name={sel.name} />
              <div className="grow stack gs-tight">
                <div><b className="gs-title">{sel.name}</b><div className="tiny muted">{sel.method === 'steam' ? t('Steam server tool through SteamCMD') : t('LinuxGSM')}{sel.needsDocker ? t(' · runs as a Docker container') : ''}</div></div>
                <Field label="Name of the server"><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={sel.name} /></Field>
              </div>
              <Btn className="ghost" onClick={() => setSel(null)}>Other game</Btn>
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

/* ---------------------------------------------------------------- create dialog: 1. pick a game */

/** Name of the game from the name of its server tool ("Valheim Dedicated Server" → "Valheim"). */
export const gameName = (n) => String(n || '').replace(/\s*\((dedicated server|server)[^)]*\)\s*$/i, '').replace(/\s*(dedicated server|server|ds)$/i, '').trim() || String(n || '');

/** Steam entry of the list → pick (same shape for both ways). */
const steamPick = (a) => ({ method: 'steam', key: `steam-${a.appid}`, appid: a.appid, game: a.game, name: gameName(a.name), tool: a.name, profile: a.profile, popular: a.popular, ram: a.ram, plan: a.plan, off: a.plan && a.plan.reason ? a.plan.reason : null, needsDocker: !!(a.plan && a.plan.needsDocker) });
const lgsmPick = (g, linux) => ({ method: 'lgsm', key: g.game, game: g.game, short: g.short, name: t(g.hint || g.name), tool: g.name, os: g.os, popular: g.popular !== null && g.popular !== undefined, ram: g.ram, needsDocker: !linux });

/** One game as a card: picture, name, at most one badge, the id quietly at the bottom. */
export function PickCard({ pick, onPick, badge = null, warn = null }) {
  const off = !!pick.off;
  const why = pick.off === 'login' ? t('Needs a Steam account that owns the game') : off ? t('Not available on this system') : null;
  return (
    <button type="button" className={`gs-card${off ? ' gs-card-off' : ''}`} onClick={onPick} disabled={off} title={why || pick.tool || pick.name} aria-label={why ? `${pick.name} – ${why}` : pick.name}>
      <GameArt appid={pick.method === 'steam' ? pick.appid : null} game={pick.method === 'steam' ? pick.game : null} short={pick.short} name={pick.name} shape="wide" />
      <span className="gs-card-body">
        <span className="gs-card-name">{pick.name}</span>
        <span className="gs-card-meta">
          {warn ? <span className="badge warn">{warn}</span> : badge ? <span className="badge">{badge}</span> : null}
          <span className="gs-card-id">{pick.method === 'steam' ? pick.appid : pick.game}</span>
        </span>
      </span>
    </button>
  );
}

const FILTERS = {
  steam: [{ id: '', label: 'All' }, { id: 'ready', label: 'Ready-made start' }, { id: 'native', label: 'Runs without Docker' }],
  lgsm: [{ id: '', label: 'All' }, { id: 'popular', label: 'Popular' }],
};

/** Card badge: only what matters for the choice – Steam login (can not install), Docker (extra engine), else nothing. */
function badgeOf(p) {
  if (p.off === 'login') return { warn: t('Steam login') };
  if (p.off) return { warn: t('other system') };
  if (p.method === 'steam' && p.needsDocker) return { badge: 'Docker' };
  return {};
}

function SteamGrid({ q, filter, onPick }) {
  const [page, setPage] = useState({ items: [], total: 0, list: null });
  const [busy, setBusy] = useState(true);
  const [loadingFull, setLoadingFull] = useState(false);
  const load = async (offset = 0) => {
    setBusy(true);
    try {
      const r = await get(`/games/steam/apps?q=${encodeURIComponent(q)}&filter=${filter}&offset=${offset}&limit=36`);
      setPage((p) => ({ ...r, items: offset ? [...p.items, ...r.items] : r.items }));
    } catch (e) { toast.error(e.message); }
    setBusy(false);
  };
  useEffect(() => { const x = setTimeout(() => load(0), q ? 250 : 0); return () => clearTimeout(x); }, [q, filter]); // eslint-disable-line react-hooks/exhaustive-deps
  const loadFull = async () => {
    setLoadingFull(true);
    try { const st = await post('/games/steam/apps/refresh', { force: !!(page.list && page.list.full) }); toast.success(t('{n} Steam server tools found', { n: st.count })); load(0); } catch (e) { toast.error(e.message); }
    setLoadingFull(false);
  };
  const st = page.list;
  return (
    <>
      {page.items.length > 0 && (
        <div className="gs-cards">
          {page.items.map((a) => { const p = steamPick(a); return <PickCard key={p.key} pick={p} onPick={() => onPick(p)} {...badgeOf(p)} />; })}
        </div>
      )}
      {busy && <Loading />}
      {!busy && page.items.length === 0 && <Empty icon={Search} title="Nothing found" text={st && !st.full ? t('Load every Steam server tool to search all of them.') : t('Try another name or the Steam app id.')} />}
      {page.items.length < page.total && !busy && <Btn className="gs-more" onClick={() => load(page.items.length)}>{t('Show more ({n} left)', { n: page.total - page.items.length })}</Btn>}
      {st && (
        <div className="gs-list-foot">
          <span className="small muted">{st.full ? t('{n} built-in plus {m} from Steam (list from {date})', { n: st.builtIn, m: st.count, date: fmtDate(st.fetchedAt) }) : t('Game missing? {n} server tools are built in – Steam knows many more.', { n: st.builtIn })}</span>
          <Btn className="ghost" icon={RefreshCw} busy={loadingFull} onClick={loadFull}>{st.full ? t('Refresh list') : t('Load every Steam server tool')}</Btn>
        </div>
      )}
    </>
  );
}

function LgsmGrid({ q, filter, onPick, linux }) {
  const [cat, setCat] = useState(null);
  const [err, setErr] = useState(null);
  const [more, setMore] = useState(48);
  useEffect(() => { get('/games/catalog').then(setCat).catch((e) => setErr(e.message)); }, []);
  useEffect(() => { setMore(48); }, [q, filter]);
  const list = useMemo(() => {
    if (!cat) return [];
    const term = q.trim().toLowerCase();
    let games = cat.games.filter((g) => !term || `${g.name} ${g.game} ${g.hint || ''}`.toLowerCase().includes(term));
    if (filter === 'popular') games = games.filter((g) => g.popular !== null && g.popular !== undefined);
    const pop = (g) => (g.popular === null || g.popular === undefined ? 1000 : g.popular);
    return [...games].sort((a, b) => (term ? 0 : pop(a) - pop(b)) || a.name.localeCompare(b.name)).map((g) => lgsmPick(g, linux));
  }, [cat, q, filter, linux]);
  if (err) return <Empty icon={AlertTriangle} title="The game list could not be loaded" text={err} />;
  if (!cat) return <Loading />;
  if (!list.length) return <Empty icon={Search} title="No game found" text={t('LinuxGSM does not know it (yet). Try “Steam (SteamCMD)”.')} />;
  return (
    <>
      <div className="gs-cards">{list.slice(0, more).map((p) => <PickCard key={p.key} pick={p} onPick={() => onPick(p)} />)}</div>
      {list.length > more && <Btn className="gs-more" onClick={() => setMore(more + 48)}>{t('Show more ({n} left)', { n: list.length - more })}</Btn>}
    </>
  );
}

function GameBrowser({ method, setMethod, linux, onPick }) {
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('');
  useEffect(() => { setFilter(''); }, [method]);
  return (
    <div className="stack gs-browser">
      <div className="gs-browse-head">
        <div className="input-icon gs-search"><Search /><input className="input" aria-label={t('Search game')} placeholder={method === 'steam' ? t('Search game or Steam app id …') : t('Search game …')} value={q} onChange={(e) => setQ(e.target.value)} autoFocus /></div>
        <Seg value={method} onChange={setMethod} options={[{ id: 'steam', label: 'Steam (SteamCMD)', icon: Boxes }, { id: 'lgsm', label: 'LinuxGSM', icon: TerminalSquare }]} />
        <InfoTip pop title="Two ways to a game server">
          {t('Steam (SteamCMD): every Steam game with a dedicated server tool – straight on this PC where the tool exists for it, otherwise in Docker. SteamCMD fetches updates on every start.')}{' '}
          {linux ? t('LinuxGSM: more than 100 games with tried and tested scripts, right on this Linux machine.') : t('LinuxGSM: more than 100 games with tried and tested scripts – on Windows they run in a Docker container.')}{' '}
          {t('The full Steam list is read once, only the server tools are kept (a few hundred KB) and reused for 7 days.')}
        </InfoTip>
      </div>
      <div className="gs-filters" role="radiogroup" aria-label={t('Filter')}>
        {FILTERS[method].filter((f) => !(linux && f.id === 'native')).map((f) => <button key={f.id || 'all'} type="button" role="radio" aria-checked={filter === f.id} className={`gs-filter${filter === f.id ? ' on' : ''}`} onClick={() => setFilter(f.id)}>{t(f.label)}</button>)}
      </div>
      {method === 'steam' ? <SteamGrid q={q} filter={filter} onPick={onPick} /> : <LgsmGrid q={q} filter={filter} onPick={onPick} linux={linux} />}
    </div>
  );
}

/* ---------------------------------------------------------------- create dialog: 2. set it up */

/** Memory hint: "about 8 GB – this PC has 16 GB" (warning when it gets tight). */
export function RamHint({ ram }) {
  if (!ram) return null;
  return (
    <span className={`gs-ram${ram.tight ? ' tight' : ''}`}>
      <MemoryStick size={14} aria-hidden="true" />
      {ram.tight ? t('Wants about {gb} GB memory – this PC has {total} GB, it may get tight.', { gb: ram.gb, total: ram.total }) : t('Wants about {gb} GB memory (this PC: {total} GB)', { gb: ram.gb, total: ram.total })}
    </span>
  );
}

/** Port with a free suggestion: checked against the other game servers and the programs on this PC. */
function PortField({ appid, port, setPort }) {
  const [info, setInfo] = useState(null);
  useEffect(() => {
    let alive = true;
    const x = setTimeout(() => {
      get(`/games/ports/suggest?appid=${appid}${port ? `&port=${port}` : ''}`).then((r) => { if (!alive) return; setInfo(r); if (!port && r.port) setPort(r.port); }).catch(() => {});
    }, port ? 400 : 0);
    return () => { alive = false; clearTimeout(x); };
  }, [appid, port]); // eslint-disable-line react-hooks/exhaustive-deps
  const clash = info && Number(port) === info.base && info.taken && info.taken.length > 0;
  const list = info && info.ports ? info.ports.map((p) => `${p.port}/${p.proto}`).join(', ') : '';
  return (
    <Field label="Port">
      <div className="row-tight gs-wrap">
        <input className="input gs-num" type="number" min={1024} max={65535} value={port || ''} onChange={(e) => setPort(Number(e.target.value) || '')} aria-label={t('Port')} />
        {clash && info.port !== info.base ? (
          <><span className="small gs-warn">{t('Taken ({ports})', { ports: info.taken.join(', ') })}</span><Btn className="ghost" onClick={() => setPort(info.port)}>{t('Use {port}', { port: info.port })}</Btn></>
        ) : info && info.port === Number(port) ? <span className="small muted">{info.moved ? t('Free – moved because the default is taken') : t('Free')}{list ? ` · ${list}` : ''}</span> : null}
      </div>
    </Field>
  );
}

function SetupForm({ pick, linux, env, name, setName, opts, setOpts }) {
  const steam = pick.method === 'steam';
  const canDocker = steam ? !!(pick.plan && pick.plan.docker) : linux;
  const mode = opts.mode || (pick.needsDocker ? 'docker' : 'native');
  const steps = plannedSteps({ ...pick, needsDocker: mode === 'docker' }, env || { docker: false, dockerInstalled: false });
  const place = opts.place || 'hostwerk';
  return (
    <div className="stack gs-setup">
      <div className="gs-hero">
        <GameArt appid={steam ? pick.appid : null} game={steam ? pick.game : null} short={pick.short} name={pick.name} shape="wide" className="gs-hero-art" />
        <div className="stack gs-tight">
          <b className="gs-title">{pick.name}</b>
          <span className="small muted">{steam ? t('Steam server tool {id} through SteamCMD', { id: pick.appid }) : t('LinuxGSM script {game}', { game: pick.game })}</span>
          <RamHint ram={pick.ram} />
          {steam && pick.plan && pick.plan.custom && <span className="small gs-warn">{t('No ready-made start for this tool yet – after installing, choose the program and parameters under Settings → Start.')}</span>}
        </div>
      </div>
      <div className="gs-form">
        <Field label="Name of the server"><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={pick.name} autoFocus /></Field>
        {steam && pick.profile && <PortField appid={pick.appid} port={opts.port} setPort={(port) => setOpts((o) => ({ ...o, port }))} />}
        {(canDocker || (!steam && !linux)) && (
          <Field label="Runs">
            {canDocker ? (
              <Seg value={mode} onChange={(m) => setOpts((o) => ({ ...o, mode: m }))} options={[{ id: 'native', label: t('Right on this PC'), icon: Monitor }, { id: 'docker', label: t('In Docker'), icon: Container }]} />
            ) : <span className="small muted">{t('In a Docker container – LinuxGSM needs Linux.')}</span>}
          </Field>
        )}
        {steam && mode === 'native' && (
          <Field label="Where the files go">
            <Seg value={place} onChange={(v) => setOpts((o) => ({ ...o, place: v }))} options={[{ id: 'hostwerk', label: t("In Hostwerk's folder"), icon: HardDrive }, { id: 'own', label: t('Own folder'), icon: FolderOpen }]} />
            {place === 'own' && <PathInput mode="folder" value={opts.dir || ''} onChange={(dir) => setOpts((o) => ({ ...o, dir }))} placeholder={t('Empty or new folder')} />}
          </Field>
        )}
        {mode === 'docker' && <span className="small muted">{t('The files live in a Docker volume of this server.')}</span>}
      </div>
      <div className="label">{t('What happens')}</div>
      <SetupSteps steps={steps} />
    </div>
  );
}

export function CreateDialog({ onClose, onDone, linux }) {
  const [method, setMethod] = useState(linux ? 'lgsm' : 'steam');
  const [pick, setPick] = useState(null);
  const [name, setName] = useState('');
  const [opts, setOpts] = useState({});
  const [busy, setBusy] = useState(false);
  const env = useApi('/games/quick-picks', [], { live: false });
  const choose = (p) => { setPick(p); setName(''); setOpts({}); };
  const create = async () => {
    setBusy(true);
    try {
      const mode = opts.mode || (pick.needsDocker ? 'docker' : 'native');
      const body = pick.method === 'steam'
        ? { method: 'steam', appid: pick.appid, name: name || pick.name, mode, ...(opts.port ? { port: opts.port } : {}), ...(mode === 'native' && opts.place === 'own' && opts.dir ? { dir: opts.dir } : {}) }
        : { method: 'lgsm', game: pick.game, name: name || pick.name, mode: linux ? mode : 'docker' };
      const r = await post('/games', { ...body, start: true, installDocker: true });
      toast(t('“{name}” is being set up – progress on its page.', { name: name || pick.name }));
      onDone(); goServer(r.id);
    } catch (e) { toast.error(e.message); }
    setBusy(false);
  };
  const ownMissing = pick && opts.place === 'own' && !String(opts.dir || '').trim() && (opts.mode || (pick.needsDocker ? 'docker' : 'native')) === 'native';
  return (
    <Modal
      title={pick ? t('Set up {game}', { game: pick.name }) : t('Create game server')}
      subtitle={pick ? t('Step 2 of 2 – name, port and place') : t('Step 1 of 2 – pick a game')}
      onClose={onClose}
      size="wide"
      footer={pick ? (
        <><Btn icon={ArrowLeft} onClick={() => setPick(null)}>Back</Btn><span className="grow" /><Btn onClick={onClose}>Cancel</Btn><Btn className="primary" icon={Plus} busy={busy} disabled={ownMissing} onClick={create}>Create & start</Btn></>
      ) : <Btn onClick={onClose}>Cancel</Btn>}
    >
      {pick ? <SetupForm pick={pick} linux={linux} env={env.data} name={name} setName={setName} opts={opts} setOpts={setOpts} /> : <GameBrowser method={method} setMethod={setMethod} linux={linux} onPick={choose} />}
    </Modal>
  );
}

