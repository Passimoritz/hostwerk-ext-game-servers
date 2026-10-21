'use strict';
/*
 * More game servers through LinuxGSM (Linux Game Server Managers, linuxgsm.com):
 *  - native on Linux (Hostwerk service, VPS, Linux PC): one folder per server under <base>/spiele/<id> with the LinuxGSM
 *    script of the game (e.g. ./vhserver). Every LinuxGSM command is available (start, stop, restart, monitor, update,
 *    check-update, force-update, validate, backup, details, postdetails, update-lgsm, mods-install …); console through the
 *    log file (log/console), settings through lgsm/config-lgsm/<game>/<game>.cfg.
 *  - Docker everywhere else: the official LinuxGSM image, one container per server, data in a volume.
 * The game list comes from LinuxGSM's serverlist.csv (refreshed daily, with a bundled fallback).
 * Data stays where it always was: settings.games and <base>/spiele.
 *
 * Second method (1.3): Steam server tools through SteamCMD (server/steam.js) – kind "steam" in the same list, same
 * commands (start, stop, restart, update, validate, backup), same tabs. One-step setup: game → Docker (if needed) →
 * install → start as one job (setup()).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { SteamServers, planFor, safeRel, hostPlatform } = require('./steam');
const { SteamAppList } = require('./steamlist');
const SG = require('./steamgames');
const IM = require('./importer');
const GI = require('./gameinfo');
const { GameArt, gameNameOf } = require('./gameart');
const PH = require('./phase');
const { parseShellVars } = IM;

// Hostwerk's building blocks – bound in the constructor (see server/index.js)
let H = null;
const T = (s, v) => (H ? H.t(s, v) : s);
const core = (n) => H.core(n);

function lanIps() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) for (const n of list || []) if (n.family === 'IPv4' && !n.internal) out.push(n.address);
  return out;
}
/*
 * Guides per game – built only from the game name and the LinuxGSM script (search pages and the LinuxGSM page of the game,
 * which exists for every supported game). So there is no link list that can go stale.
 */
function guideLinks(game, name) {
  const q = encodeURIComponent(name || game);
  return [
    { id: 'lgsm', label: 'LinuxGSM page of the game', text: 'Installation, ports, commands and special notes', url: `https://linuxgsm.com/servers/${game}/` },
    { id: 'lgsm-docs', label: 'LinuxGSM documentation', text: 'Commands, configuration, alerts, backups', url: 'https://docs.linuxgsm.com/' },
    { id: 'steam', label: 'Steam', text: 'The game in the Steam store', url: `https://store.steampowered.com/search/?term=${q}` },
    { id: 'wiki', label: 'PCGamingWiki', text: 'Technical info, ports and server notes', url: `https://www.pcgamingwiki.com/w/index.php?search=${q}` },
    { id: 'guide', label: 'Guide: dedicated server', text: 'Web search for guides for this game', url: `https://duckduckgo.com/?q=${encodeURIComponent(`${name || game} dedicated server guide`)}` },
  ];
}

const IS_LINUX = process.platform === 'linux';
const LIST_URL = 'https://raw.githubusercontent.com/GameServerManagers/LinuxGSM/master/lgsm/data/serverlist.csv';
const SCRIPT_URL = 'https://linuxgsm.sh';
// Labels in English – the interface translates them (locales/de.json)
const COMMANDS = {
  start: 'Start', stop: 'Stop', kill: 'End now (force)', restart: 'Restart', monitor: 'Monitor (restarts after a crash)', 'test-alert': 'Test alert', details: 'Details', postdetails: 'Upload details',
  update: 'Update (SteamCMD)', 'check-update': 'Check for updates', 'force-update': 'Force update', validate: 'Check files (validate)', backup: 'Create backup',
  'update-lgsm': 'Update LinuxGSM', 'mods-install': 'Install mods', 'mods-remove': 'Remove mods', 'mods-update': 'Update mods', 'send-alert': 'Send alert', 'dev-debug': 'Developer debug', skeleton: 'Create folder skeleton', donate: 'Donation info', sponsor: 'Sponsor info',
};
// Well-known favourites with a short name (the list itself comes from LinuxGSM)
const FAVORITES = { vhserver: 'Valheim', tsserver: 'Terraria (tShock)', pwserver: 'Palworld', sfserver: 'Satisfactory', csgoserver: 'Counter-Strike 2', rustserver: 'Rust', arkserver: 'ARK: Survival Evolved', ets2server: 'Euro Truck Simulator 2', pzserver: 'Project Zomboid', sdtdserver: '7 Days to Die', tf2server: 'Team Fortress 2', gmodserver: "Garry's Mod", mcserver: "Minecraft (better: Hostwerk's own Minecraft management)", fctrserver: 'Factorio', stserver: 'Stationeers', eco: 'Eco', cmwserver: 'Chivalry', squadserver: 'Squad', unturnedserver: 'Unturned', ns2server: 'Natural Selection 2' };

/** "Docker missing" error with a code: the interface then asks "Install Docker too?" (accept/cancel) and tries again. */
function dockerMissing(name) { return Object.assign(new Error(name ? T('“{name}” needs Docker – it is not set up on this PC yet.', { name }) : T('This needs Docker – it is not set up on this PC yet.')), { status: 428, code: 'DOCKER_MISSING' }); }

/*
 * Popular games for the one-step setup: each one is offered with the method that works best on this system –
 * Windows: the Steam server tool natively when it exists for Windows (no Docker needed), else LinuxGSM in Docker;
 * Linux: LinuxGSM natively (tried and tested), else the Steam server tool.
 */
const PICKS = [
  ['Valheim', 896660, 'vhserver'], ['Palworld', 2394010, 'pwserver'], ['Satisfactory', 1690800, 'sfserver'], ['Rust', 258550, 'rustserver'],
  ['7 Days to Die', 294420, 'sdtdserver'], ['Project Zomboid', 380870, 'pzserver'], ['Counter-Strike 2', 730, 'cs2server'], ['Enshrouded', 2278520, null],
  ['V Rising', 1829350, null], ['ARK: Survival Ascended', 2430930, null], ['Terraria (tShock)', null, 'tsserver'], ["Garry's Mod", 4020, 'gmodserver'],
  ['Conan Exiles', 443030, null], ['Unturned', 1110390, 'unturnedserver'], ['Space Engineers', 298740, null], ['Team Fortress 2', 232250, 'tf2server'],
];
function pickFor([name, appid, script], platform) {
  const p = appid ? SG.profileFor(appid) : null;
  const steamPlan = p ? planFor({ appid, win: !!p.win, linux: !!p.linux }, platform) : { ok: false };
  const lgsm = script ? { method: 'lgsm', game: script, needsDocker: platform !== 'linux' } : null;
  const steam = steamPlan.ok ? { method: 'steam', appid, needsDocker: !!steamPlan.needsDocker } : null;
  const best = platform === 'linux' ? lgsm || steam : (steam && !steam.needsDocker ? steam : lgsm || steam);
  if (!best) return null;
  return { key: best.method === 'steam' ? `steam-${appid}` : script, name, ...best, short: script ? script.replace(/server$/, '') : null, gameAppId: p ? p.game : null };
}

