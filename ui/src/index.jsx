import { useEffect, useMemo, useState } from 'react';
import { Gamepad2, Play, Download, ShieldCheck, Archive, Search, Plus, Trash2, Settings2, TerminalSquare, Info, RefreshCw, Monitor, ExternalLink, Wrench, FolderOpen, Users, LayoutDashboard, Network, BookOpen, Copy, Map as MapIcon, Tag, Send, Lock } from 'lucide-react';
import { get, post, put, del, useApi, useStore, waitJob, IS_LINUX, fmtBytes, fmtDate, isElectron, openExternal, useRefresh } from '@hostwerk/api';
import { Btn, Tabs, Seg, Field, Switch, SettingRow, Empty, Loading, Callout, StatusPill, Modal, Progress, toast, confirmDialog, InfoTip } from '@hostwerk/ui';
import { SvcImage, Logo, noImportTab, serviceMenu, useNew, FavMark, FavButton, favSort, ServiceButtons, AddTile, useExtContrib, ExtTabView, askDockerAutostart } from '@hostwerk/kit';
import { FileBrowser } from '@hostwerk/files';
import { Editor } from '@hostwerk/editor';
import { t } from '@hostwerk/i18n';
import './style.css';

/*
 * Game servers through LinuxGSM (Linux native, Windows through Docker): same layout as the Minecraft pages – cards with
 * address, players, map and version, a detail page with overview, console, players, network, settings, files/backups and
 * guides. Live values come from the server itself through the Steam query (A2S), commands and ports from LinuxGSM –
 * no list per game to maintain.
 */
const BASE = '#/ext/game-servers';
/** Game logo from the LinuxGSM repository, loaded once visible; without internet the gamepad stays. */
function GameLogo({ short, size = 28, name }) {
  return <Logo src={short ? `https://raw.githubusercontent.com/GameServerManagers/LinuxGSM/master/lgsm/data/gameicons/${short}-icon.png` : null} name={name || short} className="game-logo" size={size} />;
}
const shortOf = (s) => s.short || String(s.game || '').replace(/server$/, '');
const GameIcon = ({ s, size = 30, className = 'svc-icon' }) => <SvcImage kind="game" id={s.id} name={s.name} className={className} size={size} fallback={<GameLogo short={shortOf(s)} size={size} name={s.gameName || s.name} />} />;
const stateOf = (s, installing) => (s.running ? 'running' : s.installed ? 'stopped' : installing ? 'starting' : 'error');
const fmtTime = (sec) => { const m = Math.floor((sec || 0) / 60); return m >= 60 ? t('{h} h {m} min', { h: Math.floor(m / 60), m: m % 60 }) : t('{m} min', { m }); };
const copy = (x) => navigator.clipboard.writeText(x).then(() => toast.success('Address copied'));
const cmdLabel = (s, cmd) => (s.commands && s.commands[cmd] ? t(s.commands[cmd]) : cmd);
// Game names stay as they are
const POPULAR = [['Valheim', '#d97706'], ['Palworld', '#38bdf8'], ['Rust', '#ce422b'], ['Terraria', '#22c55e'], ['Satisfactory', '#f59e0b'], ['ARK', '#64748b'], ['7 Days to Die', '#b91c1c'], ['Project Zomboid', '#84cc16']];

