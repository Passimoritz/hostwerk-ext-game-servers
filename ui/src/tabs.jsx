import { useEffect, useState } from 'react';
import { Gamepad2, Download, ShieldCheck, Archive, Plus, Trash2, TerminalSquare, Info, RefreshCw, ExternalLink, Wrench, Users, Network, BookOpen, Copy, Map as MapIcon, Tag, Send, Lock, CalendarClock, Check, RotateCcw, KeyRound, Boxes, Save, FolderOpen, FileText } from 'lucide-react';
import { get, post, del, useApi, waitJob, fmtBytes, fmtDate, openExternal, useRefresh, put } from '@hostwerk/api';
import { Btn, Field, Empty, Loading, StatusPill, toast, confirmDialog, InfoTip, TileEmpty } from '@hostwerk/ui';
import { t } from '@hostwerk/i18n';
import { BASE, cmdLabel, copy, fmtTime, isSteam, isBusy, busyReason, PhaseBar, stateOf, stateLabel } from './common';

/* Game servers – detail tabs of one server: overview, network, guides, console, players, workshop, schedule, backups, commands. */

/* ---------------------------------------------------------------- detail tabs */

export function useRun(s, reload) {
  const [busy, setBusy] = useState(null);
  const [out, setOut] = useState(null);
  const run = async (cmd, args) => {
    setBusy(cmd);
    try { const r = await post(`/games/${s.id}/${cmd}`, { args }); const j = await waitJob(r.job); setOut({ cmd, text: j.result.output || j.result.text }); toast.success(`${cmdLabel(s, cmd)}: ${j.result.text || 'ok'}`); } catch (e) { toast.error(e.message); }
    setBusy(null); reload();
  };
  return { busy, out, run };
}

export function Connect({ s }) {
  if (!s.address) return <div className="small muted">{isSteam(s) ? t('No ports known yet – set them under Settings → Start.') : t('The address is known as soon as LinuxGSM reported the ports (Network tab → details).')}</div>;
  return (
    <div className="stack gs-tight">
      <div className="label">Connect</div>
      {[s.address.local, ...s.address.lan].map((a) => <div key={a} className="row-tight"><code className="grow ellipsis">{a}</code><button className="btn ghost xs icon" title="Copy" aria-label={t('Copy')} onClick={() => copy(a)}><Copy /></button></div>)}
      <div className="tiny muted">{t('For friends over the internet: switch on “Reachable from outside” in the settings or forward the ports.')} <a href={`${BASE}/${s.id}/network`}>{t('Open network')}</a></div>
    </div>
  );
}

export const BASE_CMDS = ['start', 'stop', 'restart', 'monitor', 'details', 'postdetails', 'update', 'check-update', 'force-update', 'validate', 'backup', 'update-lgsm', 'test-alert', 'send-alert', 'console', 'debug', 'install', 'auto-install', 'skeleton', 'sponsor', 'donate', 'send'];

export function OutputCard({ s, out }) {
  if (!out) return null;
  return <div className="card"><div className="card-head"><TerminalSquare size={16} /><h3>{t('Output: {cmd}', { cmd: cmdLabel(s, out.cmd) })}</h3></div><pre className="tiny gs-pre">{out.text}</pre></div>;
}

