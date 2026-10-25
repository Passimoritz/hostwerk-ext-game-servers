import { useEffect, useMemo, useState } from 'react';
import { Gamepad2, FolderInput, Play, Download, Archive, Plus, Trash2, Settings2, TerminalSquare, Info, Monitor, ExternalLink, Wrench, FolderOpen, Users, LayoutDashboard, Network, BookOpen, Copy, CalendarClock, FileText, SlidersHorizontal, Boxes, RotateCcw } from 'lucide-react';
import { post, del, useApi, useStore, waitJob, IS_LINUX, isElectron } from '@hostwerk/api';
import { Btn, Tabs, Seg, Empty, Loading, Callout, StatusPill, Progress, toast, confirmDialog, InfoTip } from '@hostwerk/ui';
import { serviceMenu, useNew, FavMark, FavButton, favSort, ServiceButtons, AddTile, useExtContrib, ExtTabView, askDockerAutostart, useAreaTabs } from '@hostwerk/kit';
import { FileBrowser } from '@hostwerk/files';
import { t } from '@hostwerk/i18n';
import { BASE, GameIcon, POPULAR, copy, goServer, innerJob, isInstalling, isSteam, methodLabel, stateLabel, stateOf, readable, phaseOf, isBusy, PhaseBar, PHASE_LABEL } from './common';
import { CreateDialog, QuickStart, SetupSteps } from './setup';
import { BackupsTab, CommandsTab, ConsoleTab, GuidesCard, GuidesTab, NetworkTab, OverviewTab, PlayersTab, ScheduleTab, useRun, WorkshopTab } from './tabs';
import { LgsmConfig, SettingsTab, SteamConfig } from './settings';
import { AddonTabs } from './addons';
import { ImportTab } from './importer';
import { NetworkPage, PlayersTile, MemberCard } from './network';
import './style.css';