/* LinuxGSM settings that most games share – shown as a small form (the raw .cfg stays available). */
const LGSM_KEYS = ['servername', 'port', 'queryport', 'maxplayers', 'serverpassword', 'startparameters'];
/** Set values in a LinuxGSM .cfg – values that bash could interpret ($, `, ", \, line breaks) are refused. */
function setShellVars(content, updates) {
  let text = String(content || '');
  for (const [k, raw] of Object.entries(updates || {})) {
    if (!/^[a-z][a-z0-9_]{0,40}$/.test(k)) throw Object.assign(new Error(T('Invalid setting')), { status: 400 });
    const v = String(raw == null ? '' : raw);
    if (/["$`\\\r\n]/.test(v) || v.length > 500) throw Object.assign(new Error(T('“{key}” contains characters that are not allowed (", $, `, \\ or line breaks).', { key: k })), { status: 400 });
    const line = `${k}="${v}"`;
    const re = new RegExp(`^\\s*${k}=.*$`, 'm');
    text = re.test(text) ? text.replace(re, line) : `${text}${text && !text.endsWith('\n') ? '\n' : ''}${line}\n`;
  }
  return text;
}
/** Resource limits for Docker containers – cleaned (0 = no limit). */
function cleanLimits(b) {
  const cpus = Number(b && b.cpus) || 0;
  const mem = Math.round(Number(b && b.memoryMb) || 0);
  if (cpus && (cpus < 0.1 || cpus > 256)) throw Object.assign(new Error(T('CPU cores: between 0.1 and 256 (0 = no limit).')), { status: 400 });
  if (mem && (mem < 256 || mem > 1048576)) throw Object.assign(new Error(T('Memory: between 256 MB and 1 TB (0 = no limit).')), { status: 400 });
  return cpus || mem ? { cpus: cpus ? Math.round(cpus * 100) / 100 : 0, memoryMb: mem } : null;
}

class GameServers {
  constructor(host) {
    H = host;
    this.ctx = host.ctx;
    core('jobs').registerResumer('game-setup', (p) => { const s = this.get(p.id); return this.isSteam(s) ? this.steamSetupJob(s) : this.isDocker(s) ? this.setupDockerJob(s) : this.setupNativeJob(s); }); // continue after a crash
    this.root = path.join(this.ctx.paths.base, 'spiele');
    this.steam = new SteamServers(this, host);
    this.apps = new SteamAppList({ dataDir: this.dataDir });
    // Game pictures: found once per game, kept in Hostwerk's image cache (works offline afterwards)
    this.art = new GameArt({ dataDir: this.dataDir, imageCache: this.ctx.imageCache, offline: () => { try { return core('download').isOffline() === true; } catch { return false; } } });
    this.lastScan = new Map(); // last import search: key → found server (with the details that stay on the server)
    this.seen = new Set();
    this.phases = new Map(); // id → { startedAt, tracker, result } – was ein laufender LinuxGSM-Container gerade tut (phase.js)
    this.execUsers = new Map(); // Container → Nutzer, als der LinuxGSM darin läuft
    this.timers = [];
    if (!process.env.HW_TEST) {
      this.timers.push(setInterval(() => this.monitorTick().catch(() => {}), IS_LINUX ? 5 * 60000 : 60000));
      this.timers.push(setInterval(() => this.updateTick().catch(() => {}), 6 * 3600e3));
      for (const t of this.timers) if (t.unref) t.unref();
    }
  }
  stop() { for (const t of this.timers) clearInterval(t); this.timers = []; }
  broadcast(msg) { H.broadcast(msg); }
  /** Meldung über einen Server (Absturz, Update): Hostwerks Kanäle und Discord (server/notify.js), sonst nur in der Oberfläche. */
  alert(event, text, kind = 'warn') {
    if (this.notifier) return this.notifier({ event, text, kind }).catch(() => {});
    this.broadcast({ type: 'toast', kind, text });
    return Promise.resolve();
  }
  get cfg() { const s = this.ctx.settings.get(); if (!s.games) s.games = { servers: [] }; return s.games; }
  list() { return this.cfg.servers; }
  get(id) { const s = this.list().find((x) => x.id === id); if (!s) throw Object.assign(new Error(T('Game server not found')), { status: 404 }); return s; }
  /** Server folder: Hostwerk's own (<base>/spiele/<id>) or – imported in place – the folder where it always was. */
  dir(s) { return s.externalDir || path.join(this.root, s.id); }
  script(s) { return path.join(this.dir(s), s.game); }
  /** Docker mode (Windows/everywhere): official LinuxGSM image, one container per server, data in the volume. */
  isDocker(s) { return s.mode === 'docker'; }
  /** Own data folder (SteamCMD, cached Steam list): <data>/game-servers */
  get dataDir() { return path.join(this.ctx.paths.data || path.join(this.ctx.paths.base, 'data'), 'game-servers'); }
  /** SteamCMD method (1.3) – everything else is LinuxGSM. */
  isSteam(s) { return !!s && s.kind === 'steam'; }
  /** Container name – an imported container keeps its own name. */
  cname(s) { return s.container || `hostwerk-game-${s.id}`; }
  /** Volume (or bind folder) with /data of a LinuxGSM container – an imported container keeps its own. */
  lgsmVolume(s) { return s.volume || `hw-game-${s.id}`; }
  /** Get Docker ready: set up but off → start the engine; not there at all → error with a code (the interface offers the install). */
  async dockerReady() {
    if (!this.ctx.docker) throw new Error(T('Docker is missing.'));
    try { await this.ctx.docker.cli(); return; } catch { /* off or not there */ }
    if (!(await this.dockerInstalled())) throw dockerMissing();
    await this.ctx.docker.start().promise;
    await this.ctx.docker.cli();
  }
  async dx(args, opts = {}) { const r = await this.ctx.docker.x(args, { timeout: opts.timeout || 60000 }); if (r.code !== 0 && !opts.ok) throw new Error((r.stderr || r.stdout || T('docker failed')).trim().split('\n').pop()); return r; }
  /** Check beforehand (before the job) so the interface can ask "Install Docker too?" right away. */
  async needDocker(s) { if (!IS_LINUX && this.isDocker(s) && !(await this.dockerInstalled())) throw dockerMissing(s.name); }
  requireLinux() { if (!IS_LINUX) throw Object.assign(new Error(T('Game servers through LinuxGSM run natively only on Linux. Use Docker mode, pair a Linux machine (Hostwerk network) or set up your own server (VPS).')), { status: 400, linuxOnly: true }); }

  /* ---------- game list ---------- */
  async games() {
    const { fetchText, cached } = core('download');
    const csv = await cached('lgsm-serverlist', 24 * 3600e3, async () => {
      try { return await fetchText(LIST_URL); } catch {
        for (const f of [path.join(__dirname, '..', 'data', 'lgsm-serverlist.csv'), path.join(H.appRoot || '', 'catalog', 'lgsm-serverlist.csv')]) if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8');
        return '';
      }
    });
    const rows = csv.split(/\r?\n/).filter(Boolean).map((l) => l.split(','));
    return rows.filter((r) => r.length >= 3 && r[1] !== 'gameservername').map(([short, script, name, osName]) => ({ short, game: script, name, os: osName || 'ubuntu', hint: FAVORITES[script] || null }));
  }

  /* ---------- requirements ---------- */
  async requirements() {
    if (!IS_LINUX) return { linux: false, missing: [], root: false };
    const need = ['curl', 'wget', 'tmux', 'bc', 'jq', 'tar', 'bzip2', 'gzip', 'unzip', 'binutils', 'bsdmainutils', 'util-linux', 'ca-certificates', 'file', 'distro-info', 'netcat-openbsd', 'cpio', 'xz-utils', 'lib32gcc-s1', 'lib32stdc++6', 'libsdl2-2.0-0:i386', 'steamcmd'];
    const { which } = core('platform');
    const bins = ['curl', 'wget', 'tmux', 'bc', 'jq', 'tar', 'bzip2', 'gzip', 'unzip', 'file', 'xz', 'cpio', 'nc'];
    const missing = [];
    for (const b of bins) if (!(await which(b))) missing.push(b);
    const root = typeof process.getuid === 'function' && process.getuid() === 0;
    const distro = (() => { try { return Object.fromEntries(fs.readFileSync('/etc/os-release', 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => { const [k, v] = l.split('='); return [k, v.replace(/"/g, '')]; })); } catch { return {}; } })();
    const installCmd = /debian|ubuntu/i.test(distro.ID_LIKE || distro.ID || '') ? `sudo dpkg --add-architecture i386 && sudo apt update && sudo apt install -y ${need.join(' ')}` : /fedora|rhel|centos/i.test(distro.ID_LIKE || distro.ID || '') ? 'sudo dnf install -y curl wget tmux bc jq tar bzip2 gzip unzip binutils util-linux ca-certificates file glibc.i686 libstdc++.i686 SDL2.i686' : null;
    return { linux: true, missing, root, distro: distro.PRETTY_NAME || distro.ID || 'Linux', installCmd, user: os.userInfo().username, rootWarning: root ? T('LinuxGSM refuses to start as root – Hostwerk should run as a normal user (the Hostwerk service sets it up like that).') : null };
  }

  /* ---------- create / install ---------- */
  create({ game, name, autoInstall = true, mode = null }) {
    mode = mode || (IS_LINUX ? 'native' : 'docker');
    if (mode === 'docker') return this.createDocker({ game, name, autoInstall });
    this.requireLinux();
    if (!/^[a-z0-9]+server$|^[a-z0-9]+$/.test(String(game || ''))) throw new Error(T('Invalid game'));
    const id = `${String(game).replace(/server$/, '')}-${crypto.randomBytes(2).toString('hex')}`;
    const s = { id, game: String(game), name: this.uniqueName(String(name || FAVORITES[game] || game).slice(0, 60)), createdAt: Date.now(), installed: false, autostart: false, monitor: true };
    this.rememberGameName(s);
    this.list().push(s);
    this.ctx.settings.save();
    fs.mkdirSync(this.dir(s), { recursive: true });
    return this.setupNativeJob(s, autoInstall);
  }
  /** Native setup (LinuxGSM) as a job – also to continue after a crash (every step can run again). */
  setupNativeJob(s, autoInstall = true) {
    const id = s.id; const dir = this.dir(s);
    fs.mkdirSync(dir, { recursive: true });
    const { exec } = core('util');
    return core('jobs').runJob(T('Set up game server “{name}”', { name: s.name }), async (job) => {
      job.progress(5, T('Loading LinuxGSM …'));
      const lgsm = path.join(dir, 'linuxgsm.sh');
      await core('download').downloadFile(SCRIPT_URL, lgsm);
      fs.chmodSync(lgsm, 0o755);
      job.progress(15, T('Creating the script for {game} …', { game: s.game }));
      const r = await exec('bash', [lgsm, s.game], { cwd: dir, env: this.env() });
      if (!fs.existsSync(this.script(s))) throw new Error(T('LinuxGSM does not know “{game}”: {msg}', { game: s.game, msg: (r.stderr || r.stdout).trim().split('\n').pop() }));
      fs.chmodSync(this.script(s), 0o755);
      if (!autoInstall) return { id };
      job.progress(20, T('Installing the game server (SteamCMD, can take long) …'));
      const x = await this.runInJob(job, s, ['auto-install'], { idleMs: 20 * 60000 });
      if (x.code !== 0 && x.code !== 'hang') job.log(T('auto-install ended with code {code} – details above; the installation can be repeated under “Commands”.', { code: x.code }));
      s.installed = fs.existsSync(path.join(dir, 'serverfiles'));
      this.ctx.settings.save();
      this.broadcast({ type: 'games' });
      return { id, installed: s.installed };
    }, { key: 'game-create-' + id, resume: { kind: 'game-setup', params: { id } } });
  }

  createDocker({ game, name, autoInstall = true }) {
    if (!/^[a-z0-9]+server$|^[a-z0-9]+$/.test(String(game || ''))) throw new Error(T('Invalid game'));
    const id = `${String(game).replace(/server$/, '')}-${crypto.randomBytes(2).toString('hex')}`;
    const s = { id, game: String(game), name: this.uniqueName(String(name || FAVORITES[game] || game).slice(0, 60)), createdAt: Date.now(), installed: false, autostart: false, monitor: true, mode: 'docker', ports: [] };
    this.rememberGameName(s);
    this.list().push(s); this.ctx.settings.save();
    return this.setupDockerJob(s, autoInstall);
  }

  /** Docker setup as a job – also to continue when image or container are missing (cancelled, container deleted). */
  setupDockerJob(s, autoInstall = true) {
    const id = s.id;
    return core('jobs').runJob(T('Set up game server “{name}” (Docker)', { name: s.name }), async (job) => {
      await this.dockerReady();
      const short = s.game.replace(/server$/, '');
      const image = `gameservermanagers/gameserver:${short}`;
      job.progress(5, T('Loading image {image} (the SteamCMD download follows in the container) …', { image }));
      await this.ctx.docker.pullInto(job, image);
      // Take the game's ports from the image (EXPOSE) and publish them 1:1
      const insp = await this.dx(['image', 'inspect', image, '--format', '{{json .Config.ExposedPorts}}'], { ok: true });
      let ports = []; try { ports = Object.keys(JSON.parse(insp.stdout.trim() || '{}')).map((p) => { const [port, proto] = p.split('/'); return { port: Number(port), proto: (proto || 'tcp').toUpperCase() }; }); } catch { /* none */ }
      if (!s.portsCustom) s.ports = ports;
      ports = s.ports;
      s.restartFixed = true; this.ctx.settings.save();
      job.progress(60, T('Creating the container …'));
      await this.dx(['rm', '-f', this.cname(s)], { ok: true });
      await this.dx(this.lgsmCreateArgs(s), { timeout: 120000 });
      s.specHash = this.lgsmSpecHash(s); this.ctx.settings.save();
      if (autoInstall) { job.progress(70, T('Starting the container – it installs the game on the first start (SteamCMD, can take long) …')); await this.dx(['start', this.cname(s)]); }
      s.installed = true; this.ctx.settings.save(); this.broadcast({ type: 'games' });
      job.log(T('Ports: {ports} – the installation progress is in the console.', { ports: ports.map((p) => `${p.port}/${p.proto}`).join(', ') || T('none found') }));
      return { id, ports };
    }, { key: 'game-create-' + id, resume: { kind: 'game-setup', params: { id } } });
  }
  /*
   * LinuxGSM container: ports 1:1, data in the volume, limits. No Docker restart policy: otherwise Docker starts the server
   * on every engine start by itself – no matter what "Start with Hostwerk" says. Starting with Hostwerk and restarting after
   * a crash is done by Hostwerk itself.
   */
  lgsmCreateArgs(s) {
    const image = `gameservermanagers/gameserver:${s.game.replace(/server$/, '')}`;
    const pub = (s.ports || []).flatMap((p) => (/tcp/i.test(p.proto) && /udp/i.test(p.proto) ? ['tcp', 'udp'] : [String(p.proto || 'tcp').toLowerCase()]).flatMap((pr) => ['-p', `${p.port}:${p.port}/${pr}`]));
    return ['create', '--name', this.cname(s), '--restart', 'no', '-v', `${this.lgsmVolume(s)}:/data`, '-e', 'UPDATE_ON_START=true', '-e', `LGSM_GAMESERVER=${s.game}`, ...pub, ...this.steam.limitArgs(s.limits), image];
  }
  lgsmSpecHash(s) { return crypto.createHash('sha1').update(JSON.stringify(this.lgsmCreateArgs(s))).digest('hex').slice(0, 16); }
  /** Ports or limits changed → create the container anew (data stays in the volume). Older containers without a hash are kept. */
  async ensureLgsmContainer(s) {
    const hash = this.lgsmSpecHash(s);
    if (!s.specHash) { s.specHash = hash; this.ctx.settings.save(); return false; }
    if (s.specHash === hash) return false;
    await this.dx(['rm', '-f', this.cname(s)], { ok: true });
    await this.dx(this.lgsmCreateArgs(s), { timeout: 120000 });
    s.specHash = hash; this.ctx.settings.save();
    return true;
  }
  /*
   * LinuxGSM im Container IMMER als dessen Nicht-root-Nutzer: Das offizielle Image läuft als root und wechselt selbst per
   * gosu zum Nutzer „linuxgsm“. Ein „docker exec“ ohne -u landet als root – LinuxGSM bricht dann JEDEN Befehl mit
   * „CORE: FAIL: <server> attempted to run as root.“ ab (Code 1: Aktualisieren, Details, Backup, Konsole, Mods …).
   * Der Nutzer wird aus dem Container gelesen (Config.User, sonst USER aus der Umgebung des Images), Rückfall „linuxgsm“.
   */
  async execUser(s) {
    const c = this.cname(s);
    if (this.execUsers.has(c)) return this.execUsers.get(c);
    const r = await this.dx(['inspect', '--format', '{{json .Config}}', c], { ok: true, timeout: 15000 });
    let user = 'linuxgsm';
    try { const cfg = JSON.parse(String(r.stdout || '').trim() || '{}'); user = execUserOf(cfg); } catch { /* Rückfall */ }
    if (r.code === 0) this.execUsers.set(c, user);
    return user;
  }
  /** ./<server> <args> im Container – überall derselbe Weg (Befehle, Details, Befehlsliste, Konsole, Stoppen). */
  async lgsmExec(s, args = [], { timeout = 60000 } = {}) {
    const c = this.cname(s);
    const user = await this.execUser(s);
    let r = await this.dx(['exec', '-u', user, c, `./${s.game}`, ...args], { ok: true, timeout });
    // Sicherheitsnetz: meldet LinuxGSM trotzdem „als root“ (eigenes Image, anderer USER), noch einmal als linuxgsm
    if (user !== 'linuxgsm' && /attempted to run as root/i.test(`${r.stdout}${r.stderr}`)) {
      this.execUsers.set(c, 'linuxgsm');
      r = await this.dx(['exec', '-u', 'linuxgsm', c, `./${s.game}`, ...args], { ok: true, timeout });
    }
    return r;
  }
  env() { return { ...process.env, LGSM_GITHUBUSER: 'GameServerManagers', TERM: 'xterm', LANG: 'C.UTF-8', HOME: process.env.HOME || os.homedir(), CI: '1' }; }

  /* ---------- one-step setup (both methods) ---------- */
  /** Steam server: install (+ start) as a job – also to continue after a crash. */
  steamSetupJob(s, { start = false } = {}) {
    return core('jobs').runJob(T('Set up game server “{name}”', { name: s.name }), async (job) => {
      await this.steam.install(job, s);
      this.broadcast({ type: 'games' });
      if (start) { job.progress(96, T('Starting the server …')); await this.steam.start(job, s); await this.refresh(s).catch(() => {}); this.broadcast({ type: 'games' }); }
      return { id: s.id, installed: true };
    }, { key: 'game-create-' + s.id, resume: { kind: 'game-setup', params: { id: s.id } } });
  }

  /**
   * One flow from "pick a game" to a running server, shown as ONE job with clear steps:
   *   1. Docker (only if the chosen way needs it): set up Hostwerk's Docker engine if missing (installDocker: true), start it if off
   *   2. Install the game server (LinuxGSM or SteamCMD)
   *   3. Start it (start: true)
   * Without installDocker a missing Docker is reported with the code DOCKER_MISSING (the interface asks and repeats).
   */
  async setup(b = {}) {
    const method = b.method === 'steam' ? 'steam' : 'lgsm';
    let needsDocker;
    let s;
    if (method === 'steam') {
      const app = this.apps.find(b.appid) || { appid: Number(b.appid), win: null, linux: null };
      const plan = this.steam.planWith(app, b.mode);
      if (!plan.ok) throw Object.assign(new Error(this.steam.planText(plan)), { status: 400 });
      needsDocker = plan.needsDocker;
      if (needsDocker && !b.installDocker && !(await this.dockerInstalled())) throw dockerMissing(b.name || app.name);
      s = this.steam.create(b, app);
    } else {
      const mode = b.mode === 'docker' || b.mode === 'native' ? b.mode : IS_LINUX ? 'native' : 'docker';
      if (mode === 'native') this.requireLinux();
      if (!/^[a-z0-9]+server$|^[a-z0-9]+$/.test(String(b.game || ''))) throw Object.assign(new Error(T('Invalid game')), { status: 400 });
      needsDocker = mode === 'docker';
      if (needsDocker && !b.installDocker && !(await this.dockerInstalled())) throw dockerMissing(b.name);
      const id = `${String(b.game).replace(/server$/, '')}-${crypto.randomBytes(2).toString('hex')}`;
      s = { id, game: String(b.game), name: this.uniqueName(String(b.name || FAVORITES[b.game] || b.game).replace(/[\u0000-\u001f]/g, '').slice(0, 60)), createdAt: Date.now(), installed: false, autostart: false, monitor: true, ...(mode === 'docker' ? { mode: 'docker', ports: [] } : {}) };
      this.rememberGameName(s);
      this.list().push(s); this.ctx.settings.save();
      if (mode === 'native') fs.mkdirSync(this.dir(s), { recursive: true });
    }
    const start = b.start !== false;
    const steps = [needsDocker && 'docker', 'install', start && 'start'].filter(Boolean);
    const stepText = (k, text) => T('Step {n} of {total}: {text}', { n: steps.indexOf(k) + 1, total: steps.length, text });
    this.broadcast({ type: 'games' });
    const job = core('jobs').runJob(T('Set up game server “{name}”', { name: s.name }), async (j) => {
      if (needsDocker) {
        j.progress(2, stepText('docker', T('Docker')));
        if (!(await this.dockerInstalled())) {
          if (!this.ctx.docker) throw new Error(T('Docker is missing.'));
          j.log(T('Docker is not set up yet – Hostwerk sets up its own Docker engine (Windows may ask for administrator rights).'));
          const dj = process.platform === 'win32' && typeof this.ctx.docker.installWsl === 'function' ? this.ctx.docker.installWsl() : this.ctx.docker.install({ engine: 'wsl', acceptLicense: true });
          const r = await dj.promise;
          if (r && r.restartNeeded) { j.log(T('Windows has to restart once to finish WSL – then open the server and choose “Continue installation”.')); return { id: s.id, restartNeeded: true }; }
        }
        await this.dockerReady();
      }
      j.progress(10, stepText('install', method === 'steam' ? T('Installing through SteamCMD (can take long) …') : T('Installing through LinuxGSM (can take long) …')));
      // Progress of the install step stays inside "Step n of m" (10–95 %), so the interface can show the steps all the time
      const stepJob = { ...j, progress: (p, text) => j.progress(10 + 0.85 * p, stepText('install', text || T('Installing …'))), log: (l) => j.log(l), onCancel: (f) => (j.onCancel ? j.onCancel(f) : () => {}) };
      if (method === 'steam') await this.steam.install(stepJob, s);
      else {
        const inner = this.isDocker(s) ? this.setupDockerJob(s, start) : this.setupNativeJob(s, true); // the LinuxGSM container installs and starts in one go
        const mirror = setInterval(() => { if (typeof inner.progress_ === 'number') stepJob.progress(inner.progress_, inner.text); }, 1000);
        try { await inner.promise; } finally { clearInterval(mirror); }
      }
      this.broadcast({ type: 'games' });
      if (start) {
        j.progress(96, stepText('start', T('Starting the server …')));
        if (method === 'steam') await this.steam.start(j, s);
        else if (!this.isDocker(s)) await this.run(s.id, 'start').promise;
        await this.refresh(s).catch(() => {});
        this.broadcast({ type: 'games' });
      }
      return { id: s.id, installed: !!s.installed, steps };
    }, { key: 'game-quick-' + s.id });
    return { job: job.id, id: s.id, steps };
  }

  /** Popular games with the best way for this system (for the empty page). */
  async quickPicks() {
    const platform = hostPlatform();
    const docker = await this.dockerAvailable().catch(() => false);
    const dockerInstalled = docker || (await this.dockerInstalled().catch(() => false));
    return { platform, linux: IS_LINUX, docker, dockerInstalled, picks: PICKS.map((x) => pickFor(x, platform)).filter(Boolean) };
  }

  runInJob(job, s, args, opts = {}) { return this.ctx.devtools.runInJob(job, this.script(s), args, { cwd: this.dir(s), env: this.env(), noInput: true, idleMs: opts.idleMs || 10 * 60000 }); }

  /**
   * Available LinuxGSM commands of this server – read from the script's help ("start  st | Start the server.").
   * So game-specific commands (e.g. wipe for Rust, mods-install, fastdl, map-compressor) show up by themselves.
   * Cached for 6 h; fresh after "Update LinuxGSM".
   */
  async commandsFor(s, { fresh = false } = {}) {
    if (this.isSteam(s)) return ['start', 'stop', 'restart', 'update', 'validate', 'backup'].map((cmd) => ({ cmd, short: null, desc: COMMANDS[cmd] }));
    if (!fresh && s.cmds && Date.now() - s.cmds.at < 6 * 3600e3) return s.cmds.list;
    let out = '';
    try {
      // Während Installation/Update gibt es das Skript evtl. noch nicht – dann die bekannte Liste, nichts merken
      if (this.isDocker(s)) { if (!PH.isBusy(this.phaseNow(s))) { const r = await this.lgsmExec(s, [], { timeout: 30000 }); out = r.stdout + r.stderr; } }
      else if (IS_LINUX && fs.existsSync(this.script(s))) { const r = await core('util').exec(this.script(s), [], { cwd: this.dir(s), env: this.env(), timeout: 30000 }); out = (r.stdout || '') + (r.stderr || ''); }
    } catch { /* server not running / not installed */ }
    const list = parseCommands(out);
    if (list.length) { s.cmds = { at: Date.now(), list }; this.ctx.settings.save(); }
    return list.length ? list : Object.keys(COMMANDS).map((cmd) => ({ cmd, short: null, desc: COMMANDS[cmd] }));
  }
  /** Allowed: known commands and everything LinuxGSM offers for this server itself – except interactive ones. */
  allowed(s, command) {
    if (/^(console|debug|install|auto-install|skeleton|sponsor|donate)$/.test(command) || /^dev-/.test(command)) return /^(install|auto-install)$/.test(command);
    return !!COMMANDS[command] || !!(s.cmds && s.cmds.list.some((x) => x.cmd === command));
  }
  label(command) { return COMMANDS[command] ? T(COMMANDS[command]) : command; }

  /**
   * Während Installation, Update oder Start scheitern Pflege-Befehle (Aktualisieren, Dateien prüfen, Backup, Mods …) –
   * LinuxGSM meldet dann nur „Code 1“. Stattdessen gleich eine klare Antwort; Starten, Stoppen und Erzwingen gehen immer.
   */
  assertReady(s, command) {
    if (PH.ALLOWED_WHILE_BUSY.test(command)) return;
    const p = this.phaseNow(s);
    if (!PH.isBusy(p)) return;
    const v = { name: s.name, what: command === 'send' ? T('Console commands') : this.label(command) };
    const msg = p.state === 'installing' ? T('“{name}” is still being installed – “{what}” works once the installation is done.', v)
      : p.state === 'updating' ? T('“{name}” is being updated right now – “{what}” works once the update is done.', v)
        : T('“{name}” is still starting – try “{what}” again in a moment.', v);
    throw Object.assign(new Error(msg), { status: 409, code: 'GAME_BUSY', phase: p.state });
  }

  run(id, command, extra = []) {
    const s = this.get(id);
    this.assertReady(s, command);
    if (this.isSteam(s)) return this.steam.run(s, command);
    if (this.isDocker(s)) return this.runDocker(s, command, extra);
    this.requireLinux();
    const { exec } = core('util');
    const { runJob } = core('jobs');
    // Force (native): end the LinuxGSM session right away – for hanging servers
    if (command === 'kill') return runJob(`${s.name}: ${this.label('kill')}`, async () => { await exec('tmux', ['kill-session', '-t', s.game], { env: this.env() }); await this.refresh(s); this.broadcast({ type: 'games' }); return { ok: true, text: T('Ended right away (forced).') }; }, { key: `game-${id}-kill` });
    if (!this.allowed(s, command)) throw new Error(T('LinuxGSM does not offer this command for this server.'));
    const safeExtra = (Array.isArray(extra) ? extra : []).map(String).filter((x) => /^[\w.:/-]+$/.test(x)).slice(0, 6);
    return runJob(`${s.name}: ${this.label(command)}`, async (job) => {
      const r = await this.runInJob(job, s, [command, ...safeExtra], { idleMs: /update|install|validate|backup/.test(command) ? 30 * 60000 : 5 * 60000 });
      if (command === 'install' || command === 'auto-install') { s.installed = fs.existsSync(path.join(this.dir(s), 'serverfiles')); this.ctx.settings.save(); }
      await this.refresh(s);
      this.broadcast({ type: 'games' });
      const out = r.out.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
      if (r.code !== 0 && r.code !== 'hang' && !/details|check-update|monitor/.test(command)) throw Object.assign(new Error(this.failText(command, r.code, out)), { output: out.slice(-3000) });
      return { ok: true, output: out.slice(-6000), text: out.trim().split('\n').filter(Boolean).pop() || 'ok' };
    }, { key: `game-${id}-${command}` });
  }

  runDocker(s, command, extra = []) {
    if (command !== 'kill' && !this.allowed(s, command)) throw new Error(T('LinuxGSM does not offer this command for this server.'));
    // "Install/continue" in Docker mode means: create image and container (again) – not ./script auto-install in a missing container
    if (/^(install|auto-install)$/.test(command)) return this.setupDockerJob(s, true);
    const safeExtra = (Array.isArray(extra) ? extra : []).map(String).filter((x) => /^[\w.:/-]+$/.test(x)).slice(0, 6);
    return core('jobs').runJob(`${s.name}: ${this.label(command)}`, async (job) => {
      if (!/^(stop|kill)$/.test(command)) await this.dockerReady(); // always try to stop – even if the engine answers slowly right now
      const c = this.cname(s);
      const ex = await this.dx(['inspect', '--format', '{{.Id}}', c], { ok: true, timeout: 15000 });
      if (ex.code !== 0) { s.installed = false; this.ctx.settings.save(); this.broadcast({ type: 'games' }); throw new Error(T('The container “{c}” does not exist any more – choose “Continue installation” on the overview, then Hostwerk creates it again.', { c })); }
      if (/^(start|restart)$/.test(command)) { s.wantRun = true; this.ctx.settings.save(); }
      if (command === 'stop' || command === 'kill') { s.wantRun = false; this.ctx.settings.save(); }
      if (command === 'kill') {
        // Force: end right away (like pulling the plug) – for hanging servers
        await this.dx(['kill', c], { timeout: 60000 });
        await this.refresh(s); this.broadcast({ type: 'games' });
        return { ok: true, text: T('Ended right away (forced).') };
      }
      if (command === 'restart' && s.specHash && s.specHash !== this.lgsmSpecHash(s)) {
        // Ports or limits changed: stop, create the container anew, start
        await this.lgsmExec(s, ['stop'], { timeout: 120000 });
        await this.dx(['stop', '-t', '30', c], { ok: true, timeout: 90000 });
        await this.ensureLgsmContainer(s);
        await this.dx(['start', c]); await this.refresh(s); this.broadcast({ type: 'games' });
        return { ok: true, text: T('Container created anew with the new settings and started.') };
      }
      if (command === 'start') { await this.ensureLgsmContainer(s); await this.dx(['start', c]); await this.refresh(s); this.broadcast({ type: 'games' }); return { ok: true, text: T('Container started (LinuxGSM starts the server inside).') }; }
      if (command === 'stop') {
        await this.lgsmExec(s, ['stop'], { timeout: 120000 });
        await this.dx(['stop', '-t', '30', c], { timeout: 90000 });
        // Only report "stopped" once the container is really off – otherwise say so honestly and offer to force it
        if (await this.running(s).catch(() => false)) throw Object.assign(new Error(T('The server is still running – “Force” ends it right away.')), { canKill: true });
        await this.refresh(s); this.broadcast({ type: 'games' });
        return { ok: true, text: T('Stopped.') };
      }
      const r = await this.lgsmExec(s, [command, ...safeExtra], { timeout: /update|install|validate|backup/.test(command) ? 30 * 60000 : 5 * 60000 });
      const out = (r.stdout + '\n' + r.stderr).replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
      for (const l of out.split('\n').filter(Boolean).slice(-60)) job.log(l);
      await this.refresh(s); this.broadcast({ type: 'games' });
      if (r.code !== 0 && !/details|check-update|monitor/.test(command)) throw Object.assign(new Error(this.failText(command, r.code, out)), { output: out.slice(-3000) });
      return { ok: true, output: out.slice(-6000), text: out.trim().split('\n').filter(Boolean).pop() || 'ok' };
    }, { key: `game-${s.id}-${command}` });
  }

  /** „Aktualisieren hat nicht geklappt: Nicht genug Speicherplatz.“ – Ursache aus der Ausgabe statt nur „Code 1“ */
  failText(command, code, out) {
    const why = PH.explainFailure(out, { T });
    return why ? T('{what} did not work: {why}', { what: this.label(command), why }) : T('{what} reports code {code}', { what: this.label(command), code });
  }

  /* ---------- state ---------- */
  /** Older containers (created with --restart unless-stopped) are switched to "no policy" once. */
  async fixRestartPolicy(s) {
    if (!this.isDocker(s) || s.restartFixed) return;
    const r = await this.dx(['update', '--restart=no', this.cname(s)], { ok: true, timeout: 20000 });
    if (r.code === 0) { s.restartFixed = true; this.ctx.settings.save(); }
  }
  async running(s) {
    if (this.isSteam(s)) return this.steam.running(s);
    if (this.isDocker(s)) await this.fixRestartPolicy(s).catch(() => {});
    if (this.isDocker(s)) {
      const st = await this.dockerState(s);
      if (st.running) await this.trackDocker(s, st).catch(() => {});
      else this.phases.delete(s.id);
      return st.running;
    }
    // LinuxGSM starts the game in a tmux session named like the script
    const r = await core('util').exec('tmux', ['has-session', '-t', s.game], { env: this.env() });
    return r.code === 0;
  }
  /** Läuft der Container, seit wann, und was sagt der Healthcheck des Images (LinuxGSM „monitor“)? */
  async dockerState(s) {
    const r = await this.dx(['inspect', '--format', '{{.State.Running}}|{{.State.StartedAt}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}', this.cname(s)], { ok: true, timeout: 15000 });
    const [run, startedAt, health] = String(r.stdout || '').trim().split('|');
    return { running: r.code === 0 && run === 'true', startedAt: startedAt || null, health: health || null };
  }
  /*
   * Was der laufende Container gerade tut – aus seiner eigenen Ausgabe (docker logs --timestamps, nur das Neue seit dem
   * letzten Mal). Solange er installiert/aktualisiert/startet alle 4 s, danach jede Minute (Update-Prüfung des Images).
   * Wird er beschäftigt erkannt, läuft eine Aufgabe „Wird installiert“ mit Balken im Aufgaben-Fenster mit.
   */
  async trackDocker(s, st, { force = false } = {}) {
    let p = this.phases.get(s.id);
    if (!p || p.startedAt !== st.startedAt) {
      const started = Date.parse(st.startedAt || '') || Date.now();
      p = { startedAt: st.startedAt, at: 0, reading: null, result: null, tracker: new PH.PhaseTracker({ startedAt: started, installedBefore: !!s.readyAt, T, lang: typeof H.lang === 'function' ? H.lang() : 'de' }) };
      this.phases.set(s.id, p);
    }
    const now = Date.now();
    if ((force || now - p.at >= (p.tracker.phase === 'ready' ? 60000 : 4000)) && !p.reading) {
      p.reading = (async () => {
        const since = p.tracker.lastTs || st.startedAt;
        const r = await this.dx(['logs', '--timestamps', ...(since ? ['--since', since] : []), '--tail', p.at ? '2000' : '4000', this.cname(s)], { ok: true, timeout: 20000 });
        if (r.code === 0) p.tracker.feed(PH.parseDockerLogs(`${r.stdout || ''}\n${r.stderr || ''}`), now);
        p.at = Date.now();
      })().catch(() => {}).finally(() => { p.reading = null; });
    }
    if (p.reading) await p.reading;
    const before = p.result ? p.result.state : null;
    const r = p.tracker.result({ now: Date.now(), health: st.health });
    p.result = r;
    if (r.state === 'ready' && !r.fallback && !s.readyAt) { s.readyAt = Date.now(); this.ctx.settings.save(); }
    if (before !== r.state) {
      this.broadcast({ type: 'games' });
      if (r.state === 'ready' && (before === 'installing' || before === 'updating' || before === 'starting') && !r.fallback) this.broadcast({ type: 'toast', kind: 'success', text: T('{name} is ready – players can join.', { name: s.name }) });
    }
    if (PH.isBusy(r)) this.watchPhase(s);
    return r;
  }
  /*
   * Aufgabe im Aufgaben-Fenster, solange der Container installiert/aktualisiert/startet: Balken mit Größe, Tempo und
   * Restzeit. „Abbrechen“ stoppt den Server (die Installation läuft beim nächsten Start weiter). Endet von selbst.
   */
  watchPhase(s) {
    if (process.env.HW_TEST && !this.watchInTests) return null;
    const first = this.phaseNow(s) || {};
    return core('jobs').runJob(first.state === 'updating' ? T('{name}: updating', { name: s.name }) : first.state === 'starting' ? T('{name}: starting', { name: s.name }) : T('{name}: installing', { name: s.name }), async (job) => {
      if (typeof job.onCancel === 'function') job.onCancel(() => { try { this.run(s.id, 'stop').promise.catch(() => {}); } catch { /* weg */ } });
      let lost = 0;
      for (;;) {
        await new Promise((res) => setTimeout(res, this.watchMs || 5000));
        if (typeof job.checkpoint === 'function') await job.checkpoint();
        const st = await this.dockerState(s).catch(() => null);
        if (!st) { if ((lost += 1) > 120) return { ok: true, text: T('Docker does not answer – watching stopped.') }; continue; }
        lost = 0;
        if (!st.running) { this.phases.delete(s.id); this.broadcast({ type: 'games' }); return { ok: true, text: T('The container was stopped.') }; }
        const r = await this.trackDocker(s, st, { force: true });
        if (r.state === 'failed') throw new Error(r.error ? `${r.text} (${r.error})` : r.text);
        if (!PH.isBusy(r)) return { ok: true, text: T('{name} is ready.', { name: s.name }) };
        job.progress(r.pct || 0, r.text);
      }
    }, { key: `game-${s.id}-watch` });
  }
  /**
   * Zustand für Oberfläche und Sperren: eine laufende Installations-/Update-Aufgabe (SteamCMD-Weg, nativ) oder was der
   * Container gerade tut. null = läuft normal (oder gestoppt).
   */
  phaseNow(s) {
    let list = [];
    try { const j = core('jobs'); list = typeof j.listJobs === 'function' ? j.listJobs() : []; } catch { /* ohne Aufgaben */ }
    const mine = list.filter((j) => j.state === 'running' && String(j.key || '').startsWith(`game-${s.id}-`));
    const job = mine.find((j) => /-(install|auto-install|update|force-update|validate)$/.test(j.key)) || mine.find((j) => /-(start|restart)$/.test(j.key) && /SteamCMD|update|download|aktualis|herunterlad/i.test(j.text || ''));
    if (job) return { state: /install$/.test(job.key) && !s.installed ? 'installing' : 'updating', pct: job.progress || null, text: job.text || null, since: job.startedAt, job: job.id };
    const p = this.phases.get(s.id);
    return s.running && p && p.result ? PH.publicPhase(p.result) : null;
  }
  async refresh(s) {
    const before = !!s.running;
    try { s.running = await this.running(s); } catch { s.running = false; }
    if (s.public && before !== !!s.running) this.portsChanged(); // öffentlicher Server gestartet/gestoppt → Router nachziehen
    return s.running;
  }

  /**
   * Ports der Server, die „von außen erreichbar“ sein sollen und gerade laufen – Hostwerk (ab 2.11) nimmt sie in die
   * Firewall und die Router-Automatik auf; stoppt der Server, fallen sie wieder heraus und der Router schließt sie.
   */
  publicPorts() {
    const out = [];
    for (const s of this.list()) {
      if (!s.public || !s.running) continue;
      for (const p of this.portsOf(s)) {
        const port = Number(p.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
        const proto = String(p.proto || '').toLowerCase();
        for (const pr of /udp/.test(proto) && /tcp/.test(proto) ? ['TCP', 'UDP'] : [/udp/.test(proto) ? 'UDP' : 'TCP']) out.push({ port, proto: pr, label: `${s.name} (${p.name || 'Game'})` });
      }
    }
    return out;
  }
  /** Geänderte Ports gleich an den Router geben, wenn dessen Automatik an ist (sonst beim nächsten Durchlauf). */
  portsChanged() {
    const r = this.ctx.router;
    if (r && r.cfg && r.cfg.auto && typeof r.sync === 'function') r.sync().catch(() => {});
  }
  /**
   * Konsole: SteamCMD-Fortschritt und andere Balken als je EINE Zeile (statt hunderter „Update state …“), raw = genau die
   * Ausgabe. Für die Zusammenfassung wird mehr gelesen, damit danach trotzdem n sinnvolle Zeilen bleiben.
   */
  async consoleLogAsync(s, n = 300, { raw = false } = {}) {
    const want = Math.max(1, Math.min(5000, Number(n) || 300));
    const read = raw ? want : Math.min(5000, want * 4);
    let lines;
    if (this.isSteam(s)) lines = await this.steam.consoleLines(s, read);
    else if (this.isDocker(s)) { const r = await this.dx(['logs', '--tail', String(read), this.cname(s)], { ok: true, timeout: 20000 }); lines = `${r.stdout}${r.stderr}`.split('\n'); }
    else lines = this.consoleLog(s, read);
    if (raw) return lines.map((l) => String(l).replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')).filter((l) => l.trim()).slice(-want);
    return PH.condenseConsole(lines).slice(-want);
  }
  consoleLog(s, n = 300) {
    const dir = path.join(this.dir(s), 'log', 'console');
    if (!fs.existsSync(dir)) return [];
    const files = fs.readdirSync(dir).filter((f) => /-console\.log$/.test(f)).map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
    return files[0] ? core('util').readLastLines(path.join(dir, files[0].f), n) : [];
  }
  async configAsync(s) {
    if (this.isSteam(s)) return { file: null, content: '', defaults: '', steam: true };
    if (!this.isDocker(s)) return this.config(s);
    const rel = `/data/config-lgsm/${s.game}/${s.game}.cfg`;
    // docker cp also works while the container is stopped (docker exec does not)
    const read = async (p) => {
      const tmp = path.join(this.ctx.paths.cache, `gs-${s.id}-${crypto.randomBytes(3).toString('hex')}.cfg`);
      const r = await this.dx(['cp', `${this.cname(s)}:${p}`, tmp], { ok: true });
      try { return r.code === 0 && fs.existsSync(tmp) ? fs.readFileSync(tmp, 'utf8') : ''; } finally { fs.rmSync(tmp, { force: true }); }
    };
    return { file: rel, content: await read(rel), defaults: (await read(`/data/config-lgsm/${s.game}/_default.cfg`)).slice(0, 60000) };
  }
  /** Common LinuxGSM settings (name, port, slots, password, start parameters) – those the game's _default.cfg has. */
  async quickGet(s) {
    const cfg = await this.configAsync(s);
    const defs = parseShellVars(cfg.defaults);
    const own = parseShellVars(cfg.content);
    const keys = LGSM_KEYS.filter((k) => k in defs || k in own);
    return { keys, values: Object.fromEntries(keys.map((k) => [k, k in own ? own[k] : defs[k]])), defaults: Object.fromEntries(keys.map((k) => [k, defs[k] ?? ''])) };
  }
  async quickSet(s, updates) {
    const cur = await this.quickGet(s);
    const want = {};
    for (const k of cur.keys) if (typeof (updates || {})[k] === 'string' && updates[k] !== cur.values[k]) want[k] = updates[k];
    if (want.port !== undefined || want.queryport !== undefined) for (const k of ['port', 'queryport']) if (want[k] !== undefined && !/^\d{1,5}$/.test(want[k])) throw Object.assign(new Error(T('Ports are numbers between 1 and 65535.')), { status: 400 });
    if (want.maxplayers !== undefined && !/^\d{1,4}$/.test(want.maxplayers)) throw Object.assign(new Error(T('Max players is a number.')), { status: 400 });
    if (!Object.keys(want).length) return { ...cur, changed: false };
    const cfg = await this.configAsync(s);
    await this.setConfigAsync(s, setShellVars(cfg.content, want));
    // Docker: move the published ports along with the game port (takes effect with the next restart – the container is created anew)
    if (want.port !== undefined && this.isDocker(s)) {
      const delta = Number(want.port) - Number(cur.values.port);
      if (delta && Number.isFinite(delta) && (s.ports || []).length) {
        s.ports = s.ports.map((p) => ({ ...p, port: p.port + delta })).filter((p) => p.port >= 1 && p.port <= 65535);
        s.portsCustom = true; s.detail = null; this.ctx.settings.save();
      }
    }
    if (want.port !== undefined) { s.detail = null; s.queryPort = null; this.ctx.settings.save(); }
    return { ...(await this.quickGet(s)), changed: true };
  }
  /** Settings of a Steam server (name/port/slots/password/start line/backups). */
  steamSet(s, b) {
    try { return this.steamSetRaw(s, b); } catch (e) { throw Object.assign(new Error(T(e.message)), { status: e.status || 400 }); }
  }
  steamSetRaw(s, b) {
    const p = SG.profileFor(s.appid);
    if (b.port !== undefined) { const n = Number(b.port); if (!Number.isInteger(n) || n < 1 || n > 65535) throw Object.assign(new Error(T('Ports are numbers between 1 and 65535.')), { status: 400 }); s.port = n; }
    if (b.maxPlayers !== undefined) { const n = Number(b.maxPlayers); if (!Number.isInteger(n) || n < 1 || n > 1000) throw Object.assign(new Error(T('Max players is a number.')), { status: 400 }); s.maxPlayers = n; }
    if (b.password !== undefined) {
      const v = String(b.password);
      if (/[\s"'`$\\]/.test(v) || v.length > 40) throw Object.assign(new Error(T('The password may not contain spaces, quotes, $ or \\ (at most 40 characters).')), { status: 400 });
      if (p && p.passwordMin && v.length < p.passwordMin) throw Object.assign(new Error(T('{game} needs a password with at least {n} characters.', { game: p.name, n: p.passwordMin })), { status: 400 });
      s.password = v;
    }
    if (b.extraArgs !== undefined) { SG.splitArgs(b.extraArgs); s.extraArgs = String(b.extraArgs).slice(0, 2000); }
    if (b.customExe !== undefined || b.customArgs !== undefined) {
      const exe = String(b.customExe ?? (s.custom && s.custom.exe) ?? '').trim();
      if (exe) safeRel(this.dir(s), exe);
      const args = String(b.customArgs ?? (s.custom && s.custom.args) ?? '');
      SG.splitArgs(args);
      s.custom = exe || args.trim() || !p ? { exe, args: args.slice(0, 2000) } : null;
    }
    if (b.customPorts !== undefined) s.customPorts = String(b.customPorts).trim() ? SG.parsePortList(b.customPorts) : null;
    if (b.saves !== undefined) { const v = String(b.saves).trim(); if (v) safeRel(this.dir(s), v); s.saves = v || null; }
    if (b.backupKeep !== undefined) s.backupKeep = Math.max(1, Math.min(100, Number(b.backupKeep) || 10));
    if (b.extraConfig !== undefined) { const v = String(b.extraConfig).trim(); if (v) { safeRel(this.dir(s), v); this.steam.checkText(v); s.extraConfigs = [...new Set([...(s.extraConfigs || []), v])].slice(0, 20); } }
    s.ports = SG.portsFor(s);
    s.queryPort = null;
    this.ctx.settings.save();
    if (s.public) this.portsChanged();
    return this.info(s);
  }
  /** CPU/RAM limits for Docker containers – applied right away if possible, otherwise with the next start. */
  async setLimits(s, b) {
    if (!this.isDocker(s)) throw Object.assign(new Error(T('Limits only work for servers in Docker containers.')), { status: 400 });
    s.limits = cleanLimits(b);
    this.ctx.settings.save();
    let live = false;
    if (s.limits && (await this.dockerAvailable())) {
      const args = ['update'];
      if (s.limits.cpus) args.push('--cpus', String(s.limits.cpus));
      if (s.limits.memoryMb) args.push('--memory', `${s.limits.memoryMb}m`, '--memory-swap', `${s.limits.memoryMb}m`);
      if (args.length > 1) { const r = await this.dx([...args, this.cname(s)], { ok: true, timeout: 30000 }); live = r.code === 0; }
    }
    return { limits: s.limits, live };
  }
  async setConfigAsync(s, content) {
    if (!this.isDocker(s)) return this.setConfig(s, content);
    const tmp = path.join(this.ctx.paths.cache, `${s.id}.cfg`); fs.writeFileSync(tmp, String(content));
    await this.dx(['cp', tmp, `${this.cname(s)}:/data/config-lgsm/${s.game}/${s.game}.cfg`]); fs.rmSync(tmp, { force: true });
    return this.configAsync(s);
  }
  config(s) {
    const f = path.join(this.dir(s), 'lgsm', 'config-lgsm', s.game, `${s.game}.cfg`);
    const d = path.join(this.dir(s), 'lgsm', 'config-lgsm', s.game, '_default.cfg');
    return { file: f, content: fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '', defaults: fs.existsSync(d) ? fs.readFileSync(d, 'utf8').slice(0, 60000) : '' };
  }
  setConfig(s, content) { const { file } = this.config(s); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, String(content)); return this.config(s); }
  /** Ports from "details" (for forwarding). */
  async details(s) {
    if (this.isSteam(s)) return { text: '', ports: this.portsOf(s), info: {} };
    if (PH.isBusy(this.phaseNow(s))) return { text: '', ports: this.portsOf(s), info: {}, busy: true }; // erst nach der Installation
    let r;
    if (this.isDocker(s)) r = await this.lgsmExec(s, ['details'], { timeout: 60000 });
    else { this.requireLinux(); r = await core('util').exec(this.script(s), ['details'], { cwd: this.dir(s), env: this.env(), timeout: 60000 }); }
    const { text, ports, info } = parseDetails(r.stdout + r.stderr);
    if (ports.length) { s.detail = { ports, at: Date.now() }; s.queryPort = null; this.ctx.settings.save(); }
    return { text, ports, info };
  }
  backups(s) { if (this.isSteam(s)) return this.steam.backups(s); const d = path.join(this.dir(s), 'backups'); if (!fs.existsSync(d)) return []; return fs.readdirSync(d).filter((f) => /\.tar\.gz$/.test(f)).map((f) => { const st = fs.statSync(path.join(d, f)); return { file: f, size: st.size, time: st.mtimeMs }; }).sort((a, b) => b.time - a.time); }
  async remove(id, { files = false } = {}) {
    const s = this.get(id);
    if (this.isSteam(s)) await this.steam.remove(s, { files });
    else if (this.isDocker(s)) { await this.dx(['rm', '-f', this.cname(s)], { ok: true }); if (files && !/[\\/]/.test(this.lgsmVolume(s))) await this.dx(['volume', 'rm', this.lgsmVolume(s)], { ok: true }); }
    else if (IS_LINUX && (await this.running(s))) await this.run(id, 'stop').promise.catch(() => {});
    this.cfg.servers = this.list().filter((x) => x.id !== id);
    this.ctx.settings.save();
    // An imported folder (in place) was there before Hostwerk – it stays; only Hostwerk's own folders are deleted
    if (files && !s.externalDir) fs.rmSync(this.dir(s), { recursive: true, force: true });
  }
  /*
   * Monitor: natively through LinuxGSM "monitor"; in Docker mode Hostwerk restarts a crashed container – but only if it
   * was started through Hostwerk and not stopped through Hostwerk (wantRun).
   */
  async monitorTick() {
    // Docker servers with "Start with Hostwerk": once per session as soon as the engine is there (also if started by hand later)
    if (!this.dockerAutoDone && this.list().some((x) => x.autostart && this.isDocker(x)) && (await this.dockerAvailable())) { this.dockerAutoDone = true; await this.startAutostart({ docker: true }); }
    for (const s of this.list()) {
      if (!s.monitor || !s.installed) continue;
      if (this.isSteam(s)) { if (!this.isDocker(s) || (await this.dockerAvailable())) await this.steam.monitor(s, this.seen).catch(() => {}); continue; }
      if (!this.isDocker(s)) { if (IS_LINUX) { try { await this.run(s.id, 'monitor').promise; } catch { /* reports itself */ } } continue; }
      if (!s.wantRun || !(await this.dockerAvailable())) continue;
      /*
       * Only restart real crashes: the container must have been seen running in THIS Hostwerk session and must have ended
       * with an error (exit code ≠ 0 or killed for memory). Whoever stops it outside, restarts Docker or restarts Hostwerk
       * does not get a server that starts "by itself".
       */
      const st = await this.dx(['inspect', '--format', '{{.State.Running}}|{{.State.ExitCode}}|{{.State.OOMKilled}}', this.cname(s)], { ok: true, timeout: 20000 });
      const [run, code, oom] = st.stdout.trim().split('|');
      if (st.code !== 0) continue;
      if (run === 'true') { this.seen.add(s.id); await this.refresh(s).catch(() => {}); continue; }
      const crashed = this.seen.has(s.id) && (oom === 'true' || (Number(code) !== 0 && Number(code) !== 143));
      this.seen.delete(s.id);
      if (!crashed) { s.wantRun = false; this.ctx.settings.save(); this.broadcast({ type: 'games' }); continue; }
      try { await this.dx(['start', this.cname(s)], { timeout: 60000 }); this.seen.add(s.id); this.alert('crash', T('{name} crashed (code {code}) and was restarted (monitor).', { name: s.name, code }), 'warn'); this.broadcast({ type: 'games' }); } catch { /* next round */ }
    }
  }
  /*
   * Update automatically (on by default, can be switched off per server):
   *  - Docker: the LinuxGSM image updates the game on every container start (UPDATE_ON_START) – nothing else needed.
   *  - Native (Linux): "update" every 6 h – only when the server is stopped or nobody plays (Steam query: 0 players).
   *    LinuxGSM checks itself whether there is something new and starts a running server again afterwards.
   */
  async updateTick() {
    if (!IS_LINUX) return;
    for (const s of this.list()) {
      if (s.autoUpdate === false || !s.installed || this.isDocker(s) || this.isSteam(s)) continue; // Steam servers update on start
      const running = await this.running(s).catch(() => false);
      if (running) { s.running = true; const live = await this.live(s).catch(() => null); if (!live || live.players > 0) continue; }
      try { await this.run(s.id, 'update').promise; } catch { /* next round */ }
    }
  }
  /** "Start with Hostwerk": native at start, Docker servers once the engine is ready (Hostwerk calls it again then). */
  async startAutostart({ docker = false } = {}) {
    for (const s of this.list()) {
      if (!s.autostart || !s.installed) continue;
      if (this.isSteam(s) && !this.isDocker(s)) { if (!docker) this.run(s.id, 'start').promise.catch(() => {}); continue; }
      if (this.isDocker(s)) { if (docker && (await this.dockerAvailable()) && !(await this.running(s).catch(() => true))) this.run(s.id, 'start').promise.catch(() => {}); }
      else if (IS_LINUX && !docker) this.run(s.id, 'start').promise.catch(() => {});
    }
  }

  /* ---------- live info (Steam query) ---------- */
  /** Unique display name: "Garry's Mod", "Garry's Mod 2", … */
  uniqueName(name) { const taken = new Set(this.list().map((x) => x.name)); if (!taken.has(name)) return name; for (let i = 2; ; i++) { const n = `${name.slice(0, 56)} ${i}`; if (!taken.has(n)) return n; } }
  rememberGameName(s) { this.games().then((list) => { const g = list.find((x) => x.game === s.game); if (g && s.gameName !== g.name) { s.gameName = g.name; s.short = g.short; this.ctx.settings.save(); } }).catch(() => {}); }
  /** Ports from "details" (LinuxGSM) or from the Docker image. */
  portsOf(s) { return (s.detail && s.detail.ports) || (s.ports || []).map((p) => ({ name: p.name || 'Game', port: p.port, proto: p.proto })); }
  gamePort(s) { const ps = this.portsOf(s); const g = ps.find((p) => /^game|^server|^port$/i.test(p.name)) || ps.find((p) => /UDP/.test(p.proto)) || ps[0]; return g ? g.port : null; }
  /** Candidates for the query port: remembered one, "Query" ports, game port, game port + 1. */
  queryCandidates(s) {
    const ps = this.portsOf(s); const g = this.gamePort(s);
    return [...new Set([s.queryPort, ...ps.filter((p) => /query/i.test(p.name)).map((p) => p.port), g, g && g + 1].filter(Boolean))];
  }
  /** Players, map, version … of the running server – cached for 10 s, a found query port is remembered. */
  async live(s) {
    if (!s.running) return null;
    this.liveCache = this.liveCache || new Map();
    const c = this.liveCache.get(s.id);
    if (c && Date.now() - c.at < (c.v ? 10000 : 60000)) return c.v; // ask less often without an answer
    let v = null;
    const cands = this.queryCandidates(s).slice(0, 4);
    const { queryInfo } = core('a2s');
    const answers = await Promise.all(cands.map((port) => queryInfo('127.0.0.1', port, 700).catch(() => null)));
    const k = answers.findIndex(Boolean);
    if (k >= 0) { v = { ...answers[k], queryPort: cands[k] }; if (s.queryPort !== cands[k]) { s.queryPort = cands[k]; this.ctx.settings.save(); } }
    // Die Steam-Abfrage antwortet → das Spiel läuft, egal was die Ausgabe zuletzt sagte
    const ph = this.phases.get(s.id);
    if (v && ph && ph.result && ph.result.state !== 'ready') { ph.tracker.markReady('query'); ph.result = ph.tracker.result({ health: null }); this.broadcast({ type: 'games' }); }
    // Neue Spielversion (z. B. nach dem automatischen Update) – einmal melden
    if (v && v.version && s.lastVersion !== v.version) { if (s.lastVersion) this.alert('update', T('{name} now runs version {version}.', { name: s.name, version: v.version }), 'info'); s.lastVersion = v.version; this.ctx.settings.save(); }
    this.liveCache.set(s.id, { at: Date.now(), v });
    // No port details yet: read "details" once in the background (LinuxGSM knows the game's ports)
    if (!s.detail && !this.detailBusy && s.installed && !this.isSteam(s) && !PH.isBusy(this.phaseNow(s))) { this.detailBusy = true; this.details(s).catch(() => {}).finally(() => { this.detailBusy = false; }); }
    return v;
  }
  address(s) { const port = this.gamePort(s); return port ? { local: `localhost:${port}`, lan: lanIps().map((ip) => `${ip}:${port}`), port } : null; }
  /** Console command to the running server (LinuxGSM "send", only if the game offers it). */
  async send(s, command) {
    const c = String(command || '').replace(/[\r\n]/g, ' ').trim().slice(0, 300);
    if (!c) throw new Error(T('The command is missing.'));
    this.assertReady(s, 'send');
    if (this.isSteam(s)) return this.steam.send(s, c);
    const list = await this.commandsFor(s);
    if (!list.some((x) => x.cmd === 'send')) throw new Error(T('This game takes no console commands through LinuxGSM.'));
    const r = this.isDocker(s) ? await this.lgsmExec(s, ['send', c], { timeout: 30000 }) : await core('util').exec(this.script(s), ['send', c], { cwd: this.dir(s), env: this.env(), timeout: 30000 });
    if (r.code !== 0) throw new Error(PH.explainFailure(`${r.stdout || ''}\n${r.stderr || ''}`, { T }) || `Code ${r.code}`);
    return { ok: true };
  }

  info(s) {
    const steam = this.isSteam(s);
    const { secret, password, pid, ...pub } = s; // secrets only where the interface needs them (steam.adminPassword / password field)
    return { ...pub, password: steam ? s.password || '' : undefined, method: steam ? 'steam' : 'lgsm', dir: this.isDocker(s) ? `Docker: ${this.cname(s)} (Volume ${this.lgsmVolume(s)})` : this.dir(s), external: !!s.externalDir, script: steam ? null : s.game, commands: COMMANDS, linux: IS_LINUX, docker: this.isDocker(s),
      backups: steam ? this.steam.backups(s).length : !this.isDocker(s) && IS_LINUX ? this.backups(s).length : 0, address: this.address(s), ports: this.portsOf(s),
      links: steam ? steamLinks(s) : guideLinks(s.game, s.gameName || FAVORITES[s.game] || s.name), canSend: steam ? this.steam.canSend(s) : !!(s.cmds && s.cmds.list.some((x) => x.cmd === 'send')),
      steam: steam ? this.steam.info(s) : null, limits: s.limits || null, phase: this.phaseNow(s),
    // „Von außen erreichbar“: geht ab Hostwerk 2.11 (Ports an Firewall/Router); router/auto für den passenden Hinweis
    outside: { supported: !!(this.ctx.security && this.ctx.security.addPortProvider), router: !!this.ctx.router, auto: !!(this.ctx.router && this.ctx.router.cfg && this.ctx.router.cfg.auto) } };
  }
  /** Spieler eines laufenden Servers per Steam-Abfrage (A2S) – für die Seite und andere Erweiterungen (Spieler-Ticker, Bestenliste). */
  async players(s) {
    const live = await this.live(s).catch(() => null);
    return { live, players: live ? (await core('a2s').queryPlayers('127.0.0.1', live.queryPort, 1200).catch(() => null)) || [] : [] };
  }
  /** Alle laufenden Server mit ihren Spielern: [{ id, name, game, players: [{ name, seconds, score }], count, max }] */
  async allPlayers() {
    const out = [];
    for (const s of this.list().filter((x) => x.running)) {
      const p = await this.players(s).catch(() => ({ live: null, players: [] }));
      out.push({ id: s.id, name: s.name, game: s.gameName || s.game, players: p.players.filter((x) => x.name).map((x) => ({ name: x.name, seconds: Math.round(x.seconds || 0), score: x.score || 0 })), count: p.live ? p.live.players : 0, max: p.live ? p.live.maxPlayers : null });
    }
    return out;
  }
  async infoLive(s) { const i = this.info(s); i.live = await this.live(s).catch(() => null); return i; }
  async dockerAvailable() { try { await this.ctx.docker.cli(); return true; } catch { return false; } }
  /** Docker there (CLI or Hostwerk's WSL engine), even if the engine is not running right now. */
  async dockerInstalled() { try { const st = await this.ctx.docker.status(); return !!(st.cli || st.wslAvailable); } catch { return false; } }

  /* ---------- picking a game: pictures, popular first, memory hint, free port ---------- */
  /** What the picture of a server is looked up by (Steam app of the game, server tool, LinuxGSM short name, name). */
  artQuery(s, shape = 'square') {
    return this.isSteam(s) ? { appid: s.appid, game: s.gameAppId, name: s.gameName || s.name, shape } : { short: s.short || String(s.game || '').replace(/server$/, ''), name: s.gameName || FAVORITES[s.game] || s.game, shape };
  }
  /** Picture addresses for Hostwerk's own icon search (services/icons.js): the one that worked, else the first guesses. */
  iconSources(id) { try { return this.art.known(this.artQuery(this.get(id))).map((url) => ({ url })); } catch { return []; } }
  /** Ports in use by the game servers of this list (all protocols). */
  usedPorts(exceptId = null) {
    const out = new Set();
    for (const s of this.list()) if (s.id !== exceptId) for (const p of this.portsOf(s)) if (Number(p.port)) out.add(Number(p.port));
    return out;
  }
  /** Free main port for a Steam profile (from its default or the wished one): no other game server, no program on it. */
  async suggestPort({ appid, port } = {}) {
    const p = SG.profileFor(appid);
    const base = Number(port) >= 1024 && Number(port) <= 65535 ? Number(port) : p ? p.port : null;
    if (!base) return { port: null };
    const offsets = GI.portOffsets(appid, base);
    const r = await GI.suggestPort({ base, offsets, used: this.usedPorts(), isFree: process.env.HW_TEST ? async () => true : GI.portFree });
    return { ...r, base, offsets, ports: SG.portsFor({ appid: Number(appid), port: r.port }) };
  }

  /* ---------- import: game servers that already exist on this PC ---------- */
  /** Folders Hostwerk manages already – left out of the search. */
  managedDirs() { return [this.root, path.join(this.dataDir, 'steamcmd'), ...this.list().filter((s) => !this.isDocker(s)).map((s) => this.dir(s))]; }
  /**
   * Search (read only): Steam libraries, SteamCMD folders, LinuxGSM instances, Docker containers of game server images
   * and optionally one folder. Details the interface does not need (passwords, start lines) stay here (lastScan).
   */
  async scanImport({ folder = null } = {}) {
    let dir = null;
    if (folder) {
      dir = path.resolve(String(folder).trim());
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw Object.assign(new Error(T('This folder does not exist.')), { status: 400 });
    }
    const { items, places } = await IM.scanPlaces({ folder: dir, exec: (c, a, o) => core('util').exec(c, a, o), managed: this.managedDirs(), ...(this.scanRoots ? { roots: this.scanRoots } : {}) });
    const platform = hostPlatform();
    const found = items.map((it) => this.importItem(it, platform)).filter(Boolean);
    const docker = await this.scanDocker().catch(() => ({ items: [], available: false }));
    found.push(...docker.items);
    this.lastScan = new Map(found.map((x) => [x.key, x]));
    return { items: found.map(publicItem), places, docker: docker.available, folder: dir, scannedAt: Date.now(), linux: IS_LINUX };
  }
  /** Found folder → entry for the interface (+ hidden details for the import itself). */
  importItem(it, platform) {
    const key = crypto.createHash('sha1').update(`${it.appid || it.script}|${path.resolve(it.dir)}`).digest('hex').slice(0, 12);
    if (it.script) {
      const v = it.values || {};
      const reason = IS_LINUX ? null : 'linux';
      return { key, kind: 'lgsm', source: it.source, script: it.script, short: it.script.replace(/server$/, ''), name: FAVORITES[it.script] || it.script, dir: it.dir, installed: it.installed,
        values: { port: v.port || null, name: v.name || null, maxPlayers: v.maxPlayers || null, hasPassword: !!v.password }, canInPlace: !reason, canCopy: !reason, reason, ram: GI.ramHint({ game: it.script }) };
    }
    const p = SG.profileFor(it.appid);
    const exe = it.exe || (p ? (platform === 'linux' ? p.linux : p.win) : null);
    const start = IM.startScript(it.dir, { exe });
    // Runs here? The files are there already – so a tool that needs a Steam login counts (only updates would need it)
    const plan = planFor({ appid: it.appid, win: p ? !!p.win : null, linux: p ? !!p.linux : null }, platform);
    const native = plan.ok && plan.mode === 'native';
    const v = (start && start.values) || {};
    const updates = it.login ? 'login' : it.client ? 'client' : it.manifestInside ? 'steamcmd' : 'manual';
    return { key, kind: 'steam', source: it.source, appid: it.appid, game: it.game || null, name: p ? p.name : gameNameOf(it.name) || it.name, tool: it.name, dir: it.dir, size: it.size || null, profile: !!p,
      start: start ? { script: start.script, exe: start.exe, line: start.args !== null && !!start.exe } : null,
      values: { port: v.port || null, name: v.name || null, maxPlayers: v.maxPlayers || null, hasPassword: !!v.password }, updates,
      canInPlace: native, canCopy: native, reason: native ? null : plan.reason === 'windows-only' ? 'windows-only' : 'system', ram: GI.ramHint({ appid: it.appid }),
      _start: start, _exe: exe };
  }
  /** Docker containers of game server images (only when the engine runs – it is never started for this). */
  async scanDocker() {
    if (!(await this.dockerAvailable())) return { items: [], available: false };
    const r = await this.dx(['ps', '-a', '--no-trunc', '--format', '{{json .}}'], { ok: true, timeout: 20000 });
    if (r.code !== 0) return { items: [], available: false };
    const mine = new Set(this.list().filter((s) => this.isDocker(s)).map((s) => this.cname(s)));
    const rows = String(r.stdout || '').split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
      .filter((c) => IM.dockerGameImage(c.Image) && !mine.has(String(c.Names || '').split(',')[0]));
    if (!rows.length) return { items: [], available: true };
    const ins = await this.dx(['inspect', ...rows.map((c) => c.ID)], { ok: true, timeout: 30000 });
    let det = []; try { det = JSON.parse(ins.stdout || '[]'); } catch { /* none */ }
    return { available: true, items: rows.map((c) => IM.dockerItem(c, det.find((d) => String(d.Id || '').startsWith(String(c.ID))) || null)).filter(Boolean) };
  }
  /**
   * Take over a found server – in place (nothing moves; the folder or container stays where it is) or as a copy into
   * Hostwerk's folder (job with progress; the original stays untouched). Nothing is changed before this call.
   */
  async adopt(b = {}) {
    const key = String(b.key || '');
    let it = this.lastScan.get(key);
    if (!it) { await this.scanImport({ folder: b.folder || null }); it = this.lastScan.get(key); }
    if (!it) throw Object.assign(new Error(T('This server is not there any more – search again.')), { status: 404 });
    const mode = b.mode === 'copy' ? 'copy' : 'inplace';
    if (mode === 'copy' ? !it.canCopy : !it.canInPlace) throw Object.assign(new Error(importReason(it)), { status: 400 });
    if (it.dir && this.list().some((s) => !this.isDocker(s) && IM.same(this.dir(s), it.dir))) throw Object.assign(new Error(T('Hostwerk manages this folder already.')), { status: 409 });
    const name = this.uniqueName(String(b.name || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 60) || String(it.values && it.values.name || it.name).slice(0, 60));
    const hex = crypto.randomBytes(2).toString('hex');
    let s;
    if (it.kind === 'steam') s = this.steamFromImport(it, name, `s${it.appid}-${hex}`, mode);
    else if (it.kind === 'lgsm') s = { id: `${it.short}-${hex}`, game: it.script, name, createdAt: Date.now(), installed: !!it.installed, autostart: false, monitor: true };
    else s = { id: `${it.short}-${hex}`, game: it.script, name, createdAt: Date.now(), installed: true, autostart: false, monitor: true, mode: 'docker', container: it.container, volume: it.volume, ports: it.ports || [], portsCustom: true, wantRun: !!it.running };
    s.imported = { from: it.source, mode, at: Date.now(), dir: it.dir || null, container: it.container || null };
    if (mode === 'inplace' && it.kind !== 'docker') s.externalDir = path.resolve(it.dir);
    if (mode === 'copy') s.installed = false;
    if (it.kind !== 'steam') this.rememberGameName(s);
    this.list().push(s);
    this.ctx.settings.save();
    this.lastScan.delete(key);
    this.broadcast({ type: 'games' });
    if (mode === 'copy') return { id: s.id, job: this.copyJob(s, it.dir).id };
    await this.refresh(s).catch(() => {});
    return { id: s.id };
  }
  /** Steam server entry from a found folder – starts exactly as before (start line of its script) where one was found. */
  steamFromImport(it, name, id, mode) {
    const p = SG.profileFor(it.appid);
    const st = it._start || null;
    const v = (st && st.values) || {};
    const s = {
      id, kind: 'steam', appid: it.appid, game: `steam-${it.appid}`, gameName: it.name, gameAppId: it.game || (p && p.game) || null, name, createdAt: Date.now(),
      installed: true, installedAt: Date.now(), autostart: false, monitor: true, mode: 'native', platform: hostPlatform(),
      // Updates through Hostwerk's SteamCMD only where that does not fight the Steam client or reload everything
      autoUpdate: it.updates === 'steamcmd' || (mode === 'copy' && it.updates !== 'login'),
      port: v.port || (p && p.port) || 27015, maxPlayers: v.maxPlayers || (p && p.maxPlayers) || 16,
      password: v.password && /^[^\s"'`$\\]{1,40}$/.test(v.password) ? v.password : '',
      secret: crypto.randomBytes(8).toString('hex'), extraArgs: '', custom: null, saves: null, backupKeep: 10,
    };
    if (st && st.exe && st.args !== null) s.custom = { exe: st.exe, args: st.args };
    else if (!p) s.custom = { exe: (st && st.exe) || '', args: '' };
    const savedir = st && st.args ? (st.args.match(/-savedir\s+"?([^"\s]+)/i) || [])[1] : null;
    for (const c of [savedir, p && p.saves]) {
      if (!c) continue;
      try { if (fs.existsSync(safeRel(it.dir, c))) { s.saves = c; break; } } catch { /* outside → not used */ }
    }
    s.ports = SG.portsFor(s);
    return s;
  }
  /** Copy a found folder into Hostwerk's folder (job). If it fails, the half copy and the entry go again – the original stays. */
  copyJob(s, src) {
    const { fmtBytes } = core('download');
    return core('jobs').runJob(T('Copy “{name}” into Hostwerk', { name: s.name }), async (job) => {
      const dest = path.join(this.root, s.id);
      try {
        job.progress(2, T('Measuring the folder …'));
        const size = await IM.folderSize(src);
        fs.mkdirSync(this.root, { recursive: true });
        const free = IM.freeSpace(this.root);
        if (free !== null && free < size.bytes * 1.05 + 100 * 1048576) throw new Error(T('Not enough free space: {need} needed, {free} free.', { need: fmtBytes(size.bytes), free: fmtBytes(free) }));
        let stop = false;
        if (typeof job.onCancel === 'function') job.onCancel(() => { stop = true; });
        await IM.copyTree(src, dest, { total: size.bytes, cancelled: () => stop, onProgress: (d, t) => job.progress(5 + 90 * (t ? Math.min(1, d / t) : 1), T('Copying … {done} of {total}', { done: fmtBytes(d), total: fmtBytes(t) })) });
        s.installed = true;
        this.ctx.settings.save();
        this.broadcast({ type: 'games' });
        return { id: s.id, bytes: size.bytes };
      } catch (e) {
        fs.rmSync(dest, { recursive: true, force: true });
        this.cfg.servers = this.list().filter((x) => x.id !== s.id);
        this.ctx.settings.save();
        this.broadcast({ type: 'games' });
        throw e;
      }
    }, { key: 'game-create-' + s.id });
  }

  /** Short list for Hostwerk's overview (dashboard, phone). */
  summary() { return this.list().map((g) => { const ph = this.phaseNow(g); return { id: g.id, name: g.name, game: g.gameName || g.game, running: !!g.running, docker: g.mode === 'docker', method: g.kind === 'steam' ? 'steam' : 'lgsm', phase: ph ? { state: ph.state, pct: ph.pct, text: ph.text } : null }; }); }

  routes(r) {
    r.get('/games', async (req, res) => {
      const docker = await this.dockerAvailable(); const dockerInstalled = docker || await this.dockerInstalled();
      for (const s of this.list()) { if ((this.isSteam(s) && !this.isDocker(s)) || IS_LINUX || (docker && this.isDocker(s))) await this.refresh(s).catch(() => {}); else if (this.isDocker(s)) s.running = false; } // engine off → containers cannot run (no stale state)
      for (const s of this.list()) if (!s.gameName) this.rememberGameName(s);
      res.json({ linux: IS_LINUX, docker, dockerInstalled, servers: await Promise.all(this.list().map((s) => this.infoLive(s))), requirements: await this.requirements().catch(() => null) });
    });
    r.get('/games/catalog', async (req, res) => {
      const games = (await this.games()).map((g) => ({ ...g, popular: GI.popularRank(GI.POPULAR_LGSM, g.game), ram: GI.ramHint({ game: g.game }) }));
      res.json({ games, favorites: FAVORITES, linux: IS_LINUX });
    });
    r.get('/games/quick-picks', async (req, res) => res.json(await this.quickPicks()));
    // Steam server tools: one page per request, searched here (the list itself stays on the server)
    r.get('/games/steam/apps', (req, res) => {
      const platform = hostPlatform();
      // Filters: ready = ready-made start, native = runs on this PC without Docker
      const f = String(req.query.filter || '');
      const filter = f === 'ready' ? (x) => x.profile : f === 'native' ? (x) => { const pl = planFor(x, platform); return pl.ok && !pl.needsDocker; } : null;
      const out = this.apps.search({ q: req.query.q, offset: req.query.offset, limit: req.query.limit, popular: GI.POPULAR_STEAM, filter });
      out.items = out.items.map((x) => { const plan = planFor(x, platform); return { ...x, popular: GI.popularRank(GI.POPULAR_STEAM, x.appid) !== null, ram: GI.ramHint({ appid: x.appid }), plan: plan.ok ? { mode: plan.mode, needsDocker: plan.needsDocker, custom: plan.custom, docker: this.steam.canDocker(x, platform) } : { reason: plan.reason } }; });
      res.json(out);
    });
    r.get('/games/ports/suggest', async (req, res) => res.json(await this.suggestPort({ appid: req.query.appid, port: req.query.port })));
    r.get('/games/import/scan', async (req, res) => res.json(await this.scanImport()));
    r.post('/games/import/scan', async (req, res) => res.json(await this.scanImport({ folder: (req.body || {}).folder || null })));
    r.post('/games/import', async (req, res) => res.json(await this.adopt(req.body || {})));
    r.post('/games/steam/apps/refresh', async (req, res) => { await this.apps.refresh({ force: !!(req.body || {}).force }); res.json(this.apps.state()); });
    r.post('/games', async (req, res) => res.json(await this.setup(req.body || {})));
    r.get('/games/:id', async (req, res) => { const s = this.get(req.params.id); if (this.isDocker(s) && !(await this.dockerAvailable())) s.running = false; else if (this.isSteam(s) || IS_LINUX || this.isDocker(s)) await this.refresh(s).catch(() => {}); res.json(await this.infoLive(s)); });
    r.get('/games/:id/quick', async (req, res) => { const s = this.get(req.params.id); res.json(this.isSteam(s) ? { steam: true } : await this.quickGet(s)); });
    r.put('/games/:id/quick', async (req, res) => { const s = this.get(req.params.id); res.json(this.isSteam(s) ? this.steamSet(s, req.body || {}) : await this.quickSet(s, req.body || {})); });
    r.put('/games/:id/limits', async (req, res) => res.json(await this.setLimits(this.get(req.params.id), req.body || {})));
    r.get('/games/:id/textfile', async (req, res) => { const s = this.get(req.params.id); if (!this.isSteam(s)) throw Object.assign(new Error(T('Only for Steam servers – LinuxGSM uses its .cfg.')), { status: 400 }); res.json(await this.steam.readText(s, req.query.path)); });
    r.put('/games/:id/textfile', async (req, res) => { const s = this.get(req.params.id); if (!this.isSteam(s)) throw Object.assign(new Error(T('Only for Steam servers – LinuxGSM uses its .cfg.')), { status: 400 }); res.json(await this.steam.writeText(s, (req.body || {}).path, (req.body || {}).content)); });
    r.post('/games/:id/backups/:file/restore', async (req, res) => { const s = this.get(req.params.id); if (!this.isSteam(s)) throw Object.assign(new Error(T('Restoring LinuxGSM backups: see the LinuxGSM guide (the archive holds the whole server).')), { status: 400 }); res.json(await this.steam.restore(s, req.params.file)); });
    r.get('/games/:id/players', async (req, res) => res.json(await this.players(this.get(req.params.id))));
    r.post('/games/:id/send', async (req, res) => res.json(await this.send(this.get(req.params.id), (req.body || {}).command)));
    r.delete('/games/:id/backups/:file', (req, res) => { const s = this.get(req.params.id); const f = path.basename(req.params.file); if (!(this.isSteam(s) ? /\.(zip|tar\.gz)$/ : /\.tar\.gz$/).test(f)) throw new Error(T('Not a backup')); fs.rmSync(path.join(this.dir(s), 'backups', f), { force: true }); res.json({ ok: true }); });
    r.put('/games/:id', (req, res) => { const s = this.get(req.params.id); const b = req.body || {}; if (typeof b.name === 'string' && b.name.trim()) s.name = b.name.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 60); for (const k of ['autostart', 'monitor', 'autoUpdate', 'public']) if (typeof b[k] === 'boolean') s[k] = b[k]; this.ctx.settings.save(); if (typeof b.public === 'boolean') this.portsChanged(); res.json(this.info(s)); });
    r.delete('/games/:id', async (req, res) => { await this.remove(req.params.id, { files: req.query.files === '1' }); res.json({ ok: true }); });
    r.get('/games/:id/commands', async (req, res) => res.json(await this.commandsFor(this.get(req.params.id), { fresh: req.query.fresh === '1' })));
    r.get('/games/:id/console', async (req, res) => { const s = this.get(req.params.id); res.json({ lines: await this.consoleLogAsync(s, Number(req.query.n) || 300, { raw: req.query.raw === '1' }), phase: this.phaseNow(s) }); });
    r.get('/games/:id/config', async (req, res) => res.json(await this.configAsync(this.get(req.params.id))));
    r.put('/games/:id/config', async (req, res) => res.json(await this.setConfigAsync(this.get(req.params.id), (req.body || {}).content || '')));
    r.get('/games/:id/details', async (req, res) => res.json(await this.details(this.get(req.params.id))));
    r.get('/games/:id/backups', (req, res) => { const s = this.get(req.params.id); res.json(this.isDocker(s) ? [] : this.backups(s)); });
    r.post('/games/:id/:command', async (req, res) => {
      const s = this.get(req.params.id);
      if (!/^(stop|kill)$/.test(req.params.command)) await this.needDocker(s);
      // Frischer Zustand vor Pflege-Befehlen: läuft im Container noch die Installation, gleich eine klare Antwort
      if (this.isDocker(s) && !this.isSteam(s) && !PH.ALLOWED_WHILE_BUSY.test(req.params.command) && (await this.dockerAvailable())) await this.refresh(s).catch(() => {});
      res.json({ job: this.run(req.params.id, req.params.command, (req.body || {}).args).id });
    });
  }
}

