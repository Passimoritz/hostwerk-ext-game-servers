import { useEffect, useState } from 'react';
import { Archive, Plus, Trash2, Settings2, Info, FolderOpen, Copy, Cpu, Save, Rocket, FileText, SlidersHorizontal, Bell, Send } from 'lucide-react';
import { get, put, del, useApi, post } from '@hostwerk/api';
import { Btn, Field, Switch, SettingRow, Empty, Loading, toast, confirmDialog, InfoTip } from '@hostwerk/ui';
import { Editor } from '@hostwerk/editor';
import { t } from '@hostwerk/i18n';
import { BASE, isSteam } from './common';

/* Game servers – settings tab of one server (general, behaviour, limits, start line, backups, removal, config files). */

/* ---------- settings ---------- */

export function SaveBtn({ busy, onClick, disabled }) { return <Btn className="sm primary" icon={Save} busy={busy} disabled={disabled} onClick={onClick}>Save</Btn>; }

export function GeneralCard({ s, reload }) {
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

export function BehaviourCard({ s, reload }) {
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

export function LimitsCard({ s, reload }) {
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

export function StartCard({ s, reload }) {
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

export function BackupSetCard({ s, reload }) {
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

export function RemoveCard({ s }) {
  const removeAll = async () => { if (await confirmDialog({ title: t('Remove “{name}”?', { name: s.name }), text: 'Stop the server and remove it from Hostwerk. The files in the folder are deleted too.', confirm: 'Remove', danger: true, typeToConfirm: s.name })) { await del(`/games/${s.id}?files=1`); toast.success('Removed'); location.hash = BASE; } };
  const removeListOnly = async () => { if (await confirmDialog({ title: 'Only remove from Hostwerk?', text: 'The folder stays.', confirm: 'Remove' })) { await del(`/games/${s.id}`); location.hash = BASE; } };
  return (
    <div className="card">
      <div className="card-head"><Trash2 size={16} /><h3>Remove</h3></div>
      <div className="card-body row"><Btn className="danger" icon={Trash2} onClick={removeAll}>Delete server</Btn><Btn className="ghost" onClick={removeListOnly}>Only from the list</Btn></div>
    </div>
  );
}

export function SettingsTab({ s, reload }) {
  const steam = isSteam(s);
  return (
    <div className="grid grid-2 gs-start">
      <div className="stack">
        <GeneralCard s={s} reload={reload} />
        {steam && <StartCard s={s} reload={reload} />}
      </div>
      <div className="stack">
        <BehaviourCard s={s} reload={reload} />
        <NotifyCard />
        <LimitsCard s={s} reload={reload} />
        {steam && <BackupSetCard s={s} reload={reload} />}
        <RemoveCard s={s} />
      </div>
    </div>
  );
}

export function LgsmConfig({ s }) {
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

export function SteamConfig({ s, reload }) {
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

/** Meldungen bei Absturz und Update – für alle Spiele-Server, über Hostwerks Kanäle und optional Discord. */
export function NotifyCard() {
  const n = useApi('/games-notify', [], { live: false });
  const [hook, setHook] = useState('');
  const [busy, setBusy] = useState(false);
  if (!n.data) return null;
  const set = async (b) => { setBusy(true); try { n.setData(await put('/games-notify', b)); if (b.discord !== undefined) { setHook(''); toast.success(b.discord ? t('Discord is connected') : t('Discord is off')); } } catch (e) { toast.error(e.message); } setBusy(false); };
  const test = async () => { try { const r = await post('/games-notify/test'); toast.success(t('Sent to: {list}', { list: r.sent.join(', ') })); } catch (e) { toast.error(e.message); } };
  return (
    <div className="card">
      <div className="card-head"><Bell size={16} /><h3>Messages</h3><InfoTip title="Messages">For every game server: a message in Hostwerk, on the phone (push, if set up) and in a Discord channel if you like.</InfoTip></div>
      <div className="card-body stack">
        <SettingRow title="After a crash" text="When the monitor restarts a server or gives up."><Switch checked={n.data.crash} onChange={(v) => set({ crash: v })} /></SettingRow>
        <SettingRow title="After an update" text="When a server runs a new game version."><Switch checked={n.data.update} onChange={(v) => set({ update: v })} /></SettingRow>
        <Field label="Discord channel (webhook)" hint="In Discord: channel settings → Integrations → Webhooks → copy the address.">
          {n.data.discord
            ? <div className="row-tight"><span className="badge ok">{t('connected')}</span><Btn className="xs ghost" busy={busy} onClick={() => set({ discord: '' })}>Disconnect</Btn></div>
            : <div className="row-tight"><input className="input grow mono" value={hook} onChange={(e) => setHook(e.target.value)} placeholder="https://discord.com/api/webhooks/…" aria-label={t('Discord channel (webhook)')} /><Btn className="sm" busy={busy} disabled={!hook.trim()} onClick={() => set({ discord: hook.trim() })}>Connect</Btn></div>}
        </Field>
        <div><Btn className="sm ghost" icon={Send} onClick={test}>Send a test message</Btn></div>
      </div>
    </div>
  );
}