function CreateDialog({ onClose, onDone, mode = 'native' }) {
  const [cat, setCat] = useState(null);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { get('/games/catalog').then(setCat).catch((e) => toast.error(e.message)); }, []);
  const list = cat ? cat.games.filter((g) => !q || `${g.name} ${g.game} ${g.hint || ''}`.toLowerCase().includes(q.toLowerCase())) : [];
  const favs = cat ? cat.games.filter((g) => g.hint) : [];
  const create = async () => {
    setBusy(true);
    try {
      const r = await post('/games', { game: sel.game, name: name || sel.hint || sel.name, mode });
      toast('The server is being set up – depending on the game this can take long (download through SteamCMD).');
      onDone();
      waitJob(r.job).then(() => toast.success('Game server installed')).catch((e) => toast.error(e.message));
    } catch (e) { toast.error(e.message); }
    setBusy(false);
  };
  return (
    <Modal title="Create game server" subtitle="Every game from LinuxGSM – installed through SteamCMD or the maker" onClose={onClose} size="lg" footer={<><Btn onClick={onClose}>Cancel</Btn><Btn className="primary" icon={Plus} busy={busy} disabled={!sel} onClick={create}>Create & install</Btn></>}>
      {!cat ? <Loading /> : (
        <div className="stack">
          <div className="input-icon"><Search /><input className="input" aria-label={t('Search game')} placeholder="Search game (e.g. Valheim, Rust, Terraria) …" value={q} onChange={(e) => setQ(e.target.value)} autoFocus /></div>
          {!q && !sel && (
            <div>
              <div className="label" style={{ marginBottom: 6 }}>Popular</div>
              <div className="game-tiles">{favs.slice(0, 12).map((g) => <button key={g.game} type="button" className="game-tile" onClick={() => setSel(g)} title={g.name}><GameLogo short={g.short} size={40} name={g.name} /><span className="ellipsis">{t(g.hint || g.name)}</span></button>)}</div>
            </div>
          )}
          {sel ? (
            <div className="game-pick">
              <GameLogo short={sel.short} size={56} name={sel.name} />
              <div className="grow stack" style={{ gap: 8, minWidth: 0 }}>
                <div><b style={{ fontSize: 15 }}>{sel.name}</b><div className="tiny muted">{t('LinuxGSM script {game} · {os}', { game: sel.game, os: sel.os })}{mode === 'docker' ? t(' · runs as a Docker container') : ''} · <a href={`https://linuxgsm.com/servers/${sel.game}/`} onClick={(e) => { e.preventDefault(); openExternal(`https://linuxgsm.com/servers/${sel.game}/`); }}>{t('Guide')}</a></div></div>
                <Field label="Name of the server"><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={sel.hint || sel.name} /></Field>
              </div>
              <button type="button" className="btn ghost sm" onClick={() => setSel(null)}>Other game</button>
            </div>
          ) : (
            <div className="stack" style={{ gap: 2, maxHeight: 320, overflow: 'auto' }}>
              {!q && <div className="label" style={{ margin: '4px 0 2px' }}>{t('All games ({n})', { n: cat.games.length })}</div>}
              {(q ? list : cat.games).slice(0, 150).map((g) => <button key={g.game} type="button" className="list-item game-row" onClick={() => setSel(g)}><GameLogo short={g.short} size={28} name={g.name} /><div className="grow small ellipsis"><b>{g.name}</b>{g.hint && <span className="badge" style={{ marginLeft: 6 }}>{t('popular')}</span>}</div><span className="tiny muted mono">{g.game}</span></button>)}
              {q && list.length === 0 && <div className="small muted" style={{ padding: 12 }}>No game found – LinuxGSM does not know it (yet).</div>}
            </div>
          )}
        </div>
      )}
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
  if (!s.address) return <div className="small muted">The address is known as soon as LinuxGSM reported the ports (Network tab → details).</div>;
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="label">Connect</div>
      {[s.address.local, ...s.address.lan].map((a) => <div key={a} className="row-tight"><code className="grow ellipsis">{a}</code><button className="btn ghost xs icon" title="Copy" aria-label={t('Copy')} onClick={() => copy(a)}><Copy /></button></div>)}
      <div className="tiny muted">{t('For friends over the internet: forward the ports in the Network tab.')} <a href={`${BASE}/${s.id}/network`}>{t('Open network')}</a></div>
    </div>
  );
}

const BASE_CMDS = ['start', 'stop', 'restart', 'monitor', 'details', 'postdetails', 'update', 'check-update', 'force-update', 'validate', 'backup', 'update-lgsm', 'test-alert', 'send-alert', 'console', 'debug', 'install', 'auto-install', 'skeleton', 'sponsor', 'donate', 'send'];