export function OverviewTab({ s, reload, phase = null }) {
  const live = s.live;
  const steam = isSteam(s);
  const { busy, out, run } = useRun(s, reload);
  // Während Installation/Update scheitern die Pflege-Befehle – gesperrt mit Grund; nach dem Wechsel auf „Läuft“ neu lesen
  const locked = isBusy(phase);
  const why = busyReason(phase);
  const cmds = useApi(s.installed && !steam ? `/games/${s.id}/commands` : null, [s.id, s.installed, locked], { live: false });
  const special = (cmds.data || []).filter((c) => !BASE_CMDS.includes(c.cmd) && !/^dev-/.test(c.cmd));
  return (
    <div className="stack">
      <div className="grid grid-4">
        <div className="card stat"><div className="k"><Users />{t('Players')}</div><div className="v">{live ? live.players : '–'}{live && <span className="muted gs-sub"> / {live.maxPlayers}</span>}</div><div className="s">{locked ? stateLabel(s, null, phase) : s.running ? (live ? (live.bots ? t('{n} bots', { n: live.bots }) : t('online')) : t('no query possible')) : t('Server stopped')}</div></div>
        <div className="card stat"><div className="k"><MapIcon />{t('Map')}</div><div className="v ellipsis gs-v">{(live && live.map) || '–'}</div><div className="s">{live && live.password ? <><Lock size={11} /> {t('with password')}</> : live ? t('open') : ''}</div></div>
        <div className="card stat"><div className="k"><Tag />{t('Version')}</div><div className="v ellipsis gs-v">{(live && live.version) || '–'}</div><div className="s">{live && live.vac ? t('VAC protected') : ''}</div></div>
        <div className="card stat"><div className="k"><Network />{t('Ports')}</div><div className="v">{(s.ports || []).length || '–'}</div><div className="s">{live ? t('Query on {port}', { port: live.queryPort }) : <a href={`${BASE}/${s.id}/network`}>{t('show →')}</a>}</div></div>
      </div>
      <div className="grid grid-2">
        <div className="stack">
          <div className="card">
            <div className="card-head"><Gamepad2 size={16} /><h3>State</h3><div className="right"><StatusPill state={stateOf(s, null, phase)} label={stateLabel(s, null, phase)} /></div></div>
            <div className="card-body stack">
              {locked && <PhaseBar phase={phase} />}
              {live && live.name && <div className="mc-motd small ellipsis" title="Name in the server list">{live.name}</div>}
              <Connect s={s} />
              {steam && s.steam && s.steam.adminPassword && <div className="row-tight tiny"><KeyRound size={13} className="muted" /><span className="muted">{t('Admin/RCON password:')}</span><code>{s.steam.adminPassword}</code><button className="btn ghost xs icon" title="Copy" aria-label={t('Copy')} onClick={() => navigator.clipboard.writeText(s.steam.adminPassword).then(() => toast.success('Copied'))}><Copy /></button></div>}
              {steam && s.steam && s.steam.note && <div className="info-line"><Info size={13} /><span>{s.steam.note}</span></div>}
            </div>
          </div>
          <div className="card">
            <div className="card-head"><Wrench size={16} /><h3>Care</h3>{locked && <div className="right"><InfoTip title={why} pop>{t('Updating, checking files, backups and mods need the finished game – they work again by themselves as soon as the server runs. Stopping works any time.')}</InfoTip></div>}</div>
            <div className="card-body row gs-wrap">
              {!steam && <Btn icon={RefreshCw} busy={busy === 'check-update'} disabled={locked} title={why || undefined} onClick={() => run('check-update')}>Check for updates</Btn>}
              <Btn icon={Download} busy={busy === 'update'} disabled={locked} title={why || undefined} onClick={() => run('update')}>Update</Btn>
              <Btn icon={ShieldCheck} busy={busy === 'validate'} disabled={locked} title={why || undefined} onClick={() => run('validate')}>Check files</Btn>
              <Btn icon={Archive} busy={busy === 'backup'} disabled={locked} title={why || undefined} onClick={() => run('backup')}>Backup</Btn>
              {!steam && <Btn icon={RefreshCw} busy={busy === 'update-lgsm'} disabled={locked} title={why || undefined} onClick={() => run('update-lgsm')}>Update LinuxGSM</Btn>}
            </div>
            {special.length > 0 && (
              <div className="card-body stack gs-top">
                <div className="small bold">{t('Special for {game}', { game: s.gameName || s.name })}</div>
                <div className="row gs-wrap">{special.map((c) => <Btn key={c.cmd} className="sm" icon={Wrench} busy={busy === c.cmd} disabled={locked} title={why || c.desc} onClick={async () => { if (/wipe|remove|delete/.test(c.cmd) && !(await confirmDialog({ title: t('Run {cmd}?', { cmd: c.cmd }), text: c.desc, confirm: 'Run', danger: true }))) return; run(c.cmd); }}>{cmdLabel(s, c.cmd)}</Btn>)}</div>
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

export function GuidesCard({ s, compact }) {
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

export function GuidesTab({ s }) {
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

export function ConsoleTab({ s, phase = null }) {
  const [cons, setCons] = useState(null);
  const [raw, setRaw] = useState(false); // Rohausgabe statt zusammengefasster Fortschrittszeilen
  const locked = isBusy(phase);
  const [cmd, setCmd] = useState('');
  const [sending, setSending] = useState(false);
  const [reply, setReply] = useState(null);
  useEffect(() => { const load = () => get(`/games/${s.id}/console?n=400${raw ? '&raw=1' : ''}`).then((r) => setCons(r.lines)).catch(() => setCons([])); load(); const x = setInterval(() => { if (!document.hidden) load(); }, 4000); return () => clearInterval(x); }, [s.id, raw]);
  const send = async (e) => { e.preventDefault(); if (!cmd.trim()) return; setSending(true); try { const r = await post(`/games/${s.id}/send`, { command: cmd }); setReply(r && r.output ? r.output : null); setCmd(''); } catch (er) { toast.error(er.message); } setSending(false); };
  const steam = isSteam(s);
  return (
    <div className="card">
      <div className="card-head"><TerminalSquare size={16} /><h3>Console</h3><span className="small muted">{s.docker ? t('container output (every 4 s)') : steam ? t('server output (every 4 s)') : t('log/console (every 4 s)')}</span>
        <div className="right row-tight">
          <Btn className="xs ghost" icon={FileText} aria-pressed={raw} title={raw ? t('Show progress lines summarized') : t('Show every line exactly as the server wrote it')} onClick={() => setRaw(!raw)}>{raw ? t('Summarized') : t('Raw output')}</Btn>
          {!s.docker && !steam && <Btn className="xs" icon={TerminalSquare} onClick={() => { location.hash = `/terminal?cwd=${encodeURIComponent(s.dir)}&cmd=${encodeURIComponent(`./${s.script} console`)}`; }}>Live in the terminal (tmux)</Btn>}
        </div>
      </div>
      {locked && <div className="card-body"><PhaseBar phase={phase} /></div>}
      {!cons ? <Loading /> : <pre className="tiny console-pre gs-console">{cons.join('\n') || t('(no console output yet)')}</pre>}
      {reply && <pre className="tiny gs-reply">{reply}</pre>}
      {s.canSend ? (
        <form className="card-body row-tight gs-top" onSubmit={send}>
          <input className="input mono grow" aria-label={t('Command to the server')} value={cmd} onChange={(e) => setCmd(e.target.value)} placeholder={locked ? busyReason(phase) : steam ? t('Command to the server (RCON, e.g. status)') : t('Command to the server (e.g. say Hello)')} disabled={!s.running || locked} />
          <Btn className="primary" icon={Send} busy={sending} disabled={!s.running || locked || !cmd.trim()} title={locked ? busyReason(phase) : undefined} type="submit">Send</Btn>
        </form>
      ) : <div className="card-body tiny muted gs-top">{steam ? t('This game takes no console commands through Hostwerk – use its own admin tools or config files.') : t('This game takes no commands through LinuxGSM – use “Live in the terminal” for live input.')}</div>}
    </div>
  );
}

export function PlayersTab({ s }) {
  const [d, setD] = useState(null);
  useEffect(() => { if (!s.running) return undefined; const load = () => get(`/games/${s.id}/players`).then(setD).catch(() => setD({ players: [] })); load(); const x = setInterval(() => { if (!document.hidden) load(); }, 10000); return () => clearInterval(x); }, [s.id, s.running]);
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

export function NetworkTab({ s }) {
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


export const TASK_CMDS = [['restart', 'Restart'], ['backup', 'Backup'], ['update', 'Update'], ['start', 'Start'], ['stop', 'Stop']];
export function ScheduleTab({ s }) {
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
        {!tasks.data ? <Loading /> : mine.length === 0 ? <TileEmpty text={t('Nothing planned yet – e.g. a restart every night keeps long-running servers fresh.')} /> : mine.map((x) => (
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

export function BackupsTab({ s, reload, phase = null }) {
  const list = useApi(`/games/${s.id}/backups`, [s.id], { live: false, poll: true });
  const { busy, run } = useRun(s, () => { reload(); list.reload(); });
  const steam = isSteam(s);
  const restore = async (b) => {
    if (!(await confirmDialog({ title: t('Restore {file}?', { file: b.file }), text: t('The current state of “{dir}” is kept next to it as a copy. The server has to be stopped.', { dir: s.saves || '' }), confirm: 'Restore', danger: true }))) return;
    try { const r = await post(`/games/${s.id}/backups/${encodeURIComponent(b.file)}/restore`); toast.success(r.text || 'Restored'); } catch (e) { toast.error(e.message); }
  };
  return (
    <div className="card">
      <div className="card-head"><Archive size={16} /><h3>Backups</h3><span className="small muted">{steam ? t('of {dir} in backups/', { dir: s.saves || '–' }) : t('backups/ in the server folder')}</span><div className="right"><Btn className="sm primary" icon={Archive} busy={busy === 'backup'} disabled={isBusy(phase)} title={busyReason(phase) || undefined} onClick={() => run('backup')}>Back up now</Btn></div></div>
      {s.docker ? <div className="card-body small muted">In Docker mode backups are in the container's volume (Files tab → backups).</div> : !list.data ? <Loading /> : list.data.length === 0 ? <div className="card-body small muted">{steam ? t('No backups yet. Plan a daily backup under Settings → Schedule.') : t('No backups yet. LinuxGSM backs up the whole server (and stops it briefly for that).')}</div> : list.data.map((b) => (
        <div key={b.file} className="list-item"><Archive size={15} className="muted" /><div className="grow small"><b className="mono">{b.file}</b><div className="tiny muted">{fmtDate(b.time)} · {fmtBytes(b.size)}</div></div>
          {steam && /\.zip$/.test(b.file) && <Btn className="xs ghost" icon={RotateCcw} disabled={s.running} title={s.running ? t('Stop the server first') : undefined} onClick={() => restore(b)}>Restore</Btn>}
          <Btn className="xs ghost danger" icon={Trash2} onClick={async () => { if (await confirmDialog({ title: 'Delete backup?', text: b.file, confirm: 'Delete', danger: true })) { await del(`/games/${s.id}/backups/${encodeURIComponent(b.file)}`); list.reload(); } }}>Delete</Btn></div>
      ))}
    </div>
  );
}

export function CommandsTab({ s, reload, phase = null }) {
  const locked = isBusy(phase);
  const cmds = useApi(`/games/${s.id}/commands`, [s.id, locked], { live: false });
  const { busy, out, run } = useRun(s, reload);
  return (
    <div className="stack">
      <div className="card"><div className="card-head"><Wrench size={16} /><h3>LinuxGSM commands</h3><span className="small muted mono">{`./${s.script} <command>`}</span>{locked && <div className="right"><InfoTip title={busyReason(phase)} pop>{t('LinuxGSM commands need the finished game – they work again by themselves as soon as the server runs. Stopping works any time.')}</InfoTip></div>}</div>
        {(cmds.data || []).filter((c) => !/^(console|debug|install|auto-install|skeleton|sponsor|donate)$/.test(c.cmd) && !/^dev-/.test(c.cmd)).map((c) => <div key={c.cmd} className="list-item"><code className="small">{c.cmd}</code>{c.short && <span className="tiny muted mono">{c.short}</span>}<div className="grow small">{s.commands[c.cmd] ? cmdLabel(s, c.cmd) : c.desc}{s.commands[c.cmd] && c.desc ? <span className="tiny muted"> – {c.desc}</span> : null}</div><Btn className="xs" busy={busy === c.cmd} disabled={!!busy || (locked && !/^(start|stop|monitor)$/.test(c.cmd))} title={locked && !/^(start|stop|monitor)$/.test(c.cmd) ? busyReason(phase) : undefined} aria-label={`${t('Run')}: ${c.cmd}`} onClick={() => run(c.cmd)}>Run</Btn></div>)}
        <div className="card-body tiny muted">{t('The list comes straight from LinuxGSM for this game.')} <button className="link-btn tiny" onClick={() => get(`/games/${s.id}/commands?fresh=1`).then(() => cmds.reload())}>{t('Read again')}</button></div>
      </div>
      <OutputCard s={s} out={out} />
    </div>
  );
}

/** Steam Workshop: Inhalte je Server (ID oder Link), mit SteamCMD laden und aktualisieren. */
export function WorkshopTab({ s }) {
  const w = useApi(`/games-workshop/${s.id}`, [s.id], { live: false });
  const [f, setF] = useState(null);
  const [busy, setBusy] = useState(false);
  const d = w.data;
  useEffect(() => { if (d && !f) setF({ appid: d.appid ? String(d.appid) : '', items: d.items.map((x) => x.id).join('\n') }); }, [d]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!d) return w.error ? <div className="card"><Empty icon={Boxes} title="The workshop list could not be loaded" text={w.error} action={<Btn icon={RefreshCw} onClick={() => w.reload()}>Try again</Btn>} /></div> : <Loading />;
  const save = async () => { setBusy(true); try { w.setData(await put(`/games-workshop/${s.id}`, { appid: f.appid, items: f.items })); toast.success('Saved'); } catch (e) { toast.error(e.message); } setBusy(false); };
  const update = async () => { setBusy(true); try { await save(); const r = await post(`/games-workshop/${s.id}/update`); const j = await waitJob(r.job); toast.success((j.result && j.result.text) || t('Done')); w.reload(); } catch (e) { toast.error(e.message); } setBusy(false); };
  const locale = document.documentElement.lang === 'en' ? 'en-US' : 'de-DE';
  return (
    <div className="grid grid-2 gs-start">
      <div className="card">
        <div className="card-head"><Boxes size={16} /><h3>Workshop items</h3><InfoTip title="Steam Workshop">Mods and maps from the Steam Workshop. Hostwerk downloads them with SteamCMD into the server folder; the game’s start line or config then loads them (each game a bit differently – see the guides).</InfoTip></div>
        <div className="card-body stack">
          <Field label="App id of the game" hint="The number in the Steam store address of the game (not the server tool)."><input className="input gs-num" inputMode="numeric" value={f ? f.appid : ''} onChange={(e) => setF({ ...f, appid: e.target.value.replace(/\D/g, '') })} aria-label={t('App id of the game')} /></Field>
          <Field label="Items" hint="One workshop id or link per line."><textarea className="input mono" rows={6} value={f ? f.items : ''} onChange={(e) => setF({ ...f, items: e.target.value })} placeholder="https://steamcommunity.com/sharedfiles/filedetails/?id=…" aria-label={t('Items')} /></Field>
          <div className="row-tight gs-wrap"><Btn className="sm" icon={Save} busy={busy} onClick={save}>Save</Btn><Btn className="sm primary" icon={Download} busy={busy} disabled={!f || !f.items.trim()} onClick={update}>Download and update</Btn></div>
          {s.running && <div className="small muted">{t('New versions take effect after the next restart of the server.')}</div>}
        </div>
      </div>
      <div className="card">
        <div className="card-head"><FolderOpen size={16} /><h3>Downloaded</h3>{d.updatedAt && <span className="tiny muted">{t('last update {when}', { when: new Date(d.updatedAt).toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' }) })}</span>}</div>
        {d.dir && <div className="card-body small"><span className="muted">{t('Folder:')}</span> <code className="gs-break">{d.dir}</code></div>}
        {!d.items.length ? <TileEmpty text="No items yet." /> : d.items.map((x) => {
          const failed = (d.failed || []).find((y) => y.id === x.id);
          return (
            <div key={x.id} className="list-item">
              <Boxes size={15} className="muted" aria-hidden="true" />
              <div className="grow small"><a href={`https://steamcommunity.com/sharedfiles/filedetails/?id=${x.id}`} onClick={(e) => { e.preventDefault(); openExternal(`https://steamcommunity.com/sharedfiles/filedetails/?id=${x.id}`); }}>{x.id}</a></div>
              {failed ? <span className="badge err" title={failed.why}>{t('failed')}</span> : x.there === true ? <span className="badge ok">{t('downloaded')}</span> : x.there === false ? <span className="badge">{t('not yet')}</span> : <span className="badge">{t('in the Docker volume')}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
