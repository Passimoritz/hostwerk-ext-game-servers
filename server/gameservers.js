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
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

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

class GameServers {
  constructor(host) {
    H = host;
    this.ctx = host.ctx;
    core('jobs').registerResumer('game-setup', (p) => { const s = this.get(p.id); return this.isDocker(s) ? this.setupDockerJob(s) : this.setupNativeJob(s); }); // continue after a crash
    this.root = path.join(this.ctx.paths.base, 'spiele');
    this.timers = [];
    if (!process.env.HW_TEST) {
      this.timers.push(setInterval(() => this.monitorTick().catch(() => {}), IS_LINUX ? 5 * 60000 : 60000));
      this.timers.push(setInterval(() => this.updateTick().catch(() => {}), 6 * 3600e3));
      for (const t of this.timers) if (t.unref) t.unref();
    }
  }
  stop() { for (const t of this.timers) clearInterval(t); this.timers = []; }
  broadcast(msg) { H.broadcast(msg); }
  get cfg() { const s = this.ctx.settings.get(); if (!s.games) s.games = { servers: [] }; return s.games; }
  list() { return this.cfg.servers; }
  get(id) { const s = this.list().find((x) => x.id === id); if (!s) throw Object.assign(new Error(T('Game server not found')), { status: 404 }); return s; }
  dir(s) { return path.join(this.root, s.id); }
  script(s) { return path.join(this.dir(s), s.game); }
  /** Docker mode (Windows/everywhere): official LinuxGSM image, one container per server, data in the volume. */
  isDocker(s) { return s.mode === 'docker'; }
  cname(s) { return `hostwerk-game-${s.id}`; }
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
      s.ports = ports; s.restartFixed = true; this.ctx.settings.save();
      const pub = ports.flatMap((p) => ['-p', `${p.port}:${p.port}/${p.proto.toLowerCase()}`]);
      job.progress(60, T('Creating the container …'));
      await this.dx(['rm', '-f', this.cname(s)], { ok: true });
      // No Docker restart policy: otherwise Docker starts the server on every engine start by itself – no matter what
      // "Start with Hostwerk" says. Starting with Hostwerk and restarting after a crash is done by Hostwerk itself.
      await this.dx(['create', '--name', this.cname(s), '--restart', 'no', '-v', `hw-game-${s.id}:/data`, '-e', 'UPDATE_ON_START=1', '-e', `LGSM_GAMESERVER=${s.game}`, ...pub, image], { timeout: 120000 });
      if (autoInstall) { job.progress(70, T('Starting the container – it installs the game on the first start (SteamCMD, can take long) …')); await this.dx(['start', this.cname(s)]); }
      s.installed = true; this.ctx.settings.save(); this.broadcast({ type: 'games' });
      job.log(T('Ports: {ports} – the installation progress is in the console.', { ports: ports.map((p) => `${p.port}/${p.proto}`).join(', ') || T('none found') }));
      return { id, ports };
    }, { key: 'game-create-' + id, resume: { kind: 'game-setup', params: { id } } });
  }
  env() { return { ...process.env, LGSM_GITHUBUSER: 'GameServerManagers', TERM: 'xterm', LANG: 'C.UTF-8', HOME: process.env.HOME || os.homedir(), CI: '1' }; }

  runInJob(job, s, args, opts = {}) { return this.ctx.devtools.runInJob(job, this.script(s), args, { cwd: this.dir(s), env: this.env(), noInput: true, idleMs: opts.idleMs || 10 * 60000 }); }

  /**
   * Available LinuxGSM commands of this server – read from the script's help ("start  st | Start the server.").
   * So game-specific commands (e.g. wipe for Rust, mods-install, fastdl, map-compressor) show up by themselves.
   * Cached for 6 h; fresh after "Update LinuxGSM".
   */
  async commandsFor(s, { fresh = false } = {}) {
    if (!fresh && s.cmds && Date.now() - s.cmds.at < 6 * 3600e3) return s.cmds.list;
    let out = '';
    try {
      if (this.isDocker(s)) { const r = await this.dx(['exec', this.cname(s), `./${s.game}`], { ok: true, timeout: 30000 }); out = r.stdout + r.stderr; }
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

  run(id, command, extra = []) {
    const s = this.get(id);
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
      if (r.code !== 0 && r.code !== 'hang' && !/details|check-update|monitor/.test(command)) throw Object.assign(new Error(T('{what} reports code {code}: {msg}', { what: this.label(command), code: r.code, msg: out.trim().split('\n').filter(Boolean).pop() || '' })), { output: out.slice(-3000) });
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
      if (command === 'start') { await this.dx(['start', c]); await this.refresh(s); this.broadcast({ type: 'games' }); return { ok: true, text: T('Container started (LinuxGSM starts the server inside).') }; }
      if (command === 'stop') {
        await this.dx(['exec', c, `./${s.game}`, 'stop'], { ok: true, timeout: 120000 });
        await this.dx(['stop', '-t', '30', c], { timeout: 90000 });
        // Only report "stopped" once the container is really off – otherwise say so honestly and offer to force it
        if (await this.running(s).catch(() => false)) throw Object.assign(new Error(T('The server is still running – “Force” ends it right away.')), { canKill: true });
        await this.refresh(s); this.broadcast({ type: 'games' });
        return { ok: true, text: T('Stopped.') };
      }
      const r = await this.dx(['exec', c, `./${s.game}`, command, ...safeExtra], { ok: true, timeout: /update|install|validate|backup/.test(command) ? 30 * 60000 : 5 * 60000 });
      const out = (r.stdout + '\n' + r.stderr).replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
      for (const l of out.split('\n').filter(Boolean).slice(-60)) job.log(l);
      await this.refresh(s); this.broadcast({ type: 'games' });
      if (r.code !== 0 && !/details|check-update|monitor/.test(command)) throw Object.assign(new Error(T('{what} reports code {code}', { what: this.label(command), code: r.code })), { output: out.slice(-3000) });
      return { ok: true, output: out.slice(-6000), text: out.trim().split('\n').filter(Boolean).pop() || 'ok' };
    }, { key: `game-${s.id}-${command}` });
  }

  /* ---------- state ---------- */
  /** Older containers (created with --restart unless-stopped) are switched to "no policy" once. */
  async fixRestartPolicy(s) {
    if (!this.isDocker(s) || s.restartFixed) return;
    const r = await this.dx(['update', '--restart=no', this.cname(s)], { ok: true, timeout: 20000 });
    if (r.code === 0) { s.restartFixed = true; this.ctx.settings.save(); }
  }
  async running(s) {
    if (this.isDocker(s)) await this.fixRestartPolicy(s).catch(() => {});
    if (this.isDocker(s)) { const r = await this.dx(['inspect', '--format', '{{.State.Running}}', this.cname(s)], { ok: true, timeout: 15000 }); return r.stdout.trim() === 'true'; }
    // LinuxGSM starts the game in a tmux session named like the script
    const r = await core('util').exec('tmux', ['has-session', '-t', s.game], { env: this.env() });
    return r.code === 0;
  }
  async refresh(s) {
    try { s.running = await this.running(s); } catch { s.running = false; }
    return s.running;
  }
  async consoleLogAsync(s, n = 300) {
    if (this.isDocker(s)) { const r = await this.dx(['logs', '--tail', String(n), this.cname(s)], { ok: true, timeout: 20000 }); return (r.stdout + r.stderr).replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').split('\n').filter(Boolean); }
    return this.consoleLog(s, n);
  }
  consoleLog(s, n = 300) {
    const dir = path.join(this.dir(s), 'log', 'console');
    if (!fs.existsSync(dir)) return [];
    const files = fs.readdirSync(dir).filter((f) => /-console\.log$/.test(f)).map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
    return files[0] ? core('util').readLastLines(path.join(dir, files[0].f), n) : [];
  }
  async configAsync(s) {
    if (!this.isDocker(s)) return this.config(s);
    const rel = `/data/config-lgsm/${s.game}/${s.game}.cfg`;
    const r = await this.dx(['exec', this.cname(s), 'cat', rel], { ok: true });
    const d = await this.dx(['exec', this.cname(s), 'cat', `/data/config-lgsm/${s.game}/_default.cfg`], { ok: true });
    return { file: rel, content: r.code === 0 ? r.stdout : '', defaults: (d.stdout || '').slice(0, 60000) };
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
    let r;
    if (this.isDocker(s)) r = await this.dx(['exec', this.cname(s), `./${s.game}`, 'details'], { ok: true, timeout: 60000 });
    else { this.requireLinux(); r = await core('util').exec(this.script(s), ['details'], { cwd: this.dir(s), env: this.env(), timeout: 60000 }); }
    const { text, ports, info } = parseDetails(r.stdout + r.stderr);
    if (ports.length) { s.detail = { ports, at: Date.now() }; s.queryPort = null; this.ctx.settings.save(); }
    return { text, ports, info };
  }
  backups(s) { const d = path.join(this.dir(s), 'backups'); if (!fs.existsSync(d)) return []; return fs.readdirSync(d).filter((f) => /\.tar\.gz$/.test(f)).map((f) => { const st = fs.statSync(path.join(d, f)); return { file: f, size: st.size, time: st.mtimeMs }; }).sort((a, b) => b.time - a.time); }
  async remove(id, { files = false } = {}) {
    const s = this.get(id);
    if (this.isDocker(s)) { await this.dx(['rm', '-f', this.cname(s)], { ok: true }); if (files) await this.dx(['volume', 'rm', `hw-game-${s.id}`], { ok: true }); }
    else if (IS_LINUX && (await this.running(s))) await this.run(id, 'stop').promise.catch(() => {});
    this.cfg.servers = this.list().filter((x) => x.id !== id);
    this.ctx.settings.save();
    if (files) fs.rmSync(this.dir(s), { recursive: true, force: true });
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
      if (!this.isDocker(s)) { if (IS_LINUX) { try { await this.run(s.id, 'monitor').promise; } catch { /* reports itself */ } } continue; }
      if (!s.wantRun || !(await this.dockerAvailable())) continue;
      /*
       * Only restart real crashes: the container must have been seen running in THIS Hostwerk session and must have ended
       * with an error (exit code ≠ 0 or killed for memory). Whoever stops it outside, restarts Docker or restarts Hostwerk
       * does not get a server that starts "by itself".
       */
      const st = await this.dx(['inspect', '--format', '{{.State.Running}}|{{.State.ExitCode}}|{{.State.OOMKilled}}', this.cname(s)], { ok: true, timeout: 20000 });
      const [run, code, oom] = st.stdout.trim().split('|');
      this.seen = this.seen || new Set();
      if (st.code !== 0) continue;
      if (run === 'true') { this.seen.add(s.id); continue; }
      const crashed = this.seen.has(s.id) && (oom === 'true' || (Number(code) !== 0 && Number(code) !== 143));
      this.seen.delete(s.id);
      if (!crashed) { s.wantRun = false; this.ctx.settings.save(); this.broadcast({ type: 'games' }); continue; }
      try { await this.dx(['start', this.cname(s)], { timeout: 60000 }); this.seen.add(s.id); this.broadcast({ type: 'toast', kind: 'warn', text: T('{name} crashed (code {code}) and was restarted (monitor).', { name: s.name, code }) }); this.broadcast({ type: 'games' }); } catch { /* next round */ }
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
      if (s.autoUpdate === false || !s.installed || this.isDocker(s)) continue;
      const running = await this.running(s).catch(() => false);
      if (running) { s.running = true; const live = await this.live(s).catch(() => null); if (!live || live.players > 0) continue; }
      try { await this.run(s.id, 'update').promise; } catch { /* next round */ }
    }
  }
  /** "Start with Hostwerk": native at start, Docker servers once the engine is ready (Hostwerk calls it again then). */
  async startAutostart({ docker = false } = {}) {
    for (const s of this.list()) {
      if (!s.autostart || !s.installed) continue;
      if (this.isDocker(s)) { if (docker && (await this.dockerAvailable()) && !(await this.running(s).catch(() => true))) this.run(s.id, 'start').promise.catch(() => {}); }
      else if (IS_LINUX && !docker) this.run(s.id, 'start').promise.catch(() => {});
    }
  }

  /* ---------- live info (Steam query) ---------- */
  /** Unique display name: "Garry's Mod", "Garry's Mod 2", … */
  uniqueName(name) { const taken = new Set(this.list().map((x) => x.name)); if (!taken.has(name)) return name; for (let i = 2; ; i++) { const n = `${name.slice(0, 56)} ${i}`; if (!taken.has(n)) return n; } }
  rememberGameName(s) { this.games().then((list) => { const g = list.find((x) => x.game === s.game); if (g && s.gameName !== g.name) { s.gameName = g.name; s.short = g.short; this.ctx.settings.save(); } }).catch(() => {}); }
  /** Ports from "details" (LinuxGSM) or from the Docker image. */
  portsOf(s) { return (s.detail && s.detail.ports) || (s.ports || []).map((p) => ({ name: 'Game', port: p.port, proto: p.proto })); }
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
    this.liveCache.set(s.id, { at: Date.now(), v });
    // No port details yet: read "details" once in the background (LinuxGSM knows the game's ports)
    if (!s.detail && !this.detailBusy && s.installed) { this.detailBusy = true; this.details(s).catch(() => {}).finally(() => { this.detailBusy = false; }); }
    return v;
  }
  address(s) { const port = this.gamePort(s); return port ? { local: `localhost:${port}`, lan: lanIps().map((ip) => `${ip}:${port}`), port } : null; }
  /** Console command to the running server (LinuxGSM "send", only if the game offers it). */
  async send(s, command) {
    const c = String(command || '').replace(/[\r\n]/g, ' ').trim().slice(0, 300);
    if (!c) throw new Error(T('The command is missing.'));
    const list = await this.commandsFor(s);
    if (!list.some((x) => x.cmd === 'send')) throw new Error(T('This game takes no console commands through LinuxGSM.'));
    const r = this.isDocker(s) ? await this.dx(['exec', this.cname(s), `./${s.game}`, 'send', c], { ok: true, timeout: 30000 }) : await core('util').exec(this.script(s), ['send', c], { cwd: this.dir(s), env: this.env(), timeout: 30000 });
    if (r.code !== 0) throw new Error(((r.stderr || r.stdout || '').replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trim().split('\n').pop()) || `Code ${r.code}`);
    return { ok: true };
  }

  info(s) { return { ...s, dir: this.isDocker(s) ? `Docker: ${this.cname(s)} (Volume hw-game-${s.id})` : this.dir(s), script: s.game, commands: COMMANDS, linux: IS_LINUX, docker: this.isDocker(s), backups: !this.isDocker(s) && IS_LINUX ? this.backups(s).length : 0, address: this.address(s), ports: this.portsOf(s), links: guideLinks(s.game, s.gameName || FAVORITES[s.game] || s.name), canSend: !!(s.cmds && s.cmds.list.some((x) => x.cmd === 'send')) }; }
  async infoLive(s) { const i = this.info(s); i.live = await this.live(s).catch(() => null); return i; }
  async dockerAvailable() { try { await this.ctx.docker.cli(); return true; } catch { return false; } }
  /** Docker there (CLI or Hostwerk's WSL engine), even if the engine is not running right now. */
  async dockerInstalled() { try { const st = await this.ctx.docker.status(); return !!(st.cli || st.wslAvailable); } catch { return false; } }

  /** Short list for Hostwerk's overview (dashboard, phone). */
  summary() { return this.list().map((g) => ({ id: g.id, name: g.name, game: g.gameName || g.game, running: !!g.running, docker: g.mode === 'docker' })); }

  routes(r) {
    r.get('/games', async (req, res) => {
      const docker = await this.dockerAvailable(); const dockerInstalled = docker || await this.dockerInstalled();
      for (const s of this.list()) { if (IS_LINUX || (docker && this.isDocker(s))) await this.refresh(s).catch(() => {}); else if (this.isDocker(s)) s.running = false; } // engine off → containers cannot run (no stale state)
      for (const s of this.list()) if (!s.gameName) this.rememberGameName(s);
      res.json({ linux: IS_LINUX, docker, dockerInstalled, servers: await Promise.all(this.list().map((s) => this.infoLive(s))), requirements: await this.requirements().catch(() => null) });
    });
    r.get('/games/catalog', async (req, res) => res.json({ games: await this.games(), favorites: FAVORITES }));
    r.post('/games', async (req, res) => { if (!IS_LINUX && (req.body || {}).mode !== 'native' && !(await this.dockerInstalled())) throw dockerMissing((req.body || {}).name); res.json({ job: this.create(req.body || {}).id }); });
    r.get('/games/:id', async (req, res) => { const s = this.get(req.params.id); if (this.isDocker(s) && !(await this.dockerAvailable())) s.running = false; else if (IS_LINUX || this.isDocker(s)) await this.refresh(s).catch(() => {}); res.json(await this.infoLive(s)); });
    r.get('/games/:id/players', async (req, res) => { const s = this.get(req.params.id); const live = await this.live(s); res.json({ live, players: live ? (await core('a2s').queryPlayers('127.0.0.1', live.queryPort, 1200).catch(() => null)) || [] : [] }); });
    r.post('/games/:id/send', async (req, res) => res.json(await this.send(this.get(req.params.id), (req.body || {}).command)));
    r.delete('/games/:id/backups/:file', (req, res) => { const s = this.get(req.params.id); const f = path.basename(req.params.file); if (!/\.tar\.gz$/.test(f)) throw new Error(T('Not a backup')); fs.rmSync(path.join(this.dir(s), 'backups', f), { force: true }); res.json({ ok: true }); });
    r.put('/games/:id', (req, res) => { const s = this.get(req.params.id); const b = req.body || {}; if (typeof b.name === 'string') s.name = b.name.slice(0, 60); for (const k of ['autostart', 'monitor', 'autoUpdate']) if (typeof b[k] === 'boolean') s[k] = b[k]; this.ctx.settings.save(); res.json(this.info(s)); });
    r.delete('/games/:id', async (req, res) => { await this.remove(req.params.id, { files: req.query.files === '1' }); res.json({ ok: true }); });
    r.get('/games/:id/commands', async (req, res) => res.json(await this.commandsFor(this.get(req.params.id), { fresh: req.query.fresh === '1' })));
    r.get('/games/:id/console', async (req, res) => res.json({ lines: await this.consoleLogAsync(this.get(req.params.id), Number(req.query.n) || 300) }));
    r.get('/games/:id/config', async (req, res) => res.json(await this.configAsync(this.get(req.params.id))));
    r.put('/games/:id/config', async (req, res) => res.json(await this.setConfigAsync(this.get(req.params.id), (req.body || {}).content || '')));
    r.get('/games/:id/details', async (req, res) => res.json(await this.details(this.get(req.params.id))));
    r.get('/games/:id/backups', (req, res) => { const s = this.get(req.params.id); res.json(this.isDocker(s) ? [] : this.backups(s)); });
    r.post('/games/:id/:command', async (req, res) => { if (!/^(stop|kill)$/.test(req.params.command)) await this.needDocker(this.get(req.params.id)); res.json({ job: this.run(req.params.id, req.params.command, (req.body || {}).args).id }); });
  }
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

module.exports = { GameServers, COMMANDS, FAVORITES, IS_LINUX, parseCommands, parseDetails, guideLinks };