/*
 * Game servers – two ways, one interface:
 *  - LinuxGSM (Linux native, Windows through Docker): every LinuxGSM game, its commands and its .cfg
 *  - Steam server tools through SteamCMD (natively where the tool exists, else Docker): every Steam dedicated server,
 *    ready-made start lines for popular games, a custom start line for the rest
 * Live values come from the server itself through the Steam query (A2S). The empty page sets everything up in one go:
 * pick a game → Docker (if needed) → install → start, as ONE job with numbered steps.
 */
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
  const jobs = useStore((st) => st.jobs);
  const phase = phaseOf(s, jobs); // installiert/aktualisiert/startet gerade – auch wenn der Container schon läuft
  const busy = isBusy(phase);
  const contrib = useExtContrib('game'); // tabs from other extensions
  const steam = isSteam(s);
  const groups = [
    { id: 'overview', label: t('Overview'), icon: LayoutDashboard, subs: [['overview', t('Overview'), LayoutDashboard], ['network', t('Network'), Network], ['guides', t('Guides'), BookOpen]] },
    { id: 'console', label: t('Console'), icon: TerminalSquare, subs: steam ? [['console']] : [['console', t('Console'), TerminalSquare], ['commands', t('All commands'), Wrench]] },
    { id: 'players', label: t('Players'), icon: Users, badge: s.live ? s.live.players : undefined, subs: [['players']], disabled: !s.running || busy, title: busy ? t('Only once the server runs') : s.running ? undefined : t('Only while the server runs – the player list comes live from the server') },
    { id: 'settings', label: t('Settings'), icon: Settings2, subs: [['settings', t('General'), SlidersHorizontal], ['config', steam ? t('Config files') : t('Config file'), FileText], ['schedule', t('Schedule'), CalendarClock], ...(steam ? [['workshop', t('Workshop'), Boxes]] : [])] },
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
          <h1><GameIcon s={s} className="ico" size={30} /> {s.name} <FavButton kind="game" id={s.id} /> <StatusPill state={stateOf(s, job, phase)} label={stateLabel(s, job, phase)} /></h1>
          <p>{s.gameName || s.script}{s.live && s.live.version ? ` ${s.live.version}` : ''} · {methodLabel(s)}{s.address ? ` · ${t('Port {port}', { port: s.address.port })}` : ''}{s.live ? ` · ${t('{n}/{max} players', { n: s.live.players, max: s.live.maxPlayers })}` : ''}</p>
        </div>
        <div className="actions">
          {isElectron && !s.docker && <Btn className="ghost" icon={ExternalLink} onClick={() => post('/app/open-path', { path: s.dir })}>Folder</Btn>}
          {s.installed && <ServiceButtons base={`/games/${s.id}`} state={s.running ? 'running' : 'stopped'} restart={!busy} onError={(e) => toast.error(e.message)} />}
        </div>
      </div>
      {s.installed && busy && <div className="card gs-phase-card"><div className="card-body"><PhaseBar phase={phase} /></div></div>}
      {!s.installed ? <InstallView s={s} job={job} inner={inner} reload={reload} /> : <>
        <Tabs tabs={groups.map(({ subs, ...g }) => g)} value={group.id} onChange={(g) => go((groups.find((x) => x.id === g) || groups[0]).subs[0][0])} />
        {group.subs.length > 1 && <div className="sub-tabs"><Seg value={cur} onChange={go} options={group.subs.map(([sid, label, icon]) => ({ id: sid, label, icon }))} /></div>}
        {cur === 'overview' && <OverviewTab s={s} reload={reload} phase={phase} />}
        {cur === 'network' && <NetworkTab s={s} />}
        {cur === 'guides' && <GuidesTab s={s} />}
        {cur === 'console' && <ConsoleTab s={s} phase={phase} />}
        {cur === 'commands' && <CommandsTab s={s} reload={reload} phase={phase} />}
        {cur === 'players' && <PlayersTab s={s} />}
        {cur === 'settings' && <SettingsTab s={s} reload={reload} />}
        {cur === 'config' && (steam ? <SteamConfig s={s} reload={reload} /> : <LgsmConfig s={s} />)}
        {cur === 'schedule' && <ScheduleTab s={s} />}
        {cur === 'workshop' && <WorkshopTab s={s} />}
        {cur === 'backups' && <BackupsTab s={s} reload={reload} phase={phase} />}
        {cur === 'files' && <div className="card gs-files">{s.docker && <div className="info-line"><Info size={13} /><span>{t('In Docker mode the files are in the volume of the Hostwerk Docker engine – the engine has to run.')}</span></div>}<FileBrowser root={`game:${s.id}`} /></div>}
        {contrib.tabs.filter((x) => x.key === cur).map((x) => <ExtTabView key={x.key} item={x} kind="game" id={s.id} />)}
      </>}
    </div>
  );
}

/* ---------------------------------------------------------------- every game server */

function GameCard({ s, installing, phase, reload }) {
  const live = s.live;
  const state = stateOf(s, installing, phase);
  const busy = isBusy(phase);
  return (
    <div className={`card svc-card mc-card ${s.running ? 'running' : 'stopped'}`} onClick={() => goServer(s.id)} onContextMenu={(e) => serviceMenu(e, {
      icon: { kind: 'game', id: s.id }, name: s.name, state: s.installed ? state : 'missing', base: `/games/${s.id}`, href: `${BASE}/${s.id}`, dir: s.docker ? null : s.dir,
      copy: s.address ? [[t('Copy address'), s.address.local]] : [],
      extra: s.installed && !busy ? [{ label: t('Update'), icon: Download, onClick: () => post(`/games/${s.id}/update`).catch((er) => toast.error(er.message)) }, { label: t('Backup'), icon: Archive, onClick: () => post(`/games/${s.id}/backup`).catch((er) => toast.error(er.message)) }, { label: t('Settings'), icon: Settings2, onClick: () => goServer(s.id, 'settings') }] : [],
      remove: async () => { if (await confirmDialog({ title: t('Remove “{name}”?', { name: s.name }), text: 'Stop the server and remove it from Hostwerk (files stay).', confirm: 'Remove', danger: true })) { await del(`/games/${s.id}`); reload(); } },
    })}>
      <div className="svc-top">
        <GameIcon s={s} className="mc-list-icon" size={40} />
        <FavMark kind="game" id={s.id} />
        <div className="grow gs-min">
          <div className="svc-title ellipsis">{s.name}</div>
          <div className="small muted ellipsis"><b>{s.gameName || s.script}</b>{live && live.version ? ` ${live.version}` : ''} · {methodLabel(s)}</div>
        </div>
        <StatusPill state={state} label={stateLabel(s, installing, phase)} />
      </div>
      {live && live.name && <div className="mc-motd small ellipsis">{live.name}</div>}
      <div className="svc-meta">
        <div><div className="k">{t('Address')}</div><div className="v mono small">{s.address ? s.address.local : '–'}</div></div>
        <div><div className="k">{t('Players')}</div><div className="v">{live ? `${live.players} / ${live.maxPlayers}` : '–'}</div></div>
        {live && live.map && <div><div className="k">{t('Map')}</div><div className="v ellipsis small">{live.map}</div></div>}
      </div>
      {s.installed && busy && <PhaseBar phase={phase} compact />}
      <div className="svc-actions" onClick={(e) => e.stopPropagation()}>
        {s.installed ? <ServiceButtons base={`/games/${s.id}`} state={s.running ? 'running' : 'stopped'} size="sm" restart={!busy} onError={(e) => toast.error(e.message)} />
          : installing ? <span className="small muted"><span className="spinner sm gs-spin" />{installing.text || t('installing …')}</span>
          : <Btn className="sm primary" icon={Download} onClick={() => post(`/games/${s.id}/auto-install`).then(reload).catch((er) => toast.error(er.message))}>Continue installation</Btn>}
      </div>
    </div>
  );
}

