import { useEffect, useState } from 'react';
import { Search, RefreshCw, FolderSearch, FolderInput, Copy, CheckCircle2, Container, AlertTriangle, ExternalLink } from 'lucide-react';
import { get, post, pickFolder, fmtBytes, fmtDate } from '@hostwerk/api';
import { Btn, Seg, Field, Loading, Empty, Modal, toast, InfoTip } from '@hostwerk/ui';
import { t } from '@hostwerk/i18n';
import { GameArt, goServer } from './common';
import { RamHint } from './setup';

/*
 * Game servers – Import tab: game servers that already exist on this PC (Steam libraries, SteamCMD folders, LinuxGSM,
 * Docker containers, a folder of your choice). Searching only reads; nothing changes before "Take over" is confirmed.
 */

const SOURCE = { 'steam-library': 'Steam library', steamcmd: 'SteamCMD', lgsm: 'LinuxGSM', docker: 'Docker', folder: 'Chosen folder' };
const UPDATES = {
  steamcmd: 'Updates through SteamCMD, as before.',
  client: 'Lies in your Steam library – Steam keeps updating it in place; a copy is updated by Hostwerk.',
  manual: 'Automatic updates are off – switch them on under Settings (SteamCMD then checks every file once).',
  login: 'Needs a Steam account that owns the game – Hostwerk does not update it.',
};
const REASON = {
  linux: 'LinuxGSM servers can only be taken over on Linux.',
  'windows-only': 'This server tool only exists for Windows.',
  system: 'This server tool does not run on this system.',
  'docker-other': 'Not a LinuxGSM container – manage it on the Docker page.',
  'no-volume': 'Keeps its data inside the container (no volume) – Hostwerk could not create it anew without losing them.',
};

/** What was found about a server, as short facts (port, players, start script, size). */
function Facts({ it }) {
  const v = it.values || {};
  const facts = [
    v.port && t('Port {port}', { port: v.port }),
    it.ports && it.ports.length > 0 && it.ports.map((p) => `${p.port}/${p.proto}`).join(', '),
    v.maxPlayers && t('{n} players', { n: v.maxPlayers }),
    it.start && it.start.script && t('Start: {file}', { file: it.start.script }),
    it.size && fmtBytes(it.size),
    it.kind === 'docker' && (it.running ? t('running') : t('stopped')),
  ].filter(Boolean);
  return facts.length ? <div className="gs-facts small muted">{facts.map((f) => <span key={f}>{f}</span>)}</div> : null;
}

function FoundCard({ it, onTake }) {
  const ok = it.canInPlace || it.canCopy;
  return (
    <div className="card gs-found">
      <GameArt appid={it.kind === 'steam' ? it.appid : null} game={it.kind === 'steam' ? it.game : null} short={it.short} name={it.name} shape="wide" className="gs-found-art" />
      <div className="card-body stack gs-tight">
        <div className="row-tight gs-wrap"><b className="gs-found-name">{it.name}</b><span className="badge">{t(SOURCE[it.source] || it.source)}</span></div>
        <div className="tiny mono muted gs-break" title={it.dir || it.container}>{it.dir || t('Container {name} ({image})', { name: it.container, image: it.image })}</div>
        <Facts it={it} />
        <RamHint ram={it.ram} />
        {ok ? (
          <div className="row-tight gs-wrap">
            {it.canInPlace && <Btn className="primary" icon={FolderInput} onClick={() => onTake(it, 'inplace')}>Take over</Btn>}
            {it.canCopy && <Btn icon={Copy} onClick={() => onTake(it, 'copy')}>Copy into Hostwerk</Btn>}
          </div>
        ) : (
          <div className="row-tight gs-wrap">
            <span className="small muted"><AlertTriangle size={13} aria-hidden="true" /> {t(REASON[it.reason] || REASON.system)}</span>
            {it.reason === 'docker-other' && <a className="btn ghost" href="#/apps/docker"><ExternalLink size={14} /> {t('Docker page')}</a>}
          </div>
        )}
      </div>
    </div>
  );
}

