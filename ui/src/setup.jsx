import { useEffect, useState } from 'react';
import { Search, Plus, TerminalSquare, RefreshCw, Rocket, Check, Boxes } from 'lucide-react';
import { get, post, useApi, fmtBytes, fmtDate } from '@hostwerk/api';
import { Btn, Seg, Field, Loading, Modal, toast, InfoTip } from '@hostwerk/ui';
import { t } from '@hostwerk/i18n';
import { GameLogo, goServer } from './common';

/* Game servers – one-step setup and the create dialog (LinuxGSM and SteamCMD). */

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

export function SteamPicker({ sel, setSel }) {
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

export function CreateDialog({ onClose, onDone, linux }) {
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