function OverviewTab({ s, reload }) {
  const live = s.live;
  const { busy, out, run } = useRun(s, reload);
  const cmds = useApi(s.installed ? `/games/${s.id}/commands` : null, [s.id, s.installed], { live: false });
  const special = (cmds.data || []).filter((c) => !BASE_CMDS.includes(c.cmd) && !/^dev-/.test(c.cmd));
  const removeAll = async () => { if (await confirmDialog({ title: t('Remove “{name}”?', { name: s.name }), text: 'Stop the server and remove it from Hostwerk. The files in the folder are deleted too.', confirm: 'Remove', danger: true, typeToConfirm: s.name })) { await del(`/games/${s.id}?files=1`); toast.success('Removed'); location.hash = BASE; } };
  const removeListOnly = async () => { if (await confirmDialog({ title: 'Only remove from Hostwerk?', text: 'The folder stays.', confirm: 'Remove' })) { await del(`/games/${s.id}`); location.hash = BASE; } };
  return (
    <div className="stack">
      <div className="grid grid-4">
        <div className="card stat"><div className="k"><Users />{t('Players')}</div><div className="v">{live ? live.players : '–'}{live && <span className="muted" style={{ fontSize: 16 }}> / {live.maxPlayers}</span>}</div><div className="s">{s.running ? (live ? (live.bots ? t('{n} bots', { n: live.bots }) : t('online')) : t('no query possible')) : t('Server stopped')}</div></div>
        <div className="card stat"><div className="k"><MapIcon />{t('Map')}</div><div className="v ellipsis" style={{ fontSize: 20, marginTop: 8 }}>{(live && live.map) || '–'}</div><div className="s">{live && live.password ? <><Lock size={11} /> {t('with password')}</> : live ? t('open') : ''}</div></div>
        <div className="card stat"><div className="k"><Tag />{t('Version')}</div><div className="v ellipsis" style={{ fontSize: 20, marginTop: 8 }}>{(live && live.version) || '–'}</div><div className="s">{live && live.vac ? t('VAC protected') : ''}</div></div>
        <div className="card stat"><div className="k"><Network />{t('Ports')}</div><div className="v">{(s.ports || []).length || '–'}</div><div className="s">{live ? t('Query on {port}', { port: live.queryPort }) : <a href={`${BASE}/${s.id}/network`}>{t('show →')}</a>}</div></div>
      </div>
      <div className="grid grid-2">
        <div className="stack">
          <div className="card">
            <div className="card-head"><Gamepad2 size={16} /><h3>State</h3><div className="right"><StatusPill state={s.running ? 'running' : 'stopped'} /></div></div>
            <div className="card-body stack" style={{ gap: 12 }}>
              {live && live.name && <div className="mc-motd small ellipsis" title="Name in the server list">{live.name}</div>}
              <Connect s={s} />
            </div>
          </div>
          <div className="card">
            <div className="card-head"><Wrench size={16} /><h3>Care</h3></div>
            <div className="card-body row" style={{ gap: 6, flexWrap: 'wrap' }}>
              <Btn icon={RefreshCw} busy={busy === 'check-update'} onClick={() => run('check-update')}>Check for updates</Btn>
              <Btn icon={Download} busy={busy === 'update'} onClick={() => run('update')}>Update</Btn>
              <Btn icon={ShieldCheck} busy={busy === 'validate'} onClick={() => run('validate')}>Check files</Btn>
              <Btn icon={Archive} busy={busy === 'backup'} onClick={() => run('backup')}>Backup</Btn>
              <Btn icon={RefreshCw} busy={busy === 'update-lgsm'} onClick={() => run('update-lgsm')}>Update LinuxGSM</Btn>
            </div>
            {special.length > 0 && (
              <div className="card-body stack" style={{ gap: 6, borderTop: '1px solid var(--line)' }}>
                <div className="small bold">{t('Special for {game}', { game: s.gameName || s.name })}</div>
                <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>{special.map((c) => <Btn key={c.cmd} className="sm" icon={Wrench} busy={busy === c.cmd} title={c.desc} onClick={async () => { if (/wipe|remove|delete/.test(c.cmd) && !(await confirmDialog({ title: t('Run {cmd}?', { cmd: c.cmd }), text: c.desc, confirm: 'Run', danger: true }))) return; run(c.cmd); }}>{cmdLabel(s, c.cmd)}</Btn>)}</div>
                <div className="tiny muted">LinuxGSM offers these commands exactly for this game – Hostwerk reads them by itself.</div>
              </div>
            )}
            <div className="card-body stack" style={{ gap: 8, borderTop: '1px solid var(--line)' }}>
              <SettingRow title="Start with Hostwerk" text="Start automatically when Hostwerk (service) starts."><Switch checked={!!s.autostart} onChange={async (v) => { await put(`/games/${s.id}`, { autostart: v }); reload(); }} /></SettingRow>
              {s.outside && s.outside.supported && (
                <SettingRow title="Reachable from outside" text={!s.outside.router ? t('Opens the ports in the firewall while the server runs. For the router too, install “Router & port forwarding”.') : s.outside.auto ? t('While the server runs, Hostwerk opens its ports in the firewall and the router – when it stops, they close again.') : t('Opens the ports in the firewall while the server runs. Turn on the automatic mode under Live → Router so the router follows too.')}>
                  <Switch checked={!!s.public} onChange={async (v) => { await put(`/games/${s.id}`, { public: v }); reload(); }} />
                </SettingRow>
              )}
              <SettingRow title="Update automatically" text={s.docker ? t('In Docker mode the game updates itself on every start of the server.') : t('Every 6 hours – only when the server is stopped or nobody plays.')}><Switch checked={s.docker || s.autoUpdate !== false} disabled={s.docker} onChange={async (v) => { await put(`/games/${s.id}`, { autoUpdate: v }); reload(); }} /></SettingRow>
              <SettingRow title="Monitor" text="“monitor” every 5 minutes – LinuxGSM restarts the server after a crash."><Switch checked={s.monitor !== false} onChange={async (v) => { await put(`/games/${s.id}`, { monitor: v }); reload(); }} /></SettingRow>
            </div>
          </div>
        </div>
        <div className="stack">
          {out && <div className="card"><div className="card-head"><TerminalSquare size={16} /><h3>{t('Output: {cmd}', { cmd: cmdLabel(s, out.cmd) })}</h3></div><pre className="tiny" style={{ maxHeight: 320, overflow: 'auto', margin: 0, padding: 12 }}>{out.text}</pre></div>}
          <GuidesCard s={s} compact />
          <div className="card">
            <div className="card-head"><Trash2 size={16} /><h3>Remove</h3></div>
            <div className="card-body row"><Btn className="danger" icon={Trash2} onClick={removeAll}>Delete server</Btn><Btn className="ghost" onClick={removeListOnly}>Only from the list</Btn></div>
          </div>
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
  return (
    <div className="grid grid-2">
      <GuidesCard s={s} />
      <div className="card">
        <div className="card-head"><Info size={16} /><h3>How this server runs</h3></div>
        <div className="card-body stack small" style={{ gap: 8 }}>
          <div>{t('The server runs through LinuxGSM (script {script})', { script: s.script })}{s.docker ? t(' in the official LinuxGSM Docker container') : t(' right on this Linux machine')}. {t('Installation and updates are downloaded by SteamCMD or the maker.')}</div>
          <div>{t('Settings are in {file} (Settings tab) – all possible options are shown in _default.cfg next to it. Game files (worlds, rules) are under serverfiles/ (Files tab).', { file: `${s.script}.cfg` })}</div>
          <div>Hostwerk reads players, map and version through the Steam server query – that works for most Steam games. Games without this query show “–”.</div>
          <div className="row-tight" style={{ flexWrap: 'wrap' }}>
            <Btn className="sm" icon={ExternalLink} onClick={() => openExternal(`https://linuxgsm.com/servers/${s.script}/`)}>{`LinuxGSM: ${s.script}`}</Btn>
            <Btn className="sm ghost" icon={ExternalLink} onClick={() => openExternal('https://docs.linuxgsm.com/commands')}>All LinuxGSM commands</Btn>
          </div>
        </div>
      </div>
    </div>
  );
}

function ConsoleTab({ s }) {
  const [cons, setCons] = useState(null);
  const [cmd, setCmd] = useState('');
  const [sending, setSending] = useState(false);
  useEffect(() => { const load = () => get(`/games/${s.id}/console?n=400`).then((r) => setCons(r.lines)).catch(() => setCons([])); load(); const x = setInterval(load, 4000); return () => clearInterval(x); }, [s.id]);
  const send = async (e) => { e.preventDefault(); if (!cmd.trim()) return; setSending(true); try { await post(`/games/${s.id}/send`, { command: cmd }); setCmd(''); } catch (er) { toast.error(er.message); } setSending(false); };
  return (
    <div className="card">
      <div className="card-head"><TerminalSquare size={16} /><h3>Console</h3><span className="small muted">{s.docker ? t('container output (every 4 s)') : t('log/console (every 4 s)')}</span>
        {!s.docker && <div className="right"><Btn className="xs" icon={TerminalSquare} onClick={() => { location.hash = `/terminal?cwd=${encodeURIComponent(s.dir)}&cmd=${encodeURIComponent(`./${s.script} console`)}`; }}>Live in the terminal (tmux)</Btn></div>}
      </div>
      {!cons ? <Loading /> : <pre className="tiny console-pre" style={{ maxHeight: 'calc(100vh - 380px)', overflow: 'auto', margin: 0, padding: 12 }}>{cons.join('\n') || t('(no console output yet)')}</pre>}
      {s.canSend ? (
        <form className="card-body row-tight" style={{ borderTop: '1px solid var(--line)' }} onSubmit={send}>
          <input className="input mono grow" aria-label={t('Command to the server')} value={cmd} onChange={(e) => setCmd(e.target.value)} placeholder="Command to the server (e.g. say Hello)" disabled={!s.running} />
          <Btn className="primary" icon={Send} busy={sending} disabled={!s.running || !cmd.trim()} type="submit">Send</Btn>
        </form>
      ) : <div className="card-body tiny muted" style={{ borderTop: '1px solid var(--line)' }}>This game takes no commands through LinuxGSM – use “Live in the terminal” for live input.</div>}
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
        {details.ports.length === 0 ? <div className="card-body small muted">No ports found (server installed?).</div> : details.ports.map((p, i) => <div key={i} className="list-item"><div className="grow small"><b>{p.name}</b> <span className="mono">{p.port}/{p.proto}</span>{s.live && s.live.queryPort === p.port && <span className="badge" style={{ marginLeft: 6 }}>{t('Query')}</span>}</div><a className="btn xs" href={`#/live/router?port=${p.port}&proto=${p.proto}&name=${encodeURIComponent(s.name)}`}>{t('Forward')}</a></div>)}
        <div className="card-body"><Connect s={s} /></div>
      </div>
      <div className="card"><div className="card-head"><Info size={16} /><h3>Details (LinuxGSM)</h3><div className="right"><Btn className="xs ghost" icon={RefreshCw} onClick={load}>Reload</Btn></div></div><pre className="tiny" style={{ maxHeight: 'calc(100vh - 320px)', overflow: 'auto', margin: 0, padding: 12 }}>{details.text}</pre></div>
    </div>
  );
}

function ConfigTab({ s }) {
  const [cfg, setCfg] = useState(null);
  useEffect(() => { get(`/games/${s.id}/config`).then(setCfg).catch((e) => toast.error(e.message)); }, [s.id]);
  if (!cfg) return <Loading />;
  return (
    <div className="grid split-side">
      <div className="card" style={{ height: 'calc(100vh - 340px)' }}><div className="card-head"><Settings2 size={16} /><h3>{`${s.script}.cfg`}</h3><div className="right"><Btn className="sm primary" onClick={async () => { await put(`/games/${s.id}/config`, { content: cfg.content }); toast.success('Saved – takes effect after a restart'); }}>Save</Btn></div></div><Editor value={cfg.content} onChange={(v) => setCfg({ ...cfg, content: v })} lang="shell" /></div>
      <div className="card"><div className="card-head"><Info size={16} /><h3>All options (_default.cfg)</h3></div><div className="card-body tiny muted">Copy a line, paste it on the left and change the value – the left side only holds your changes.</div><pre className="tiny" style={{ maxHeight: 'calc(100vh - 400px)', overflow: 'auto', margin: 0, padding: 12 }}>{cfg.defaults}</pre></div>
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
      {out && <div className="card"><div className="card-head"><TerminalSquare size={16} /><h3>{t('Output: {cmd}', { cmd: cmdLabel(s, out.cmd) })}</h3></div><pre className="tiny" style={{ maxHeight: 320, overflow: 'auto', margin: 0, padding: 12 }}>{out.text}</pre></div>}
    </div>
  );
}

function BackupsTab({ s, reload }) {
  const list = useApi(`/games/${s.id}/backups`, [s.id], { live: false, poll: true });
  const { busy, run } = useRun(s, () => { reload(); list.reload(); });
  return (
    <div className="card">
      <div className="card-head"><Archive size={16} /><h3>Backups</h3><span className="small muted">{t('backups/ in the server folder')}</span><div className="right"><Btn className="sm primary" icon={Archive} busy={busy === 'backup'} onClick={() => run('backup')}>Back up now</Btn></div></div>
      {s.docker ? <div className="card-body small muted">In Docker mode backups are in the container's volume (Files tab → backups).</div> : !list.data ? <Loading /> : list.data.length === 0 ? <div className="card-body small muted">No backups yet. LinuxGSM backs up the whole server (and stops it briefly for that).</div> : list.data.map((b) => (
        <div key={b.file} className="list-item"><Archive size={15} className="muted" /><div className="grow small"><b className="mono">{b.file}</b><div className="tiny muted">{fmtDate(b.time)} · {fmtBytes(b.size)}</div></div><Btn className="xs ghost danger" icon={Trash2} onClick={async () => { if (await confirmDialog({ title: 'Delete backup?', text: b.file, confirm: 'Delete', danger: true })) { await del(`/games/${s.id}/backups/${encodeURIComponent(b.file)}`); list.reload(); } }}>Delete</Btn></div>
      ))}
    </div>
  );
}

