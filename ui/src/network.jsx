import { useEffect, useState } from 'react';
import { Network, Play, Square, RotateCcw, Plus, Trash2, Pencil, Users, Gamepad2, Box, Waypoints, AlertTriangle, ArrowUp, ArrowDown, LayoutDashboard, CalendarClock, SlidersHorizontal, Cable, Archive, Router, Eye, EyeOff } from 'lucide-react';
import { post, put, del, useApi, waitJob } from '@hostwerk/api';
import { Btn, Callout, Empty, Field, InfoTip, Loading, Modal, Seg, StatusPill, Switch, SettingRow, Tabs, TileEmpty, toast, confirmDialog } from '@hostwerk/ui';
import { contextMenu } from '@hostwerk/kit';
import { t, pl } from '@hostwerk/i18n';

/* Game servers, part “Network” (until 1.3 the own extension “Game server network”) – tab on the game servers page. */
import { AddonTabs } from './addons';

/*
 * Game server network: groups of game servers (and single Minecraft servers) – a cluster, several instances of one game or
 * everything for game night. Start/stop in order with a readiness check, shared schedule (restart with announcement,
 * backups), shared settings (password, slots), ports with conflicts and router forwarding for the whole group.
 * Minecraft networks with a proxy, Bedrock and versions: extension "Minecraft server network".
 */
const STATE = { running: 'running', stopped: 'stopped', partial: 'starting' };
const hrefOf = (m) => (m.kind === 'mc' ? `#/mc/${m.id}` : `#/ext/game-servers/${m.id}`);

async function job(path, body, okText) {
  try { const r = await post(path, body); const j = await waitJob(r.job); toast.success((j.result && j.result.text) || okText || t('Done')); return j.result || {}; } catch (e) { if (!e.cancelled) toast.error(e.message); return null; }
}

/** Name, members and their start order, pause between starts. */
function Editor({ init, candidates, onClose, onSaved }) {
  const [f, setF] = useState(init);
  const [busy, setBusy] = useState(false);
  const idx = (c) => f.members.findIndex((m) => m.kind === c.kind && m.id === c.id);
  const toggle = (c) => setF({ ...f, members: idx(c) >= 0 ? f.members.filter((m) => !(m.kind === c.kind && m.id === c.id)) : [...f.members, { kind: c.kind, id: c.id }] });
  const move = (i, d) => { const j = i + d; if (j < 0 || j >= f.members.length) return; const l = f.members.slice(); [l[i], l[j]] = [l[j], l[i]]; setF({ ...f, members: l }); };
  const nameOf = (m) => (candidates.find((c) => c.kind === m.kind && c.id === m.id) || { name: m.id }).name;
  const save = async () => {
    setBusy(true);
    try { if (f.id) await put(`/game-network/${f.id}`, f); else await post('/game-network', f); toast.success(t('Saved')); onSaved(); } catch (e) { toast.error(e.message); }
    setBusy(false);
  };
  return (
    <Modal title={f.id ? t('Edit network') : t('New network')} onClose={onClose} footer={<><Btn onClick={onClose}>Cancel</Btn><Btn className="primary" busy={busy} disabled={!f.name.trim() || !f.members.length} onClick={save}>Save</Btn></>}>
      <div className="stack">
        <div className="form-grid">
          <Field label={t('Name')}><input className="input" value={f.name} placeholder={t('e.g. ARK cluster')} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label={t('Extra pause between starts (seconds)')} hint={t('Hostwerk always waits until a server is ready (game servers: answer to the server query). The pause comes on top.')}><input className="input" type="number" min={0} max={120} value={f.delay} onChange={(e) => setF({ ...f, delay: e.target.value })} /></Field>
        </div>
        <div className="label">{t('Servers')}</div>
        {candidates.length === 0 ? <div className="small muted">No servers yet – create a game or Minecraft server first.</div> : (
          <div className="gn-pick">
            {candidates.map((c) => (
              <label key={`${c.kind}:${c.id}`} className={`gn-pick-item ${idx(c) >= 0 ? 'gn-picked' : ''}`}>
                <input type="checkbox" checked={idx(c) >= 0} onChange={() => toggle(c)} />
                {c.kind === 'mc' ? <Box size={15} aria-hidden="true" /> : <Gamepad2 size={15} aria-hidden="true" />}
                <span className="grow ellipsis"><b>{c.name}</b> <span className="tiny muted">{c.game}{c.proxy ? ` · ${t('proxy')}` : ''}</span></span>
              </label>
            ))}
          </div>
        )}
        {f.members.length > 1 && (
          <>
            <div className="label">{t('Start order')} <InfoTip title={t('Start order')}>Top to bottom when starting, the other way round when stopping. A proxy always starts last. For clusters: the main server first.</InfoTip></div>
            <ol className="gn-order">
              {f.members.map((m, i) => (
                <li key={`${m.kind}:${m.id}`}>
                  <span className="grow ellipsis small">{nameOf(m)}</span>
                  <button type="button" className="btn ghost xs icon" disabled={i === 0} title={t('Move up')} aria-label={t('Move {name} up', { name: nameOf(m) })} onClick={() => move(i, -1)}><ArrowUp /></button>
                  <button type="button" className="btn ghost xs icon" disabled={i === f.members.length - 1} title={t('Move down')} aria-label={t('Move {name} down', { name: nameOf(m) })} onClick={() => move(i, 1)}><ArrowDown /></button>
                </li>
              ))}
            </ol>
          </>
        )}
      </div>
    </Modal>
  );
}