// Reiter anderer Erweiterungen (Steckplatz games.tabs, Hostwerk 3.0+ mit SDK 3.2), z. B. der Spiele-Verbund – ältere Hostwerk haben
// useAreaTabs nicht, dann bleibt es bei Servern und Import
const NO_TABS = [];
const useGameTabs = typeof useAreaTabs === 'function' ? () => useAreaTabs('games') : () => NO_TABS;

export function GamesPage({ path = [], ext }) {
  const [id, tab] = path;
  const areaTabs = useGameTabs();
  const d = useApi('/games', [], { live: false, poll: true });
  const [create, setCreate] = useState(false);
  const jobs = useStore((st) => st.jobs || {});
  useNew('game', () => setCreate(true));
  // Versteckter Reiter: nicht fragen (der Zustand kommt ohnehin über Ereignisse)
  useEffect(() => { const x = setInterval(() => { if (!document.hidden) d.reload({ silent: true }); }, 15000); return () => clearInterval(x); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const servers = (d.data && d.data.servers) || [];
  const totalPlayers = useMemo(() => servers.reduce((n, s) => n + ((s.live && s.live.players) || 0), 0), [servers]);
  if (!d.data) return d.error ? <div className="page"><Empty icon={Gamepad2} title="The game servers could not be loaded" text={d.error} action={<Btn icon={RotateCcw} onClick={() => d.reload()}>Try again</Btn>} /></div> : <Loading />;
  const { linux, docker, dockerInstalled, requirements } = d.data;
  const startDocker = async () => { try { const r = await post('/docker/start'); toast('Docker engine is starting …'); await waitJob(r.job); toast.success('Docker is running'); d.reload(); askDockerAutostart(); } catch (e) { toast.error(e.message); } };
  const importing = id === 'import';
  const xCur = areaTabs.find((x) => x.id === id) || null;
  const cur = id && !importing && !xCur && servers.find((s) => s.id === id);
  if (cur) return <Server s={cur} tab={tab || 'overview'} reload={d.reload} />;
  if (id && !importing && !xCur) return <div className="page"><Empty icon={Gamepad2} title="Server not found"><a className="btn" href={BASE}>{t('To the overview')}</a></Empty></div>;
  return (
    <div className="page fade-in">
      <div className="page-head">
        <div><h1><Gamepad2 size={22} /> Game servers</h1><p>Valheim, Palworld, Satisfactory, Rust, ARK and every other Steam server tool – through SteamCMD or LinuxGSM, with console, players, backups, updates and forwarding.</p></div>
        <div className="actions">
          {servers.some((s) => s.live) && <span className="pill info"><Users size={13} /> {t('{n} players online', { n: totalPlayers })}</span>}
          {servers.length > 0 && <Btn className="primary" icon={Plus} onClick={() => setCreate(true)}>New server</Btn>}
        </div>
      </div>
      <AddonTabs ext={ext}>
      <Tabs value={importing ? 'import' : xCur ? xCur.id : 'servers'} onChange={(v) => { location.hash = v === 'servers' ? BASE.slice(1) : `${BASE.slice(1)}/${v}`; }} tabs={[{ id: 'servers', label: t('Servers'), icon: Gamepad2, badge: servers.length }, { id: 'import', label: t('Import'), icon: FolderInput, title: t('Take over game servers that already exist on this PC') }, ...areaTabs.map(({ id: xid, label, icon }) => ({ id: xid, label, icon }))]} />
      {!linux && !docker && dockerInstalled && servers.some((s) => s.docker) && <Callout kind="warn" icon={Monitor} title="The Docker engine is not running right now" dismissible={false}>Servers in Docker containers need the engine. <Btn className="sm primary gs-ml" icon={Play} onClick={startDocker}>Start Docker</Btn></Callout>}
      {linux && requirements && (requirements.missing.length > 0 || requirements.root) && (
        <Callout kind="warn" title="Requirements" dismissible={false}>
          {requirements.root && <div className="small">{requirements.rootWarning}</div>}
          {requirements.missing.length > 0 && <div className="small">{t('Missing programs:')} <b>{requirements.missing.join(', ')}</b>{requirements.installCmd && <><br />{t('Install ({distro}):', { distro: requirements.distro })}<pre className="tiny gs-mt">{requirements.installCmd}</pre></>}</div>}
        </Callout>
      )}
      {xCur ? xCur.render() : importing ? <ImportTab onDone={d.reload} /> : servers.length === 0 ? (
        <div className="stack">
          <QuickStart onMore={() => setCreate(true)} onDone={d.reload} />
          {!IS_LINUX && <InfoTip title="Two ways on Windows" icon={Monitor}>Steam server tools run right on this PC (most games have a Windows version). Games that only exist for Linux – and every LinuxGSM game – run in Hostwerk’s own Docker engine; the setup installs it for you when needed.</InfoTip>}
        </div>
      ) : (
        <div className="grid grid-auto">
          {favSort('game', servers).map((s) => <GameCard key={s.id} s={s} installing={isInstalling(jobs, s.id)} phase={phaseOf(s, jobs)} reload={d.reload} />)}
          <AddTile onClick={() => setCreate(true)} title={t('Another game server')} text={t('Every Steam server tool and more than 100 LinuxGSM games')} chips={POPULAR.map(([label, color]) => ({ label, color: readable(color) }))} />
        </div>
      )}
      </AddonTabs>
      {create && <CreateDialog linux={linux} onClose={() => setCreate(false)} onDone={() => { setCreate(false); d.reload(); }} />}
    </div>
  );
}

export default {
  pages: { main: GamesPage },
  // 2.0: Teil „Verbund“ (bis 1.3 eigene Erweiterung „Spiele-Server-Verbund“) – Reiter, Kachel und Karte bei Minecraft
  slots: {
    'games.tabs': [{ id: 'network', title: 'Network', icon: Network, Component: NetworkPage, order: 40 }],
    'dashboard.tiles': [{ id: 'players', title: 'Network players', icon: Users, size: 'third', Component: PlayersTile }],
    'mc.connect': [{ id: 'network', title: 'Network', Component: MemberCard, order: 70 }],
  },
  // Seitenleiste: Punkt je Server (läuft/gestoppt), leere Liste = „noch keiner eingerichtet“ (Hostwerk zeigt dann einen gestrichelten Kreis)
  nav: {
    tip: (o) => {
      // Server aus Hostwerks Überblick (Dienst-Art „game“); ohne Angabe keine Punkte statt „noch keiner eingerichtet“
      const kind = o && o.kinds && o.kinds.game;
      const list = kind ? kind.items || [] : null;
      return { text: t('Game servers through SteamCMD or LinuxGSM – on this PC or in Docker containers.'), lines: list && list.map((g) => ({ name: g.name, state: isBusy(g.phase) ? 'starting' : g.running ? 'running' : 'stopped', text: isBusy(g.phase) ? (g.phase.text || t(PHASE_LABEL[g.phase.state])) : g.game || '' })) };
    },
  },
};