/** Nutzer für „docker exec“: Config.User oder USER des Images – nie root (LinuxGSM verweigert root), Rückfall linuxgsm. */
function execUserOf(cfg) {
  const ok = (u) => !!u && /^([a-z_][a-z0-9_.-]{0,31}|\d{1,10})(:[a-z0-9_.-]{1,32})?$/i.test(u) && !/^(root|0)(:|$)/i.test(u);
  const env = Object.fromEntries(((cfg && cfg.Env) || []).map((e) => { const i = String(e).indexOf('='); return [String(e).slice(0, i), String(e).slice(i + 1)]; }));
  if (ok(cfg && cfg.User)) return cfg.User;
  if (ok(env.USER)) return env.USER;
  return 'linuxgsm';
}

/** Guides for a Steam server tool – built from the app ids only (no list of links to keep up to date). */
function steamLinks(s) {
  const q = encodeURIComponent(s.gameName || s.name);
  return [
    { id: 'steamdb', label: 'SteamDB', text: 'The server tool: depots, launch options, size', url: `https://steamdb.info/app/${Number(s.appid)}/` },
    { id: 'steam', label: 'Steam', text: 'The game in the Steam store', url: s.gameAppId ? `https://store.steampowered.com/app/${Number(s.gameAppId)}/` : `https://store.steampowered.com/search/?term=${q}` },
    { id: 'wiki', label: 'PCGamingWiki', text: 'Technical info, ports and server notes', url: `https://www.pcgamingwiki.com/w/index.php?search=${q}` },
    { id: 'guide', label: 'Guide: dedicated server', text: 'Web search for guides for this game', url: `https://duckduckgo.com/?q=${encodeURIComponent(`${s.gameName || s.name} dedicated server guide`)}` },
  ];
}