/** Confirm a take-over: name, in place or copy, what happens. */
function TakeDialog({ it, mode: startMode, onClose, onDone }) {
  const [mode, setMode] = useState(startMode);
  const [name, setName] = useState((it.values && it.values.name) || it.name);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      const r = await post('/games/import', { key: it.key, mode, name });
      toast.success(mode === 'copy' ? t('“{name}” is being copied – progress on its page.', { name }) : t('“{name}” is now managed by Hostwerk.', { name }));
      onDone(); goServer(r.id);
    } catch (e) { toast.error(e.message); }
    setBusy(false);
  };
  const modes = [it.canInPlace && { id: 'inplace', label: it.kind === 'docker' ? t('Keep the container') : t('Where it is'), icon: FolderInput }, it.canCopy && { id: 'copy', label: t('As a copy in Hostwerk'), icon: Copy }].filter(Boolean);
  return (
    <Modal title={t('Take over {game}', { game: it.name })} subtitle={it.dir || it.container} onClose={onClose} size="wide" footer={<><Btn onClick={onClose}>Cancel</Btn><Btn className="primary" icon={CheckCircle2} busy={busy} onClick={go}>Take over</Btn></>}>
      <div className="stack">
        <Field label="Name in Hostwerk"><input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
        {modes.length > 1 && <Field label="How"><Seg value={mode} onChange={setMode} options={modes} /></Field>}
        <ul className="gs-points small">
          {mode === 'copy' ? <li>{t('Hostwerk copies the whole folder into its own folder and manages the copy. The original stays untouched – delete it yourself once the copy runs.')}</li>
            : it.kind === 'docker' ? <li>{t('The container and its volume stay. Hostwerk starts and stops it from now on, shows console and players, and creates it anew only when you change ports or limits (the data stays in the volume).')}</li>
              : <li>{t('Nothing is moved or copied – Hostwerk manages the folder where it is. Removing it from Hostwerk later never deletes this folder.')}</li>}
          {it.kind === 'steam' && it.start && it.start.line && <li>{t('Starts exactly like {file} did (same program and parameters).', { file: it.start.script })}</li>}
          {it.kind === 'steam' && !(it.start && it.start.line) && it.profile && <li>{t('Starts with Hostwerk’s ready-made start for this game – check port and world under Settings → Start.')}</li>}
          {it.kind === 'steam' && !it.profile && !(it.start && it.start.line) && <li>{t('Choose the start program under Settings → Start after taking it over.')}</li>}
          {it.kind === 'steam' && <li>{t(UPDATES[mode === 'copy' && it.updates !== 'login' ? 'steamcmd' : it.updates] || UPDATES.manual)}</li>}
          <li>{t('Stop the server where it runs now before starting it in Hostwerk – two copies on the same port do not work.')}</li>
        </ul>
      </div>
    </Modal>
  );
}

export function ImportTab({ onDone }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState('');
  const [take, setTake] = useState(null);
  const scan = async (folder = null) => {
    setBusy(folder ? 'folder' : 'scan');
    try { setData(folder ? await post('/games/import/scan', { folder }) : await get('/games/import/scan')); } catch (e) { toast.error(e.message); if (!data) setData({ items: [], places: [] }); }
    setBusy('');
  };
  useEffect(() => { scan(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const chooseFolder = async () => { const f = await pickFolder(t('Folder with game servers')); if (f) scan(f); };
  return (
    <div className="stack">
      <div className="card">
        <div className="card-head">
          <Search size={16} /><h3>Game servers on this PC</h3>
          <InfoTip title="Import – take over game servers you already have">
            {t('Hostwerk looks in your Steam libraries, in SteamCMD folders, for LinuxGSM instances (Linux) and for Docker containers of game server images – and in a folder you choose. Searching only reads; nothing changes before you confirm.')}{' '}
            {t('Take over where it is (nothing moves) or copy it into Hostwerk – port, players and the start line come along where Hostwerk finds them.')}
          </InfoTip>
          <div className="right row-tight">
            <Btn icon={FolderSearch} busy={busy === 'folder'} onClick={chooseFolder}>Search a folder …</Btn>
            <Btn icon={RefreshCw} busy={busy === 'scan'} onClick={() => scan()}>Search again</Btn>
          </div>
        </div>
        {data && <div className="card-body small muted">{data.folder ? t('Searched: usual places and {folder}', { folder: data.folder }) : t('Searched the usual places')}{data.scannedAt ? ` · ${fmtDate(data.scannedAt)}` : ''}{data.docker === false ? ` · ${t('Docker is not running – containers were not checked.')}` : ''}</div>}
      </div>
      {!data ? <Loading text={t('Looking for game servers …')} /> : data.items.length === 0 ? (
        <div className="card"><Empty icon={CheckCircle2} title="No game servers found" text={t('Nothing outside Hostwerk in the usual places. Your server lies somewhere else? Search its folder.')} action={<Btn icon={FolderSearch} onClick={chooseFolder}>Search a folder …</Btn>} /></div>
      ) : (
        <div className="gs-found-grid">
          {data.items.map((it) => <FoundCard key={it.key} it={it} onTake={(x, mode) => setTake({ it: x, mode })} />)}
        </div>
      )}
      {take && <TakeDialog it={take.it} mode={take.mode} onClose={() => setTake(null)} onDone={() => { setTake(null); onDone(); }} />}
      {data && data.items.some((x) => x.kind === 'docker') && <div className="small muted row-tight"><Container size={13} aria-hidden="true" /> {t('Containers that do not come from LinuxGSM stay on the Docker page.')}</div>}
    </div>
  );
}