function Overview({ g, reload, onEdit }) {
  const live = useApi(`/game-network/${g.id}/live`, [g.id, g.running], { live: false, poll: true });
  const [busy, setBusy] = useState(null);
  const players = (m) => { const x = live.data && live.data.members.find((y) => y.kind === m.kind && y.id === m.id); return x ? x : null; };
  const act = async (action, force = false) => {
    setBusy(action);
    let again = false;
    try { const r = await post(`/game-network/${g.id}/${action}`, force ? { force: true } : undefined); const j = await waitJob(r.job); toast.success((j.result && j.result.text) || t('Done')); } catch (e) {
      if (!force && e.message && /proxy/i.test(e.message) && action !== 'stop') again = await confirmDialog({ title: t('Start the proxy anyway?'), text: e.message, confirm: t('Start anyway') });
      else if (!e.cancelled) toast.error(e.message);
    }
    setBusy(null); reload();
    if (again) act(action, true);
  };
  const backup = async () => { setBusy('backup'); await job(`/game-network/${g.id}/backup`); setBusy(null); };
  const total = live.data ? live.data.players : g.players;
  return (
    <div className="stack">
      <div className="card">
        <div className="card-head"><Waypoints size={16} aria-hidden="true" /><h3 className="ellipsis">{g.name}</h3>
          <StatusPill state={STATE[g.state]} label={g.state === 'partial' ? t('{n} of {total} running', { n: g.running, total: g.total }) : undefined} />
          <span className="small muted"><Users size={12} aria-hidden="true" /> {pl(total, '{n} player', '{n} players')}</span>
          <div className="right row-tight"><button type="button" className="btn ghost xs icon" title={t('Edit')} aria-label={t('Edit')} onClick={onEdit}><Pencil /></button></div>
        </div>
        <div className="card-body row-tight gn-wrap">
          <Btn className="sm primary" icon={Play} busy={busy === 'start'} disabled={!!busy || g.state === 'running'} onClick={() => act('start')}>Start all</Btn>
          <Btn className="sm" icon={Square} busy={busy === 'stop'} disabled={!!busy || g.state === 'stopped'} onClick={() => act('stop')}>Stop all</Btn>
          <Btn className="sm ghost" icon={RotateCcw} busy={busy === 'restart'} disabled={!!busy} onClick={() => act('restart')}>Restart</Btn>
          <Btn className="sm ghost" icon={Archive} busy={busy === 'backup'} disabled={!!busy} onClick={backup}>Back up all</Btn>
        </div>
      </div>
      <div className="card">
        <div className="card-head"><h3>Servers</h3><span className="small muted">{t('in start order')}</span></div>
        <ol className="gn-members card-body">
          {g.members.map((m) => {
            const p = players(m);
            return (
              <li key={`${m.kind}:${m.id}`} className={m.running ? 'gn-on' : ''}>
                <span className="gn-dot" aria-hidden="true" />
                {m.kind === 'mc' ? <Box size={14} aria-hidden="true" /> : <Gamepad2 size={14} aria-hidden="true" />}
                {m.missing ? <span className="muted grow">{t('{name} (removed)', { name: m.name })}</span> : <a className="grow ellipsis" href={hrefOf(m)}>{m.name}</a>}
                {m.proxy && <span className="badge">{t('proxy')}</span>}
                {p && m.running && <span className="small muted">{p.max ? t('{n} of {max}', { n: p.players, max: p.max }) : pl(p.players, '{n} player', '{n} players')}</span>}
                <span className="gn-sr">{m.running ? t('running') : t('stopped')}</span>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}

function Schedule({ g, reload }) {
  const [f, setF] = useState({ restart: { ...g.restart }, backup: { ...g.backup } });
  const [busy, setBusy] = useState(false);
  useEffect(() => { setF({ restart: { ...g.restart }, backup: { ...g.backup } }); }, [g.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async () => { setBusy(true); try { await put(`/game-network/${g.id}`, f); toast.success(t('Saved')); reload(); } catch (e) { toast.error(e.message); } setBusy(false); };
  const r = f.restart; const b = f.backup;
  return (
    <div className="card">
      <div className="card-head"><CalendarClock size={16} aria-hidden="true" /><h3>Schedule</h3></div>
      <div className="card-body stack">
        <SettingRow title={t('Restart every day')} text={t('In the right order. Players get a message in the chat beforehand.')}><Switch checked={!!r.enabled} onChange={(v) => setF({ ...f, restart: { ...r, enabled: v } })} /></SettingRow>
        {r.enabled && <div className="form-grid">
          <Field label={t('At')}><input className="input sm" type="time" value={r.at} onChange={(e) => setF({ ...f, restart: { ...r, at: e.target.value } })} /></Field>
          <Field label={t('Announce minutes before')}><input className="input sm" type="number" min={0} max={30} value={r.warn} onChange={(e) => setF({ ...f, restart: { ...r, warn: e.target.value } })} /></Field>
        </div>}
        <SettingRow title={t('Back up every day')} text={t('Every server of the network with its own backup (game servers: their backup command, Minecraft: Hostwerk’s backup).')}><Switch checked={!!b.enabled} onChange={(v) => setF({ ...f, backup: { ...b, enabled: v } })} /></SettingRow>
        {b.enabled && <Field label={t('At')}><input className="input sm gn-time" type="time" value={b.at} onChange={(e) => setF({ ...f, backup: { ...b, at: e.target.value } })} /></Field>}
        <div className="row-tight"><Btn className="sm primary" busy={busy} onClick={save}>Save</Btn></div>
      </div>
    </div>
  );
}

function Shared({ g }) {
  const [pw, setPw] = useState('');
  const [show, setShow] = useState(false);
  const [slots, setSlots] = useState(g.shared.maxPlayers || '');
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  const apply = async () => {
    setBusy(true);
    const body = { ...(pw !== '' ? { password: pw } : {}), ...(slots !== '' ? { maxPlayers: Number(slots) } : {}) };
    const r = await job(`/game-network/${g.id}/shared`, body);
    setBusy(false);
    if (r) { setRes(r.results || []); setPw(''); }
  };
  return (
    <div className="card">
      <div className="card-head"><SlidersHorizontal size={16} aria-hidden="true" /><h3>Shared settings</h3><InfoTip title={t('Shared settings')}>Sets the same values on every game server of the network – Steam servers in Hostwerk’s settings, LinuxGSM servers in their config. Applies at each server’s next start. Mods and admin lists differ too much between games – set those per server.</InfoTip></div>
      <div className="card-body stack">
        <div className="form-grid">
          <Field label={t('Server password')} hint={g.shared.password ? t('A password is set – type a new one to change it, leave empty to keep it.') : t('Leave empty for no change.')}>
            <div className="row-tight">
              <input className="input sm grow" type={show ? 'text' : 'password'} autoComplete="new-password" maxLength={40} value={pw} onChange={(e) => setPw(e.target.value)} />
              <button type="button" className="btn ghost xs icon" title={show ? t('Hide') : t('Show')} aria-label={show ? t('Hide password') : t('Show password')} onClick={() => setShow(!show)}>{show ? <EyeOff /> : <Eye />}</button>
            </div>
          </Field>
          <Field label={t('Player slots')}><input className="input sm" type="number" min={1} max={1000} value={slots} onChange={(e) => setSlots(e.target.value)} /></Field>
        </div>
        <div className="row-tight"><Btn className="sm primary" busy={busy} disabled={pw === '' && slots === ''} onClick={apply}>Apply to all servers</Btn></div>
        {res && <ul className="gn-results">{res.map((x) => <li key={x.name} className={x.ok ? 'gn-ok-line' : 'gn-err-line'}>{x.ok ? '✓' : '✗'} {x.name}{x.why ? ` – ${x.why}` : ''}{x.note ? ` – ${x.note}` : ''}</li>)}</ul>}
      </div>
    </div>
  );
}

function Ports({ g }) {
  const d = useApi(`/game-network/${g.id}/ports`, [g.id, g.members.length], { live: false, poll: false });
  const [busy, setBusy] = useState(null);
  if (!d.data) return d.error ? <TileEmpty icon={AlertTriangle} text={d.error} action={t('Try again')} onClick={() => d.reload()} /> : <Loading />;
  const p = d.data;
  const forward = async (on) => {
    setBusy(on ? 'on' : 'off');
    try { const r = await post(`/game-network/${g.id}/forward`, { on }); d.setData(r); const bad = r.results.filter((x) => !x.ok); if (bad.length) toast.error(bad.map((x) => `${x.port}/${x.proto}: ${x.why}`).join(' · ')); else toast.success(on ? t('All ports forwarded') : t('Forwardings removed')); } catch (e) { toast.error(e.message); }
    setBusy(null);
  };
  return (
    <div className="card">
      <div className="card-head"><Cable size={16} aria-hidden="true" /><h3>Ports</h3>
        {p.conflicts > 0 && <span className="badge warn">{pl(p.conflicts, '{n} conflict', '{n} conflicts')}</span>}
        <div className="right row-tight">
          {p.router.available ? (<>
            <Btn className="xs" icon={Router} busy={busy === 'on'} disabled={!!busy} onClick={() => forward(true)}>Forward all in the router</Btn>
            <Btn className="xs ghost" busy={busy === 'off'} disabled={!!busy} onClick={() => forward(false)}>Remove forwardings</Btn>
          </>) : <span className="tiny muted">{t('Router forwarding needs the extension “Router & port forwarding”.')}</span>}
        </div>
      </div>
      {p.ports.length === 0 ? <TileEmpty icon={Cable} text={t('No ports known yet – start the servers once.')} /> : (
        <div className="card-body">
          <table className="table gn-table">
            <thead><tr><th scope="col">{t('Server')}</th><th scope="col">{t('Port')}</th><th scope="col">{t('Use')}</th><th scope="col">{t('State')}</th></tr></thead>
            <tbody>
              {p.ports.map((x) => (
                <tr key={`${x.id}:${x.port}/${x.proto}`}>
                  <td>{x.member}</td>
                  <td className="mono">{x.port}/{x.proto}</td>
                  <td className="small muted">{x.name}</td>
                  <td className="small">{x.conflict.length ? <span className="gn-err-line">{t('also used by {list}', { list: x.conflict.join(', ') })}</span> : x.forwarded ? t('forwarded') : '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const blank = () => ({ name: '', members: [], delay: 5 });
const TABS = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'schedule', label: 'Schedule', icon: CalendarClock },
  { id: 'shared', label: 'Shared settings', icon: SlidersHorizontal },
  { id: 'ports', label: 'Ports', icon: Cable },
];

export function NetworkPage({ ext }) {
  const d = useApi('/game-network', [], { live: false, poll: true });
  const [edit, setEdit] = useState(null);
  const [cur, setCur] = useState(null);
  const [tab, setTab] = useState('overview');
  if (!d.data) return <div className="page">{d.error ? <Empty icon={AlertTriangle} title="The networks could not be loaded" text={d.error} action={<Btn icon={RotateCcw} onClick={() => d.reload()}>Try again</Btn>} /> : <Loading />}</div>;
  const { groups, candidates } = d.data;
  const g = groups.find((x) => x.id === cur) || groups[0] || null;
  const reload = () => d.reload({ silent: true });
  const remove = async () => { if (g && await confirmDialog({ title: t('Remove network “{name}”?', { name: g.name }), text: t('Only the group is removed – the servers stay as they are.'), confirm: t('Remove'), danger: true })) { await del(`/game-network/${g.id}`); setCur(null); reload(); } };
  const editOf = (x) => ({ id: x.id, name: x.name, delay: x.delay, members: x.members.map((m) => ({ kind: m.kind, id: m.id })) });
  const menu = (e) => g && contextMenu(e, [
    { label: t('Edit'), icon: Pencil, onClick: () => setEdit(editOf(g)) },
    { label: t('Remove'), icon: Trash2, danger: true, onClick: remove },
  ]);
  const mcProxy = candidates.some((c) => c.proxy);
  return (
    <div className="page fade-in">
      <div className="page-head">
        <div><h1><Network size={22} /> Game server network</h1><p>Game servers that belong together – start them in order, one schedule, the same settings, ports at a glance.</p></div>
        <div className="actions">
          <InfoTip title={t('What belongs in a network?')}>A cluster (ARK, Conan Exiles), several instances of one game, or everything for game night. Starting waits until each server answers the server query before the next one starts.</InfoTip>
          <Btn className="grad" icon={Plus} onClick={() => setEdit(blank())}>New network</Btn>
        </div>
      </div>
      <AddonTabs ext={ext}>
        {mcProxy && <Callout kind="info" title={t('Minecraft networks')}>{t('A Velocity or BungeeCord network with lobby, Bedrock players and version bridges is set up in “Minecraft server network”. Here a Minecraft server is simply one of the servers.')} {g && g.mcNetwork ? <a className="btn sm" href="#/ext/mc-network">{t('Open')}</a> : <a className="btn sm" href="#/ext">{t('Find in Extensions')}</a>}</Callout>}
        {!g ? (
          <div className="card"><Empty icon={Waypoints} title="No network yet" text="Put servers that belong together into one network – an ARK cluster, several Valheim worlds or everything for game night."><Btn className="grad" icon={Plus} onClick={() => setEdit(blank())}>Create network</Btn></Empty></div>
        ) : (
          <div onContextMenu={menu}>
            {groups.length > 1 && <div className="gn-pickbar"><Seg value={g.id} onChange={(id) => { setCur(id); }} options={groups.map((x) => ({ id: x.id, label: x.name }))} /></div>}
            <Tabs value={tab} onChange={setTab} tabs={TABS.map((x) => ({ ...x, label: t(x.label) }))} />
            <div className="gn-tab">
              {tab === 'overview' && <Overview g={g} reload={reload} onEdit={() => setEdit(editOf(g))} />}
              {tab === 'schedule' && <Schedule key={g.id} g={g} reload={reload} />}
              {tab === 'shared' && <Shared key={g.id} g={g} />}
              {tab === 'ports' && <Ports g={g} />}
            </div>
          </div>
        )}
      </AddonTabs>
      {edit && <Editor init={edit} candidates={candidates} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); }} />}
    </div>
  );
}

/** Tile for the overview: players in every network. */
function PlayersTile() {
  const d = useApi('/game-network/totals', [], { live: false, poll: true });
  if (!d.data && d.error) return <TileEmpty icon={AlertTriangle} text={t('Could not load: {error}', { error: d.error })} action="Try again" onClick={() => d.reload()} />;
  if (!d.data) return <div className="card-body"><div className="hw-skeleton gn-skel" /></div>;
  const x = d.data;
  if (!x.networks) return <TileEmpty icon={Waypoints} text="No network yet" href="#/ext/game-network" />;
  return (
    <a className="card-body stack gn-tile" href="#/ext/game-network">
      <div className="row-tight"><Users size={16} aria-hidden="true" /><b className="gn-big">{x.players.toLocaleString(document.documentElement.lang === 'en' ? 'en-US' : 'de-DE')}</b><span className="small muted">{t('players online')}</span></div>
      <div className="small muted">{t('{running} of {servers} servers running in {networks} networks', x)}</div>
    </a>
  );
}

/** On a Minecraft server's page: which network it belongs to – with its state. */
function MemberCard({ s }) {
  const d = useApi(s ? `/game-network/member/mc/${encodeURIComponent(s.id)}` : null, [s && s.id], { live: false, poll: true });
  const groups = d.data || [];
  if (!groups.length) return null;
  return (
    <div className="stack gn-gap">
      {groups.map((x) => (
        <div key={x.id} className="row-tight gn-wrap">
          <Waypoints size={15} aria-hidden="true" /><span className="small">{t('Part of the network')} <a href="#/ext/game-network"><b>{x.name}</b></a></span>
          <StatusPill state={STATE[x.state]} label={x.state === 'partial' ? t('{n} of {total} running', { n: x.running, total: x.total }) : undefined} />
          {x.players > 0 && <span className="tiny muted">{t('{n} players', { n: x.players })}</span>}
        </div>
      ))}
    </div>
  );
}

export { PlayersTile, MemberCard };