function Server({ s, tab, reload }) {
  const job = useStore((st) => Object.values(st.jobs || {}).find((j) => j.key === 'game-create-' + s.id && j.state === 'running') || null);
  const { busy, run } = useRun(s, reload);
  const contrib = useExtContrib('game'); // tabs from other extensions
  const groups = [
    { id: 'overview', label: t('Overview'), icon: LayoutDashboard, subs: [['overview']] },
    { id: 'console', label: t('Console'), icon: TerminalSquare, subs: [['console']] },
    { id: 'players', label: t('Players'), icon: Users, badge: s.live ? s.live.players : undefined, subs: [['players']], disabled: !s.running, title: s.running ? undefined : t('Only while the server runs – the player list comes live from the server') },
    { id: 'network', label: t('Network'), icon: Network, subs: [['network']] },
    { id: 'settings', label: t('Settings'), icon: Settings2, subs: [['settings', t('Configuration'), Settings2], ['commands', t('All commands'), Wrench]] },
    { id: 'files', label: t('Files'), icon: FolderOpen, subs: [['files', t('Files'), FolderOpen], ['backups', t('Backups'), Archive]] },
    { id: 'guides', label: t('Guides'), icon: BookOpen, subs: [['guides']] },
  ];
  for (const x of contrib.tabs) groups.push({ id: x.key, label: x.label, icon: x.icon, subs: [[x.key]] });
  // A disabled area (e.g. players while stopped) is not shown – back to the overview
  const group = groups.find((g) => !g.disabled && g.subs.some(([sid]) => sid === tab)) || groups[0];
  const cur = group.subs.some(([sid]) => sid === tab) ? tab : group.subs[0][0];
  const go = (x) => { location.hash = `${BASE.slice(1)}/${s.id}/${x}`; };
  const removeUnfinished = async () => { if (await confirmDialog({ title: t('Remove “{name}”?', { name: s.name }), text: 'The started server is deleted.', confirm: 'Remove', danger: true })) { await del(`/games/${s.id}`); location.hash = BASE; reload(); } };
  return (
    <div className="page fade-in" style={cur === 'files' ? { maxWidth: 'none' } : undefined}>
      <div className="page-head">
        <div>
          <div className="crumbs small" style={{ marginBottom: 6 }}><a href={BASE}>{t('Game servers')}</a><span>/</span>{s.name}</div>
          <h1><GameIcon s={s} className="ico" size={30} /> {s.name} <FavButton kind="game" id={s.id} /> <StatusPill state={stateOf(s, job)} label={s.installed ? undefined : job ? t('installing') : t('not installed')} /></h1>
          <p>{s.gameName || s.script}{s.live && s.live.version ? ` ${s.live.version}` : ''} · {s.docker ? 'Docker' : 'LinuxGSM'}{s.address ? ` · ${t('Port {port}', { port: s.address.port })}` : ''}{s.live ? ` · ${t('{n}/{max} players', { n: s.live.players, max: s.live.maxPlayers })}` : ''}</p>
        </div>
        <div className="actions">
          {isElectron && !s.docker && <Btn className="ghost" icon={ExternalLink} onClick={() => post('/app/open-path', { path: s.dir })}>Folder</Btn>}
          {s.installed && <ServiceButtons base={`/games/${s.id}`} state={s.running ? 'running' : 'stopped'} onError={(e) => toast.error(e.message)} />}
        </div>
      </div>
      {!s.installed ? (
        <div className="card">
          <div className="card-body stack game-install" style={{ alignItems: 'center', textAlign: 'center', padding: '36px 18px', gap: 12 }}>
            <div className={`game-install-anim ${job ? 'busy' : ''}`}><GameIcon s={s} size={64} className="" /><span className="ring" /><span className="ring r2" /></div>
            {job ? <>
              <div className="bold" style={{ fontSize: 17 }}>{t('Installing …')}</div>
              <div className="small muted">{job.text || t('LinuxGSM loads the server – depending on the game this takes a few minutes (download through SteamCMD).')}</div>
              <div style={{ width: '100%', maxWidth: 420 }}><Progress value={job.progress} indeterminate={!job.progress} /></div>
              {job.log && job.log.length > 0 && <pre className="code-block tiny" style={{ maxHeight: 120, width: '100%', maxWidth: 600, textAlign: 'left', margin: 0 }}>{job.log.slice(-8).join('\n')}</pre>}
              <div className="tiny muted">{t('Settings, console and commands show up as soon as the installation is done.')}</div>
            </> : <>
              <div className="bold" style={{ fontSize: 17 }}>{t('Installation not finished')}</div>
              <div className="small muted">{t('The setup was interrupted or failed – the job log says why.')}</div>
              <div className="row-tight"><Btn className="primary" icon={Download} busy={busy === 'auto-install'} onClick={() => run('auto-install')}>Continue installation</Btn><Btn className="ghost" icon={Trash2} onClick={removeUnfinished}>Remove</Btn></div>
            </>}
            <div style={{ width: '100%', maxWidth: 520, textAlign: 'left' }}><GuidesCard s={s} compact /></div>
          </div>
        </div>
      ) : <>
        <Tabs tabs={groups.map(({ subs, ...g }) => g)} value={group.id} onChange={(g) => go((groups.find((x) => x.id === g) || groups[0]).subs[0][0])} />
        {group.subs.length > 1 && <div className="sub-tabs"><Seg value={cur} onChange={go} options={group.subs.map(([sid, label, icon]) => ({ id: sid, label, icon }))} /></div>}
        {cur === 'overview' && <OverviewTab s={s} reload={reload} />}
        {cur === 'console' && <ConsoleTab s={s} />}
        {cur === 'players' && <PlayersTab s={s} />}
        {cur === 'network' && <NetworkTab s={s} />}
        {cur === 'settings' && <ConfigTab s={s} />}
        {cur === 'commands' && <CommandsTab s={s} reload={reload} />}
        {cur === 'files' && <div className="card" style={{ height: 'calc(100vh - 300px)', overflow: 'hidden' }}>{s.docker && <div className="info-line"><Info size={13} /><span>{t('In Docker mode the files are in the volume of the Hostwerk Docker engine – the engine has to run.')}</span></div>}<FileBrowser root={`game:${s.id}`} /></div>}
        {cur === 'backups' && <BackupsTab s={s} reload={reload} />}
        {cur === 'guides' && <GuidesTab s={s} />}
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
    <div className={`card svc-card mc-card ${s.running ? 'running' : 'stopped'}`} onClick={() => { location.hash = `${BASE.slice(1)}/${s.id}`; }} onContextMenu={(e) => serviceMenu(e, {
      icon: { kind: 'game', id: s.id }, name: s.name, state: s.installed ? state : 'missing', base: `/games/${s.id}`, href: `${BASE}/${s.id}`, dir: s.docker ? null : s.dir,
      copy: s.address ? [[t('Copy address'), s.address.local]] : [],
      extra: s.installed ? [{ label: t('Update'), icon: Download, onClick: () => post(`/games/${s.id}/update`).catch((er) => toast.error(er.message)) }, { label: t('Backup'), icon: Archive, onClick: () => post(`/games/${s.id}/backup`).catch((er) => toast.error(er.message)) }, { label: t('Guide (LinuxGSM)'), icon: BookOpen, onClick: () => openExternal(`https://linuxgsm.com/servers/${s.script}/`) }] : [],
      remove: async () => { if (await confirmDialog({ title: t('Remove “{name}”?', { name: s.name }), text: 'Stop the server and remove it from Hostwerk (files stay).', confirm: 'Remove', danger: true })) { await del(`/games/${s.id}`); reload(); } },
    })}>
      <div className="svc-top">
        <GameIcon s={s} className="mc-list-icon" size={40} />
        <FavMark kind="game" id={s.id} />
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="svc-title ellipsis">{s.name}</div>
          <div className="small muted ellipsis"><b>{s.gameName || s.script}</b>{live && live.version ? ` ${live.version}` : ''} · {s.docker ? 'Docker' : 'LinuxGSM'}</div>
        </div>
        <StatusPill state={state} label={s.installed ? undefined : installing ? t('Installing …') : t('not installed')} />
      </div>
      {live && live.name && <div className="mc-motd small ellipsis">{live.name}</div>}
      <div className="svc-meta">
        <div><div className="k">{t('Address')}</div><div className="v mono small">{s.address ? s.address.local : '–'}</div></div>
        <div><div className="k">{t('Players')}</div><div className="v">{live ? `${live.players} / ${live.maxPlayers}` : '–'}</div></div>
        {live && live.map && <div><div className="k">{t('Map')}</div><div className="v ellipsis small">{live.map}</div></div>}
      </div>
      <div className="svc-actions" onClick={(e) => e.stopPropagation()}>
        {s.installed ? <ServiceButtons base={`/games/${s.id}`} state={s.running ? 'running' : 'stopped'} size="sm" onError={(e) => toast.error(e.message)} />
          : installing ? <span className="small muted"><span className="spinner" style={{ width: 12, height: 12, marginRight: 6 }} />{t('installing …')}</span>
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
  const installing = (sid) => Object.values(jobs).some((j) => j.key === 'game-create-' + sid && j.state === 'running');
  useEffect(() => { const x = setInterval(d.reload, 15000); return () => clearInterval(x); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const servers = (d.data && d.data.servers) || [];
  const totalPlayers = useMemo(() => servers.reduce((n, s) => n + ((s.live && s.live.players) || 0), 0), [servers]);
  if (!d.data) return <Loading />;
  const { linux, docker, dockerInstalled, requirements } = d.data;
  const canCreate = linux || docker;
  const startDocker = async () => { try { const r = await post('/docker/start'); toast('Docker engine is starting …'); await waitJob(r.job); toast.success('Docker is running'); d.reload(); askDockerAutostart(); } catch (e) { toast.error(e.message); } };
  const cur = id && servers.find((s) => s.id === id);
  if (cur) return <Server s={cur} tab={tab || 'overview'} reload={d.reload} />;
  if (id) return <div className="page"><Empty icon={Gamepad2} title="Server not found"><a className="btn" href={BASE}>{t('To the overview')}</a></Empty></div>;
  return (
    <div className="page fade-in">
      <div className="page-head">
        <div><h1><Gamepad2 size={22} /> Game servers</h1><p>Valheim, Terraria, Palworld, Satisfactory, Rust, ARK and more than 100 others – through LinuxGSM, with console, players, backup, updates and forwarding.</p></div>
        <div className="actions">
          {servers.some((s) => s.live) && <span className="pill info"><Users size={13} /> {t('{n} players online', { n: totalPlayers })}</span>}
          {canCreate && <Btn className="grad" icon={Plus} onClick={() => setCreate(true)}>{linux ? t('New server') : t('New server (Docker)')}</Btn>}
        </div>
      </div>
      <Tabs value="servers" onChange={() => {}} tabs={[{ id: 'servers', label: t('Servers'), icon: Gamepad2, badge: servers.length }, noImportTab(t('Game servers'))]} />
      {!linux && docker && <InfoTip title="On Windows too: LinuxGSM in a Docker container" icon={Monitor}>Hostwerk's Docker engine (WSL) runs the official LinuxGSM image – one container per game, data in a volume, ports published 1:1. Every command, the console and the settings work like on Linux.</InfoTip>}
      {!linux && !docker && dockerInstalled && <Callout kind="warn" icon={Monitor} title="The Docker engine is not running right now" dismissible={false}>On Windows game servers run as Docker containers. The engine is set up but off. <Btn className="sm primary" style={{ marginLeft: 8 }} icon={Play} onClick={startDocker}>Start Docker</Btn></Callout>}
      {!linux && !docker && !dockerInstalled && (
        <InfoTip title="Only on Linux – or with Docker" icon={Monitor}>
          LinuxGSM (linuxgsm.com) only runs on Linux. Three ways:
          <ul className="small" style={{ margin: '6px 0 0 18px' }}>
            <li><b>{t('Own server (VPS)')}</b> – {t('set it up with the Hostwerk network extension; this page is then ready there (switch the machine at the top).')}</li>
            <li><b>{t('Linux PC at home')}</b> – {t('install Hostwerk for Linux and pair it.')}</li>
            <li><b>{t('Docker here')}</b> – {t('set up the Hostwerk Docker engine under Projects & apps → Docker; then game servers run as containers on this PC.')}</li>
          </ul>
          {!IS_LINUX && <div className="small muted" style={{ marginTop: 6 }}>{t('Minecraft servers keep running right here on Windows.')}</div>}
        </InfoTip>
      )}
      {linux && requirements && (requirements.missing.length > 0 || requirements.root) && (
        <Callout kind="warn" title="Requirements" dismissible={false}>
          {requirements.root && <div className="small">{requirements.rootWarning}</div>}
          {requirements.missing.length > 0 && <div className="small">{t('Missing programs:')} <b>{requirements.missing.join(', ')}</b>{requirements.installCmd && <><br />{t('Install ({distro}):', { distro: requirements.distro })}<pre className="tiny" style={{ marginTop: 4 }}>{requirements.installCmd}</pre></>}</div>}
        </Callout>
      )}
      {servers.length === 0 ? (
        <div className="card"><Empty icon={Gamepad2} title="No game server yet" text={canCreate ? t('Create the first one – Hostwerk loads LinuxGSM, creates the game script and installs the server.') : t('As soon as a Linux machine is paired or Docker is set up, you create servers here.')}>{canCreate && <Btn className="grad" icon={Plus} onClick={() => setCreate(true)}>Create server</Btn>}</Empty></div>
      ) : (
        <div className="grid grid-auto">
          {favSort('game', servers).map((s) => <GameCard key={s.id} s={s} installing={installing(s.id)} reload={d.reload} />)}
          {canCreate && <AddTile onClick={() => setCreate(true)} title={t('Another game server')} text={t('More than 100 games from LinuxGSM – installed through SteamCMD')} chips={POPULAR.map(([label, color]) => ({ label, color }))} />}
        </div>
      )}
      {create && <CreateDialog mode={linux ? 'native' : 'docker'} onClose={() => setCreate(false)} onDone={() => { setCreate(false); d.reload(); }} />}
    </div>
  );
}

export default {
  pages: { main: GamesPage },
};
