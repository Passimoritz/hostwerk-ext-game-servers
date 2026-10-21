'use strict';
/*
 * Second method next to LinuxGSM: Steam server tools through SteamCMD.
 *
 *  - SteamCMD itself is downloaded on demand from Valve (the only fixed download addresses) into the extension's data
 *    folder (<data>/game-servers/steamcmd). Installing and updating a server is always
 *    "steamcmd +force_install_dir <folder> +login anonymous +app_update <appid> [validate] +quit" – nothing to maintain.
 *  - Native where the server tool exists for this system (Windows: almost always). If a tool only exists for Linux, it runs
 *    on Windows in a Docker container (image cm2network/steamcmd:root, data in the volume hw-game-<id>, HOME inside the
 *    volume so saves survive a new container).
 *  - Every program is started with an argument ARRAY (no shell); paths from the interface are checked to stay inside
 *    the server folder. Console input goes through Source RCON with a secret only Hostwerk knows.
 * Server folders are the same as for LinuxGSM (<base>/spiele/<id>) – the Files tab and Hostwerk's file browser find them.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');
const G = require('./steamgames');
const { rconExec } = require('./rcon');

const IS_WIN = process.platform === 'win32';
const STEAMCMD_URL = { win32: 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip', linux: 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz' };
const DOCKER_IMAGE = 'cm2network/steamcmd:root';
const TEXT_EXT = /\.(ini|cfg|conf|json|xml|txt|ya?ml|properties|lua|dat|toml|config|sh|bat)$/i;
const MAX_TEXT = 1024 * 1024;
// Texts in the language of the interface – bound to Hostwerk's translator by the first SteamServers instance
let T = (s, v) => (v ? String(s).replace(/\{(\w+)\}/g, (m, k) => (v[k] !== undefined ? String(v[k]) : m)) : s);

function hostPlatform() { return IS_WIN ? 'windows' : process.platform === 'linux' ? 'linux' : null; }

/** Resolve a path from the interface inside base – never outside (no "..", no absolute paths, no drive letters). */
function safeRel(base, rel) {
  const r = String(rel == null ? '' : rel).replace(/\\/g, '/');
  if (!r || r.length > 400 || /\0/.test(r) || r.startsWith('/') || /^[a-zA-Z]:/.test(r) || r.split('/').some((x) => x === '..')) throw Object.assign(new Error(T('Path outside the server folder')), { status: 400 });
  const b = path.resolve(base);
  const full = path.resolve(b, r);
  if (full !== b && !full.startsWith(b + path.sep)) throw Object.assign(new Error(T('Path outside the server folder')), { status: 400 });
  return full;
}
/** Same check for paths inside a Docker container (always POSIX). */
function safeRelPosix(rel) {
  const r = String(rel || '').replace(/\\/g, '/');
  if (!r || r.length > 400 || /\0/.test(r) || r.startsWith('/') || r.split('/').some((x) => x === '..' || x === '')) throw Object.assign(new Error(T('Path outside the server folder')), { status: 400 });
  return r;
}

/** How a server tool runs on this system: natively, as Linux build in Docker, or not at all (reason). */
function planFor(app, platform = hostPlatform()) {
  if (!app) return { ok: false, reason: 'unknown' };
  const p = G.profileFor(app.appid);
  if (app.login) return { ok: false, reason: 'login' };
  const win = p ? !!p.win : app.win; // null = unknown → try natively
  const linux = p ? !!p.linux : app.linux;
  if (platform === 'windows') {
    if (win !== false) return { ok: true, mode: 'native', platform: 'windows', needsDocker: false, custom: !p };
    if (linux) return { ok: true, mode: 'docker', platform: 'linux', needsDocker: true, custom: !p };
  } else if (platform === 'linux') {
    if (linux !== false) return { ok: true, mode: 'native', platform: 'linux', needsDocker: false, custom: !p };
    return { ok: false, reason: 'windows-only' };
  }
  return { ok: false, reason: 'system' };
}