/** Commands from LinuxGSM's help output: "start  st | Start the server." */
function parseCommands(out) {
  const list = [];
  for (const line of String(out || '').replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').split('\n')) {
    const m = line.match(/^\s*([a-z][a-z0-9-]{1,30})\s+([a-z]{1,4})?\s*\|\s*(.+?)\s*$/);
    if (m && !list.some((x) => x.cmd === m[1])) list.push({ cmd: m[1], short: m[2] || null, desc: m[3] });
  }
  return list;
}
/** Ports and key/value lines from LinuxGSM "details". */
function parseDetails(raw) {
  const text = String(raw || '').replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
  const ports = [...text.matchAll(/^\s*>?\s*([A-Za-z ]+?)\s+(\d{2,5})\s+(tcp|udp|tcp\/udp|udp\/tcp)/gmi)].map((m) => ({ name: m[1].trim(), port: Number(m[2]), proto: m[3].toUpperCase() }));
  const info = {}; for (const m of text.matchAll(/^([A-Za-z][A-Za-z ]{2,30}):\s+(.+)$/gm)) info[m[1].trim()] = m[2].trim();
  return { text, ports, info };
}

/** Found server for the interface: without the details that stay on the server (start line, password). */
function publicItem(it) { return Object.fromEntries(Object.entries(it).filter(([k]) => !k.startsWith('_'))); }
/** Why a found server can not be taken over (this way). */
function importReason(it) {
  if (it.reason === 'linux') return T('LinuxGSM servers can only be taken over on Linux.');
  if (it.reason === 'windows-only') return T('This server tool only exists for Windows.');
  if (it.reason === 'docker-other') return T('This container does not come from LinuxGSM – manage it on the Docker page.');
  if (it.reason === 'no-volume') return T('The container keeps its data inside itself (no volume) – Hostwerk could not create it anew without losing them.');
  return T('This server tool does not run on this system.');
}

module.exports = { GameServers, execUserOf, publicItem, importReason, COMMANDS, FAVORITES, IS_LINUX, PICKS, pickFor, parseCommands, parseDetails, guideLinks, steamLinks, parseShellVars, setShellVars, cleanLimits, LGSM_KEYS };