/** SteamCMD output → progress (0–100) and a readable state, or null. */
function parseSteamProgress(line) {
  const m = String(line).match(/Update state \(0x[0-9a-f]+\) ([a-z ]+), progress: ([\d.]+)/i);
  if (m) return { pct: Math.min(100, Number(m[2])), state: m[1].trim() };
  if (/Success! App '\d+' (fully installed|already up to date)/i.test(line)) return { pct: 100, state: 'done' };
  return null;
}
/** Result of a SteamCMD run from its output (SteamCMD often ends with code 0 even after an error). */
function steamResult(out) {
  const text = String(out || '');
  if (/Success! App '\d+' (fully installed|already up to date)/i.test(text)) return { ok: true };
  if (/No subscription|Invalid Password|Login Failure|requires a license/i.test(text)) return { ok: false, login: true, msg: 'This server tool needs a Steam account that owns the game – Hostwerk only installs tools with anonymous login.' };
  if (/0x202|not enough (disk )?space/i.test(text)) return { ok: false, msg: 'Not enough free disk space for this server.' };
  const err = text.split(/\r?\n/).reverse().find((l) => /ERROR!|Error!|FAILED/i.test(l));
  return { ok: false, msg: err ? err.trim().slice(0, 300) : 'SteamCMD ended without “Success”.' };
}
/** Arguments for one SteamCMD install/update run. */
function steamcmdArgs(dir, appid, { validate = false, platform = null } = {}) {
  const id = Number(appid);
  if (!Number.isInteger(id) || id < 1 || id > 99999999) throw new Error('Invalid Steam app id');
  return [...(platform ? ['+@sSteamCmdForcePlatformType', platform] : []), '+force_install_dir', dir, '+login', 'anonymous', '+app_update', String(id), ...(validate ? ['validate'] : []), '+quit'];
}
/** Characters cmd.exe could interpret – a .bat start line may only contain plain values. */
const BAT_SAFE = /^[\w.:=/\\@+,-]+$/;

class SteamServers {
  constructor(gs, host) {
    this.gs = gs;
    this.host = host;
    if (host && typeof host.t === 'function') T = (s, v) => host.t(s, v);
    this.ctx = gs.ctx;
    this.spawn = cp.spawn; // tests replace it
    this.children = new Map(); // id → child process started in this session
    this.restarts = new Map(); // id → [timestamps] (monitor: at most 3 restarts in 30 min)
  }
  T(s, v) { return this.host ? this.host.t(s, v) : s; }
  core(n) { return this.host.core(n); }
  get dataDir() { return this.gs.dataDir; }
  steamcmdExe() { return path.join(this.dataDir, 'steamcmd', IS_WIN ? 'steamcmd.exe' : 'steamcmd.sh'); }
  profile(s) { return G.profileFor(s.appid); }
  isDocker(s) { return s.mode === 'docker'; }
  dir(s) { return this.gs.dir(s); }
  volume(s) { return `hw-game-${s.id}`; }

  /* ---------- create ---------- */
  create(b, app) {
    const appid = Number(b.appid);
    if (!Number.isInteger(appid) || appid < 1 || appid > 99999999) throw Object.assign(new Error(this.T('Invalid Steam app id')), { status: 400 });
    const plan = planFor(app || { appid, win: null, linux: null });
    if (!plan.ok) throw Object.assign(new Error(this.planText(plan)), { status: 400, reason: plan.reason });
    const p = G.profileFor(appid);
    const gameName = p ? p.name : String((app && app.name) || `Steam app ${appid}`).replace(/\s*(dedicated server|server|ds)$/i, '').slice(0, 60);
    const s = {
      id: `s${appid}-${crypto.randomBytes(2).toString('hex')}`, kind: 'steam', appid, game: `steam-${appid}`, gameName, gameAppId: (p && p.game) || (app && app.game) || null,
      name: this.gs.uniqueName(String(b.name || gameName).replace(/[\u0000-\u001f]/g, '').slice(0, 60) || gameName), createdAt: Date.now(),
      installed: false, autostart: false, monitor: true, autoUpdate: true, mode: plan.mode, platform: plan.platform,
      port: (p && p.port) || 27015, maxPlayers: (p && p.maxPlayers) || 16, password: p && p.passwordMin ? crypto.randomBytes(4).toString('hex') : '',
      secret: crypto.randomBytes(8).toString('hex'), extraArgs: '', custom: p ? null : { exe: '', args: '' }, saves: p ? p.saves : null, backupKeep: 10,
    };
    s.ports = G.portsFor(s);
    this.gs.list().push(s);
    this.ctx.settings.save();
    return s;
  }
  planText(plan) {
    return plan.reason === 'login' ? this.T('This server tool needs a Steam account that owns the game – Hostwerk only installs tools with anonymous login.')
      : plan.reason === 'windows-only' ? this.T('This server tool only exists for Windows.')
        : this.T('This server tool does not run on this system.');
  }

  /* ---------- SteamCMD ---------- */
  async ensureSteamCmd(job) {
    const exe = this.steamcmdExe();
    if (fs.existsSync(exe)) return exe;
    const url = STEAMCMD_URL[process.platform];
    if (!url) throw new Error(this.T('SteamCMD does not exist for this system.'));
    const { downloadFile, extractZip } = this.core('download');
    fs.mkdirSync(this.dataDir, { recursive: true });
    const file = path.join(this.dataDir, path.basename(url));
    job && job.progress(3, this.T('Loading SteamCMD from Valve …'));
    await downloadFile(url, file);
    await extractZip(file, path.dirname(exe));
    fs.rmSync(file, { force: true });
    if (!IS_WIN) { try { fs.chmodSync(exe, 0o755); const lin = path.join(path.dirname(exe), 'linux32', 'steamcmd'); if (fs.existsSync(lin)) fs.chmodSync(lin, 0o755); } catch { /* best effort */ } }
    if (!fs.existsSync(exe)) throw new Error(this.T('SteamCMD could not be unpacked.'));
    return exe;
  }
  /** Run SteamCMD (or `docker run … steamcmd`) with live log and progress in the job. */
  runLogged(job, cmd, args, { cwd, from = 10, to = 95, idleMs = 20 * 60000 } = {}) {
    return new Promise((resolve, reject) => {
      let child;
      try { child = this.spawn(cmd, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { reject(e); return; }
      let out = '';
      let idle = null;
      const kick = () => { clearTimeout(idle); idle = setTimeout(() => { job && job.log(this.T('No output for a long time – SteamCMD is ended.')); try { child.kill(); } catch { /* gone */ } }, idleMs); };
      kick();
      const onData = (c) => {
        kick();
        const t = String(c);
        out += t; if (out.length > 300000) out = out.slice(-200000);
        for (const l of t.split(/\r?\n/).map((x) => x.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trim()).filter(Boolean)) {
          job && job.log(l);
          const pr = parseSteamProgress(l);
          if (pr && job) job.progress(from + ((to - from) * pr.pct) / 100, this.T('SteamCMD: {state} {pct} %', { state: pr.state, pct: pr.pct.toFixed(1) }));
        }
      };
      if (child.stdout) child.stdout.on('data', onData);
      if (child.stderr) child.stderr.on('data', onData);
      if (job && job.onCancel) job.onCancel(() => { try { child.kill(); } catch { /* gone */ } });
      child.on('error', (e) => { clearTimeout(idle); reject(e); });
      child.on('close', (code) => { clearTimeout(idle); resolve({ code, out }); });
    });
  }

  /** Install or update (validate = check every file). Runs SteamCMD twice at most – it sometimes fails once after updating itself. */
  async install(job, s, { validate = false } = {}) {
    if (this.isDocker(s)) return this.installDocker(job, s, { validate });
    const exe = await this.ensureSteamCmd(job);
    const dir = this.dir(s);
    fs.mkdirSync(dir, { recursive: true });
    const args = steamcmdArgs(dir, s.appid, { validate });
    let r = null;
    for (let i = 0; i < 2; i++) {
      job && job.progress(8, i ? this.T('SteamCMD again (it updated itself) …') : this.T('SteamCMD loads the server (can take long) …'));
      const x = await this.runLogged(job, exe, args, { cwd: path.dirname(exe) });
      r = steamResult(x.out);
      if (r.ok || r.login) break;
    }
    if (!r.ok) throw Object.assign(new Error(this.T(r.msg)), { login: !!r.login });
    s.installed = true; s.installedAt = Date.now(); this.ctx.settings.save();
    return { ok: true };
  }
  async installDocker(job, s, { validate = false } = {}) {
    await this.gs.dockerReady();
    job && job.progress(4, this.T('Loading image {image} …', { image: DOCKER_IMAGE }));
    await this.ctx.docker.pullInto(job, DOCKER_IMAGE, [4, 10]);
    const c = `hostwerk-steamcmd-${s.id}`;
    await this.gs.dx(['rm', '-f', c], { ok: true });
    const args = ['run', '--rm', '--name', c, '-v', `${this.volume(s)}:/data`, DOCKER_IMAGE, '/home/steam/steamcmd/steamcmd.sh', ...steamcmdArgs('/data/server', s.appid, { validate })];
    let out = '';
    if (typeof this.ctx.docker.sp === 'function') {
      const d = this.ctx.docker;
      const self = this;
      const r = await new Promise((resolve, reject) => {
        Promise.resolve(d.sp(args, { stdio: ['ignore', 'pipe', 'pipe'] })).then((child) => {
          let buf = '';
          const on = (ch) => { const t = String(ch); buf += t; for (const l of t.split(/\r?\n/).filter(Boolean)) { job && job.log(l); const pr = parseSteamProgress(l); if (pr && job) job.progress(10 + 0.85 * pr.pct, self.T('SteamCMD: {state} {pct} %', { state: pr.state, pct: pr.pct.toFixed(1) })); } };
          child.stdout && child.stdout.on('data', on); child.stderr && child.stderr.on('data', on);
          child.on('error', reject); child.on('close', (code) => resolve({ code, out: buf }));
        }, reject);
      });
      out = r.out;
    } else out = ((r) => r.stdout + r.stderr)(await this.gs.dx(args, { ok: true, timeout: 3 * 3600e3 }));
    const res = steamResult(out);
    if (!res.ok) throw new Error(this.T(res.msg));
    s.installed = true; s.installedAt = Date.now(); this.ctx.settings.save();
    return { ok: true };
  }

  /* ---------- start line ---------- */
  exeRel(s) {
    const p = this.profile(s);
    const rel = s.custom && s.custom.exe ? s.custom.exe : p ? (s.platform === 'linux' ? p.linux : p.win) : null;
    if (!rel) throw Object.assign(new Error(this.T('Set the start program first (Settings → Start).')), { status: 400 });
    return String(rel).replace(/\\/g, '/');
  }
  /** Program, arguments, folder and environment for a native start – everything checked. */
  startSpec(s) {
    const dir = this.dir(s);
    const p = this.profile(s);
    const rel = this.exeRel(s);
    const exe = safeRel(dir, rel);
    const cwd = p && p.cwd && !(s.custom && s.custom.exe) ? safeRel(dir, p.cwd) : path.dirname(exe);
    const args = G.buildArgs(s, s.platform, dir);
    const env = { ...process.env, ...((p && p.env) || {}) };
    if (s.platform === 'linux' && p && p.libs) env.LD_LIBRARY_PATH = [...p.libs.map((l) => safeRel(dir, l === '.' ? './' : l)), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
    let cmd = exe; let argv = args; let verbatim = false;
    if (IS_WIN && /\.(bat|cmd)$/i.test(exe)) {
      // cmd.exe would interpret &, |, %, ^ … – only plain values are allowed in a .bat start line
      for (const a of args) if (!BAT_SAFE.test(a)) throw Object.assign(new Error(this.T('Parameter “{a}” contains characters a .bat start cannot pass safely.', { a: a.slice(0, 40) })), { status: 400 });
      if (/["%^&|<>]/.test(exe)) throw Object.assign(new Error(this.T('The server folder contains characters a .bat start cannot pass safely.')), { status: 400 });
      cmd = process.env.ComSpec || 'cmd.exe'; argv = ['/d', '/s', '/c', `""${exe}" ${args.join(' ')}"`]; verbatim = true;
    }
    return { exe, cmd, argv, cwd, env, verbatim };
  }

  /* ---------- run state ---------- */
  logFile(s) { return path.join(this.dir(s), 'hostwerk-console.log'); }
  /** Process still alive and really ours (pid could be reused by Windows/Linux)? */
  async alive(s) {
    if (!s.pid) return false;
    try { process.kill(s.pid, 0); } catch { return false; }
    const ch = this.children.get(s.id);
    if (ch && ch.exitCode === null && ch.pid === s.pid) return true;
    return this.pidMatches(s);
  }
  async pidMatches(s) {
    const name = path.basename(String(s.pidExe || ''));
    if (!name) return true;
    if (IS_WIN) {
      const r = await this.core('util').exec('tasklist', ['/FI', `PID eq ${Number(s.pid)}`, '/FO', 'CSV', '/NH'], { timeout: 10000 });
      return r.stdout.toLowerCase().includes(`"${(/\.(bat|cmd)$/i.test(name) ? 'cmd.exe' : name).toLowerCase()}"`);
    }
    try { return fs.readFileSync(`/proc/${Number(s.pid)}/cmdline`, 'utf8').includes(name); } catch { return true; }
  }
  async running(s) {
    if (this.isDocker(s)) { const r = await this.gs.dx(['inspect', '--format', '{{.State.Running}}', this.gs.cname(s)], { ok: true, timeout: 15000 }); return r.stdout.trim() === 'true'; }
    return this.alive(s);
  }

  /* ---------- start / stop ---------- */
  async start(job, s) {
    if (await this.running(s).catch(() => false)) return { ok: true, text: this.T('Already running.') };
    if (s.autoUpdate !== false && s.installedAt && Date.now() - s.installedAt > 10 * 60000) {
      job && job.progress(5, this.T('Update on start: SteamCMD checks for a new version …'));
      try { await this.install(job, s); } catch (e) { job && job.log(this.T('Update failed – starting the installed version: {msg}', { msg: e.message })); }
    }
    s.wantRun = true; this.ctx.settings.save();
    if (this.isDocker(s)) {
      await this.gs.dockerReady();
      await this.ensureContainer(s);
      await this.gs.dx(['start', this.gs.cname(s)]);
      return { ok: true, text: this.T('Started.') };
    }
    const spec = this.startSpec(s);
    if (!fs.existsSync(spec.exe)) throw new Error(this.T('Start program not found: {exe} – install again or set it under Settings.', { exe: path.relative(this.dir(s), spec.exe) }));
    if (!IS_WIN) { try { fs.chmodSync(spec.exe, 0o755); } catch { /* not ours */ } }
    // Keep the console output: the last run stays as .1
    const log = this.logFile(s);
    try { if (fs.existsSync(log) && fs.statSync(log).size > 0) fs.renameSync(log, `${log}.1`); } catch { /* in use */ }
    const fd = fs.openSync(log, 'a');
    let child;
    try {
      child = this.spawn(spec.cmd, spec.argv, { cwd: spec.cwd, env: spec.env, detached: process.platform !== 'win32', windowsHide: true, windowsVerbatimArguments: spec.verbatim, stdio: ['ignore', fd, fd] });
    } finally { fs.closeSync(fd); }
    if (!child || !child.pid) throw new Error(this.T('The server could not be started (blocked by the system?).'));
    child.on('exit', (code, sig) => { s.lastExit = { code, sig: sig || null, at: Date.now() }; this.children.delete(s.id); this.gs.broadcast({ type: 'games' }); });
    child.on('error', () => {});
    if (child.unref) child.unref();
    this.children.set(s.id, child);
    s.pid = child.pid; s.pidExe = path.basename(spec.exe); s.startedAt = Date.now(); s.lastExit = null;
    this.ctx.settings.save();
    return { ok: true, text: this.T('Started.') };
  }

  async waitExit(s, ms) { const end = Date.now() + ms; while (Date.now() < end) { if (!(await this.alive(s))) return true; await new Promise((r) => setTimeout(r, 1000)); } return !(await this.alive(s)); }

  async stop(job, s, { force = false } = {}) {
    s.wantRun = false; this.ctx.settings.save();
    if (this.isDocker(s)) {
      const c = this.gs.cname(s);
      await this.gs.dx(force ? ['kill', c] : ['stop', '-t', '45', c], { ok: true, timeout: 90000 });
      if (await this.running(s).catch(() => false)) throw Object.assign(new Error(this.T('The server is still running – “Force” ends it right away.')), { canKill: true });
      return { ok: true, text: force ? this.T('Ended right away (forced).') : this.T('Stopped.') };
    }
    if (!(await this.alive(s))) { s.pid = null; this.ctx.settings.save(); return { ok: true, text: this.T('Stopped.') }; }
    const p = this.profile(s);
    if (!force && p && p.rcon && p.stop) {
      job && job.progress(20, this.T('Asking the server to save and stop …'));
      await this.send(s, p.stop).catch(() => null);
      if (await this.waitExit(s, 30000)) return this.stopped(s);
    }
    const pid = Number(s.pid);
    if (IS_WIN) {
      const { exec } = this.core('util');
      if (!force) { const r = await exec('taskkill', ['/PID', String(pid), '/T'], { timeout: 15000 }); if (r.code === 0 && (await this.waitExit(s, 20000))) return this.stopped(s); }
      await exec('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 15000 });
    } else {
      const sig = (x) => { try { process.kill(-pid, x); } catch { try { process.kill(pid, x); } catch { /* gone */ } } };
      if (!force) { sig('SIGINT'); if (await this.waitExit(s, 30000)) return this.stopped(s); sig('SIGTERM'); if (await this.waitExit(s, 15000)) return this.stopped(s); }
      sig('SIGKILL');
    }
    await this.waitExit(s, 10000);
    if (await this.alive(s)) throw Object.assign(new Error(this.T('The server is still running – “Force” ends it right away.')), { canKill: true });
    return this.stopped(s, force);
  }
  stopped(s, force = false) { s.pid = null; this.ctx.settings.save(); return { ok: true, text: force ? this.T('Ended right away (forced).') : this.T('Stopped.') }; }

  /* ---------- Docker container ---------- */
  limitArgs(l) {
    const out = [];
    if (l && Number(l.cpus) > 0) out.push('--cpus', String(Number(l.cpus)));
    if (l && Number(l.memoryMb) > 0) out.push('--memory', `${Math.round(Number(l.memoryMb))}m`, '--memory-swap', `${Math.round(Number(l.memoryMb))}m`);
    return out;
  }
  /** Everything that makes up the container – if it changes (port, limits, start line), the container is created anew (data stays in the volume). */
  containerSpec(s) {
    const p = this.profile(s);
    const rel = safeRelPosix(this.exeRel(s));
    const cwd = p && p.cwd && !(s.custom && s.custom.exe) ? `/data/server/${safeRelPosix(p.cwd)}` : path.posix.dirname(`/data/server/${rel}`);
    const env = { HOME: '/data/home', ...((p && p.env) || {}) };
    if (p && p.libs) env.LD_LIBRARY_PATH = p.libs.map((l) => (l === '.' ? '/data/server' : `/data/server/${safeRelPosix(l)}`)).join(':');
    const ports = G.portsFor(s).flatMap((x) => (/tcp/i.test(x.proto) && /udp/i.test(x.proto) ? ['tcp', 'udp'] : [/tcp/i.test(x.proto) ? 'tcp' : 'udp']).map((pr) => `${x.port}:${x.port}/${pr}`));
    return { image: DOCKER_IMAGE, entry: `/data/server/${rel}`, cwd, env, ports, args: G.buildArgs(s, 'linux', '/data/server'), limits: this.limitArgs(s.limits) };
  }
  createArgs(s, spec) {
    return ['create', '--name', this.gs.cname(s), '--restart', 'no', '-v', `${this.volume(s)}:/data`, '-w', spec.cwd,
      ...Object.entries(spec.env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), ...spec.ports.flatMap((x) => ['-p', x]), ...spec.limits,
      '--entrypoint', spec.entry, spec.image, ...spec.args];
  }
  async ensureContainer(s) {
    const spec = this.containerSpec(s);
    const hash = crypto.createHash('sha1').update(JSON.stringify(spec)).digest('hex').slice(0, 16);
    const c = this.gs.cname(s);
    const ex = await this.gs.dx(['inspect', '--format', '{{.Id}}', c], { ok: true, timeout: 15000 });
    if (ex.code === 0 && s.specHash === hash) return false;
    await this.gs.dx(['rm', '-f', c], { ok: true });
    await this.gs.dx(this.createArgs(s, spec), { timeout: 120000 });
    s.specHash = hash; this.ctx.settings.save();
    return true;
  }

  /* ---------- console ---------- */
  async consoleLines(s, n = 300) {
    if (this.isDocker(s)) { const r = await this.gs.dx(['logs', '--tail', String(n), this.gs.cname(s)], { ok: true, timeout: 20000 }); return (r.stdout + r.stderr).replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').split('\n').filter(Boolean); }
    const { readLastLines } = this.core('util');
    const p = this.profile(s);
    const files = [this.logFile(s)];
    if (p && p.log) { try { files.push(safeRel(this.dir(s), p.log)); } catch { /* ignore */ } }
    const have = files.filter((f) => fs.existsSync(f)).map((f) => ({ f, t: fs.statSync(f).mtimeMs, size: fs.statSync(f).size })).filter((x) => x.size > 0).sort((a, b) => b.t - a.t);
    return have[0] ? readLastLines(have[0].f, n).map((l) => String(l).replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')) : [];
  }
  canSend(s) { const p = this.profile(s); return !!(p && p.rcon); }
  async send(s, command) {
    const p = this.profile(s);
    if (!p || !p.rcon) throw new Error(this.T('This game takes no console commands through Hostwerk.'));
    const v = G.cleanValues(s, p);
    let out;
    try { out = await rconExec({ port: p.rcon.port(v), password: s.secret, command: String(command).slice(0, 300) }); } catch (e) { throw new Error(this.T(e.message)); }
    return { ok: true, output: out };
  }

  /* ---------- backups ---------- */
  backupDir(s) { return path.join(this.dir(s), 'backups'); }
  backups(s) {
    if (this.isDocker(s)) return [];
    const d = this.backupDir(s);
    if (!fs.existsSync(d)) return [];
    return fs.readdirSync(d).filter((f) => /\.(zip|tar\.gz)$/.test(f)).map((f) => { const st = fs.statSync(path.join(d, f)); return { file: f, size: st.size, time: st.mtimeMs }; }).sort((a, b) => b.time - a.time);
  }
  async backup(job, s) {
    if (!s.saves) throw Object.assign(new Error(this.T('Choose what to back up first (Settings → Backups: folder inside the server).')), { status: 400 });
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    if (this.isDocker(s)) {
      const rel = safeRelPosix(s.saves);
      await this.gs.dockerReady();
      const r = await this.gs.dx(['run', '--rm', '-v', `${this.volume(s)}:/data`, '--entrypoint', 'sh', DOCKER_IMAGE, '-c', 'mkdir -p /data/backups && tar czf "/data/backups/$1" -C /data/server "$2"', 'backup', `${s.id}-${stamp}.tar.gz`, rel], { ok: true, timeout: 3600e3 });
      if (r.code !== 0) throw new Error((r.stderr || r.stdout || 'tar failed').trim().split('\n').pop());
      return { ok: true, text: this.T('Backup saved in the volume (backups/).') };
    }
    const src = safeRel(this.dir(s), s.saves);
    if (!fs.existsSync(src)) throw new Error(this.T('The folder “{dir}” does not exist yet – start the server once first.', { dir: s.saves }));
    const file = path.join(this.backupDir(s), `${s.id}-${stamp}.zip`);
    job && job.progress(20, this.T('Packing {dir} …', { dir: s.saves }));
    await this.core('util').zipDir(src, file);
    const keep = Math.max(1, Math.min(100, Number(s.backupKeep) || 10));
    for (const old of this.backups(s).slice(keep)) fs.rmSync(path.join(this.backupDir(s), old.file), { force: true });
    return { ok: true, text: this.T('Backup saved: {file}', { file: path.basename(file) }) };
  }
  async restore(s, file) {
    if (this.isDocker(s)) throw new Error(this.T('Restoring works for servers on this PC – in Docker mode use the Files tab.'));
    if (await this.alive(s)) throw Object.assign(new Error(this.T('Stop the server first.')), { status: 409 });
    if (!s.saves) throw new Error(this.T('Choose what to back up first (Settings → Backups: folder inside the server).'));
    const f = path.basename(String(file || ''));
    if (!/\.zip$/.test(f)) throw Object.assign(new Error(this.T('Not a backup')), { status: 400 });
    const zip = path.join(this.backupDir(s), f);
    if (!fs.existsSync(zip)) throw Object.assign(new Error(this.T('Backup not found')), { status: 404 });
    const target = safeRel(this.dir(s), s.saves);
    const prev = `${target}.before-restore`;
    fs.rmSync(prev, { recursive: true, force: true });
    if (fs.existsSync(target)) fs.renameSync(target, prev);
    fs.mkdirSync(target, { recursive: true });
    await this.core('util').unzipTo(zip, target);
    return { ok: true, text: this.T('Restored – the previous state is kept as “{dir}”.', { dir: `${s.saves}.before-restore` }) };
  }

  /* ---------- config files ---------- */
  configFiles(s) {
    const list = [...G.configsFor(s.appid, s.platform)];
    for (const f of s.extraConfigs || []) if (!list.includes(f)) list.push(f);
    return list.map((rel) => { let exists = false; if (!this.isDocker(s)) { try { exists = fs.existsSync(safeRel(this.dir(s), rel)); } catch { /* ignore */ } } return { path: rel, exists: this.isDocker(s) ? null : exists }; });
  }
  checkText(rel) { if (!TEXT_EXT.test(String(rel))) throw Object.assign(new Error(this.T('Only text and config files can be edited here.')), { status: 400 }); }
  async readText(s, rel) {
    this.checkText(rel);
    if (this.isDocker(s)) {
      const r = safeRelPosix(rel);
      await this.gs.dockerReady(); await this.ensureContainer(s);
      const tmp = path.join(this.ctx.paths.cache, `gs-${s.id}-${crypto.randomBytes(3).toString('hex')}`);
      const x = await this.gs.dx(['cp', `${this.gs.cname(s)}:/data/server/${r}`, tmp], { ok: true });
      try { return { path: rel, content: x.code === 0 && fs.existsSync(tmp) ? fs.readFileSync(tmp, 'utf8').slice(0, MAX_TEXT) : '', exists: x.code === 0 }; } finally { fs.rmSync(tmp, { force: true }); }
    }
    const f = safeRel(this.dir(s), rel);
    if (!fs.existsSync(f)) return { path: rel, content: '', exists: false };
    if (fs.statSync(f).size > MAX_TEXT) throw Object.assign(new Error(this.T('The file is larger than 1 MB – open it in the Files tab.')), { status: 413 });
    return { path: rel, content: fs.readFileSync(f, 'utf8'), exists: true };
  }
  async writeText(s, rel, content) {
    this.checkText(rel);
    const text = String(content == null ? '' : content);
    if (Buffer.byteLength(text) > MAX_TEXT) throw Object.assign(new Error(this.T('The file is larger than 1 MB – open it in the Files tab.')), { status: 413 });
    if (this.isDocker(s)) {
      const r = safeRelPosix(rel);
      await this.gs.dockerReady(); await this.ensureContainer(s);
      const tmp = path.join(this.ctx.paths.cache, `gs-${s.id}-${crypto.randomBytes(3).toString('hex')}`);
      fs.writeFileSync(tmp, text);
      try { await this.gs.dx(['cp', tmp, `${this.gs.cname(s)}:/data/server/${r}`]); } finally { fs.rmSync(tmp, { force: true }); }
      return this.readText(s, rel);
    }
    const f = safeRel(this.dir(s), rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
    return { path: rel, content: text, exists: true };
  }

  /* ---------- commands (same names as LinuxGSM, so tasks and the overview work for both) ---------- */
  run(s, command) {
    const { runJob } = this.core('jobs');
    const label = this.gs.label(command);
    const go = async (job) => {
      switch (command) {
        case 'start': return this.start(job, s);
        case 'stop': return this.stop(job, s);
        case 'kill': return this.stop(job, s, { force: true });
        case 'restart': await this.stop(job, s); return this.start(job, s);
        case 'install': case 'auto-install': case 'update': case 'validate': case 'force-update': {
          const was = await this.running(s).catch(() => false);
          if (was) await this.stop(job, s);
          await this.install(job, s, { validate: command === 'validate' || command === 'force-update' });
          if (was) await this.start(job, s);
          return { ok: true, text: this.T('Up to date.') };
        }
        case 'backup': return this.backup(job, s);
        case 'monitor': return { ok: true, text: (await this.running(s).catch(() => false)) ? this.T('Running.') : this.T('Stopped.') };
        default: throw Object.assign(new Error(this.T('Steam servers know start, stop, restart, update, validate and backup.')), { status: 400 });
      }
    };
    return runJob(`${s.name}: ${label}`, async (job) => {
      const r = await go(job);
      await this.gs.refresh(s).catch(() => {});
      this.gs.broadcast({ type: 'games' });
      return r;
    }, { key: `game-${s.id}-${command}` });
  }

  /** Monitor: restart crashed servers (only ones started in this Hostwerk session, at most 3 times in 30 minutes). */
  async monitor(s, seen) {
    if (!s.monitor || !s.installed || !s.wantRun) return;
    const up = await this.running(s).catch(() => null);
    if (up === null) return;
    if (up) { seen.add(s.id); return; }
    const crashedHere = seen.has(s.id) && (!s.lastExit || s.lastExit.code !== 0 || this.isDocker(s));
    seen.delete(s.id);
    if (!crashedHere) { s.wantRun = false; s.pid = null; this.ctx.settings.save(); this.gs.broadcast({ type: 'games' }); return; }
    const now = Date.now();
    const recent = (this.restarts.get(s.id) || []).filter((t) => now - t < 30 * 60000);
    if (recent.length >= 3) { s.wantRun = false; this.ctx.settings.save(); this.gs.broadcast({ type: 'toast', kind: 'error', text: this.T('{name} keeps crashing – the monitor gives up for now.', { name: s.name }) }); return; }
    recent.push(now); this.restarts.set(s.id, recent);
    try { await this.run(s, 'start').promise; seen.add(s.id); this.gs.broadcast({ type: 'toast', kind: 'warn', text: this.T('{name} crashed and was restarted (monitor).', { name: s.name }) }); } catch { /* next round */ }
  }

  /** Remove: stop, delete container and (optionally) files. */
  async remove(s, { files = false } = {}) {
    if (this.isDocker(s)) { await this.gs.dx(['rm', '-f', this.gs.cname(s)], { ok: true }); if (files) await this.gs.dx(['volume', 'rm', this.volume(s)], { ok: true }); return; }
    if (await this.alive(s).catch(() => false)) await this.stop(null, s).catch(() => this.stop(null, s, { force: true }).catch(() => {}));
  }

  /** Short description for the interface. */
  info(s) {
    const p = this.profile(s);
    return { method: 'steam', appid: s.appid, profile: !!p, fields: p ? p.fields : ['name', 'port', 'maxPlayers', 'password'], note: p && p.note ? this.T(p.note) : null, passwordMin: (p && p.passwordMin) || 0,
      exe: (() => { try { return this.exeRel(s); } catch { return null; } })(), configs: this.configFiles(s), canSend: this.canSend(s), saves: s.saves || null,
      adminPassword: p && (p.rcon || /secret/.test(String(p.args))) ? s.secret : null, image: this.isDocker(s) ? DOCKER_IMAGE : null };
  }
}

module.exports = { SteamServers, planFor, safeRel, safeRelPosix, parseSteamProgress, steamResult, steamcmdArgs, hostPlatform, DOCKER_IMAGE, STEAMCMD_URL, BAT_SAFE };
