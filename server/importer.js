'use strict';
/*
 * Import: game servers that already exist on this PC – found, never changed while searching.
 *
 * Where Hostwerk looks (read only):
 *   - Steam libraries: Steam's libraryfolders.vdf → every library → steamapps/appmanifest_<appid>.acf (app id, name,
 *     folder, size). Only server tools count (start profile, known id or a name like "… Dedicated Server").
 *   - SteamCMD folders (C:\steamcmd, ~/steamcmd, ~/Steam …): the same manifests, both in the library layout
 *     (steamapps/common/<folder>) and in the "+force_install_dir" layout (manifest inside the server folder itself).
 *   - LinuxGSM instances (Linux): <folder>/lgsm/config-lgsm/<script>/ next to the script <folder>/<script>.
 *   - A folder the user picks: the same checks plus the start programs of the ready-made profiles (valheim_server.exe …).
 *   - Docker containers of game server images (done by gameservers.js, which knows the Docker engine).
 * What is recognised: app id / script, folder, size, and from the start script (start_server.bat, …sh) or the LinuxGSM
 * config: port, name, players and the start line itself – so an imported server starts exactly as before.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const SG = require('./steamgames');
const { isServerTool } = require('./steamlist');

const IS_WIN = process.platform === 'win32';
const SKIP_DIRS = /^(node_modules|\.git|\$recycle\.bin|system volume information|windows|programdata|appdata|proc|sys|dev|snap)$/i;

/* ---------------------------------------------------------------- small readers */

/** Valve's KeyValues text (libraryfolders.vdf, appmanifest_*.acf) → nested object with lower-case keys. */
function parseVdf(text) {
  const root = {};
  const stack = [root];
  const re = /"((?:[^"\\]|\\.)*)"|([{}])/g;
  let key = null;
  let m;
  const unq = (s) => s.replace(/\\(["\\])/g, '$1');
  while ((m = re.exec(String(text || '')))) {
    const top = stack[stack.length - 1];
    if (m[2] === '{') { const o = {}; if (key !== null) top[key.toLowerCase()] = o; stack.push(o); key = null; continue; }
    if (m[2] === '}') { if (stack.length > 1) stack.pop(); key = null; continue; }
    const s = unq(m[1]);
    if (key === null) key = s; else { top[key.toLowerCase()] = s; key = null; }
  }
  return root;
}

/** key="value" lines of a LinuxGSM .cfg (it is sourced by bash – read only literal assignments). */
function parseShellVars(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^\s*([a-zA-Z_][a-zA-Z0-9_]*)=(?:"([^"]*)"|'([^']*)'|([^\s#]*))/);
    if (m) out[m[1]] = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4];
  }
  return out;
}

const readText = (f, max = 256 * 1024) => { try { const st = fs.statSync(f); if (!st.isFile() || st.size > max) return null; return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const isDir = (d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } };
const isFile = (f) => { try { return fs.statSync(f).isFile(); } catch { return false; } };
const listDir = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }); } catch { return []; } };
const same = (a, b) => (IS_WIN ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));
/** Is `child` the folder `parent` or inside it? */
function within(child, parent) {
  const c = path.resolve(child); const p = path.resolve(parent);
  const [cc, pp] = IS_WIN ? [c.toLowerCase(), p.toLowerCase()] : [c, p];
  return cc === pp || cc.startsWith(pp.endsWith(path.sep) ? pp : pp + path.sep);
}

/* ---------------------------------------------------------------- Steam */

/** Steam's own folders on this system (registry on Windows, the usual places elsewhere). */
async function steamRoots({ exec = null, home = os.homedir(), platform = process.platform } = {}) {
  const out = [];
  if (platform === 'win32') {
    if (exec) {
      for (const [hive, val] of [['HKCU\\Software\\Valve\\Steam', 'SteamPath'], ['HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath']]) {
        const r = await exec('reg', ['query', hive, '/v', val], { timeout: 8000 }).catch(() => null);
        const m = r && String(r.stdout || '').match(new RegExp(`${val}\\s+REG_\\w+\\s+(.+)`, 'i'));
        if (m) out.push(path.normalize(m[1].trim()));
      }
    }
    for (const env of ['ProgramFiles(x86)', 'ProgramFiles']) if (process.env[env]) out.push(path.join(process.env[env], 'Steam'));
  } else {
    out.push(path.join(home, '.steam', 'steam'), path.join(home, '.local', 'share', 'Steam'), path.join(home, '.var', 'app', 'com.valvesoftware.Steam', '.local', 'share', 'Steam'));
  }
  return dedupe(out.filter(isDir));
}
/** Usual SteamCMD folders (where people unpack steamcmd.zip / where the Linux package puts it). */
function steamcmdDirs({ home = os.homedir(), platform = process.platform } = {}) {
  const out = platform === 'win32'
    ? ['C:\\steamcmd', 'C:\\SteamCMD', 'D:\\steamcmd', path.join(home, 'steamcmd'), path.join(home, 'Desktop', 'steamcmd'), path.join(home, 'Downloads', 'steamcmd')]
    : [path.join(home, 'steamcmd'), path.join(home, 'Steam'), path.join(home, '.steam', 'steamcmd'), '/opt/steamcmd', '/usr/games/steamcmd'];
  return dedupe(out.filter(isDir));
}
function dedupe(list) { const out = []; for (const d of list) if (!out.some((x) => same(x, d))) out.push(d); return out; }

/** Every library of a Steam folder (the folder itself + libraryfolders.vdf). */
function libraries(steamRoot) {
  const out = [steamRoot];
  for (const f of [path.join(steamRoot, 'steamapps', 'libraryfolders.vdf'), path.join(steamRoot, 'config', 'libraryfolders.vdf')]) {
    const t = readText(f);
    if (!t) continue;
    const v = parseVdf(t);
    const lf = v.libraryfolders || v.libraryfolder || {};
    for (const [k, val] of Object.entries(lf)) {
      if (!/^\d+$/.test(k)) continue;
      const p = typeof val === 'string' ? val : val && val.path;
      if (p) out.push(path.normalize(p));
    }
  }
  return dedupe(out.filter(isDir));
}

/** Is this app a server tool Hostwerk can run (profile, known id or server-like name)? */
function serverApp(appid, name) {
  const p = SG.profileFor(appid);
  if (p) return { appid, name: `${p.name} Dedicated Server`, game: p.game, profile: true, login: !!p.login };
  const k = SG.KNOWN.find((x) => x[0] === appid);
  if (k) return { appid, name: k[1], game: k[2], profile: false, login: !!k[3] };
  if (isServerTool(name)) return { appid, name, game: null, profile: false, login: false };
  return null;
}

/**
 * Server tools whose manifest lies in <lib>/steamapps/. Library layout: files in steamapps/common/<installdir>;
 * "+force_install_dir" layout: the files are in <lib> itself.
 */
function manifests(lib, source) {
  const sa = path.join(lib, 'steamapps');
  const out = [];
  for (const e of listDir(sa)) {
    const m = e.isFile() && e.name.match(/^appmanifest_(\d+)\.acf$/);
    if (!m) continue;
    const st = parseVdf(readText(path.join(sa, e.name), 64 * 1024) || '').appstate || {};
    const appid = Number(st.appid || m[1]);
    const app = serverApp(appid, st.name || '');
    if (!app) continue;
    const common = st.installdir ? path.join(sa, 'common', st.installdir) : null;
    // In a Steam library the files must be in common/<folder> – otherwise the "folder" would be the whole library
    if (source === 'steam-library' && !(common && isDir(common))) continue;
    const dir = common && isDir(common) ? common : lib;
    out.push({ ...app, name: app.profile ? app.name : st.name || app.name, dir, source, size: Number(st.sizeondisk) || null, buildid: st.buildid || null,
      // SteamCMD keeps its manifest INSIDE the server folder → Hostwerk's SteamCMD can update it in place
      manifestInside: dir === lib, client: source === 'steam-library' });
  }
  return out;
}

/** Ready-made profiles whose start program lies in this folder (valheim_server.exe, …) – srcds needs its game folder too. */
function profileByExe(dir) {
  const hits = [];
  for (const [id, p] of Object.entries(SG.PROFILES)) {
    const exe = [p.win, p.linux].filter(Boolean).find((x) => isFile(path.join(dir, x)));
    if (!exe) continue;
    const shared = /srcds/i.test(exe);
    if (shared && !(p.saves && isDir(path.join(dir, p.saves)))) continue;
    hits.push({ appid: Number(id), exe });
  }
  return hits.length ? hits[0] : null;
}

/* ---------------------------------------------------------------- start script → start line, port, name … */

const COMMENT = /^\s*(@?echo\b|rem\b|::|#|set\b|export\b|cd\b|pushd\b|popd\b|title\b|pause\b|if\b|exit\b|goto\b|:|timeout\b|cls\b|sleep\b|while\b|done\b|do\b|fi\b|then\b|else\b)/i;
/** Split a line like the start scripts write it (quotes group). */
function tokens(line) {
  const out = []; const re = /"([^"]*)"|'([^']*)'|(\S+)/g; let m;
  while ((m = re.exec(line))) out.push(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]);
  return out;
}
const quote = (a) => (/[\s"]/.test(a) || a === '' ? `"${a.replace(/"/g, '')}"` : a);

/** Values hidden in a start line (both "-port 2456" and "?Port=7777" / "-Port=7777" styles). */
function valuesOf(args) {
  const v = {};
  const next = (i) => (i + 1 < args.length ? args[i + 1] : null);
  args.forEach((a, i) => {
    const low = a.toLowerCase();
    if (['-port', '+port', '+server.port', '-gameport'].includes(low) && /^\d+$/.test(next(i) || '')) v.port = Number(next(i));
    if (['-name', '-servername', '+hostname', '+server.hostname', '-sessionname'].includes(low) && next(i)) v.name = next(i);
    if (['-password', '+sv_password', '-serverpassword'].includes(low) && next(i)) v.password = next(i);
    if (['+maxplayers', '-maxplayers', '+server.maxplayers'].includes(low) && /^\d+$/.test(next(i) || '')) v.maxPlayers = Number(next(i));
    let m;
    if ((m = a.match(/^-(?:port|gameport)=(\d+)$/i))) v.port = Number(m[1]);
    if ((m = a.match(/^-(?:players|maxplayers)=(\d+)$/i))) v.maxPlayers = Number(m[1]);
    if ((m = a.match(/[?&]Port=(\d+)/i))) v.port = Number(m[1]);
    if ((m = a.match(/[?&]SessionName=([^?&]+)/i))) v.name = m[1];
    if ((m = a.match(/[?&]ServerPassword=([^?&]+)/i))) v.password = m[1];
    if ((m = a.match(/[?&]MaxPlayers=(\d+)/i))) v.maxPlayers = Number(m[1]);
  });
  if (v.port && (v.port < 1 || v.port > 65535)) delete v.port;
  if (v.maxPlayers && (v.maxPlayers < 1 || v.maxPlayers > 1000)) delete v.maxPlayers;
  return v;
}

/**
 * Start script in the server folder → { script, exe (relative), args (line), values }. Only literal lines count: a line
 * with %VAR% or $VAR is read for values but not taken over as the start line (it would not start the same way).
 */
function startScript(dir, { exe = null } = {}) {
  const exeBase = exe ? path.basename(exe).replace(/\.(exe|x86_64|sh)$/i, '').toLowerCase() : null;
  const files = listDir(dir).filter((e) => e.isFile() && /\.(bat|cmd|sh)$/i.test(e.name)).map((e) => e.name)
    .sort((a, b) => Number(/start|run|server/i.test(b)) - Number(/start|run|server/i.test(a))).slice(0, 30);
  for (const f of files) {
    const text = readText(path.join(dir, f), 64 * 1024);
    if (!text) continue;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || COMMENT.test(line)) continue;
      let tk;
      try { tk = tokens(line.replace(/\s*[&|]{1,2}\s*.*$/, '')); } catch { continue; }
      // Program token: the profile's start program (with or without .exe), else any *.exe / *.x86_64 / ./program
      const idx = tk.findIndex((t) => {
        const b = path.basename(t.replace(/\\/g, '/')).toLowerCase();
        if (exeBase && b.replace(/\.(exe|x86_64|sh)$/i, '') === exeBase) return true;
        return !exeBase && (/\.(exe|x86_64)$/i.test(b) || /^\.\/[\w.-]+$/.test(t));
      });
      if (idx < 0) continue;
      const args = tk.slice(idx + 1);
      const values = valuesOf(args);
      let rel = tk[idx].replace(/\\/g, '/').replace(/^\.\//, '').replace(/^%~dp0/i, '').replace(/^"|"$/g, '');
      if (!path.extname(rel) && IS_WIN && isFile(path.join(dir, `${rel}.exe`))) rel = `${rel}.exe`;
      const inside = !path.isAbsolute(rel) && !rel.split('/').includes('..') && isFile(path.join(dir, rel));
      const literal = !args.some((a) => /%\w+%|\$\{?\w+/.test(a));
      return { script: f, exe: inside ? rel : null, args: literal ? args.map(quote).join(' ').slice(0, 2000) : null, values };
    }
  }
  return null;
}

/* ---------------------------------------------------------------- LinuxGSM */

/** LinuxGSM instance in this folder: [{ script, dir, values }] (more than one script per folder is possible). */
function lgsmIn(dir) {
  const cfgRoot = path.join(dir, 'lgsm', 'config-lgsm');
  if (!isDir(cfgRoot)) return [];
  const out = [];
  for (const e of listDir(cfgRoot)) {
    if (!e.isDirectory() || !/^[a-z0-9]+server$/.test(e.name) || !isFile(path.join(dir, e.name))) continue;
    const v = {};
    for (const f of ['_default.cfg', 'common.cfg', `${e.name}.cfg`]) Object.assign(v, parseShellVars(readText(path.join(cfgRoot, e.name, f)) || ''));
    const port = Number(v.port);
    out.push({ script: e.name, dir, installed: isDir(path.join(dir, 'serverfiles')), values: { port: port >= 1 && port <= 65535 ? port : undefined, name: v.servername || undefined, maxPlayers: Number(v.maxplayers) || undefined, password: v.serverpassword || undefined } });
  }
  return out;
}

/* ---------------------------------------------------------------- a whole folder */

/** Everything importable in one folder (no recursion). */
function inFolder(dir, source = 'folder') {
  const out = [];
  for (const m of manifests(dir, source)) out.push(m);
  if (!out.length) {
    const hit = profileByExe(dir);
    if (hit) { const p = SG.profileFor(hit.appid); out.push({ appid: hit.appid, name: `${p.name} Dedicated Server`, game: p.game, profile: true, login: !!p.login, dir, source, exe: hit.exe, size: null, manifestInside: false, client: false }); }
  }
  for (const l of lgsmIn(dir)) out.push({ ...l, source: source === 'folder' ? 'folder' : 'lgsm' });
  return out;
}

/** Walk a folder (breadth first, bounded) and collect what inFolder finds. Server folders themselves are not walked into. */
function walk(start, { depth = 2, maxDirs = 400, source = 'folder' } = {}) {
  const out = []; const queue = [[start, 0]]; let seen = 0;
  while (queue.length && seen < maxDirs) {
    const [d, lvl] = queue.shift(); seen++;
    const found = inFolder(d, source);
    if (found.length) { out.push(...found); continue; }
    if (lvl >= depth) continue;
    for (const e of listDir(d)) if (e.isDirectory() && !e.isSymbolicLink() && !SKIP_DIRS.test(e.name) && !e.name.startsWith('.')) queue.push([path.join(d, e.name), lvl + 1]);
  }
  return out;
}

/** Usual LinuxGSM homes: the own home and /home/* (one level deeper, e.g. ~/vhserver/). */
function lgsmHomes({ home = os.homedir() } = {}) {
  const out = [home];
  for (const e of listDir('/home')) if (e.isDirectory()) out.push(path.join('/home', e.name));
  return dedupe(out.filter(isDir));
}

/**
 * Search the usual places (and optionally one folder). `managed`: folders Hostwerk already manages – left out.
 * Gives a flat list; the caller adds ids and the Docker part.
 */
async function scanPlaces({ folder = null, exec = null, platform = process.platform, home = os.homedir(), managed = [], roots = {} } = {}) {
  const found = [];
  const places = [];
  // roots: { steam, steamcmd, lgsm } – fixed lists instead of the usual places (tests, other machines)
  for (const root of roots.steam || await steamRoots({ exec, home, platform })) for (const lib of libraries(root)) { places.push(lib); found.push(...manifests(lib, 'steam-library')); }
  for (const d of roots.steamcmd || steamcmdDirs({ home, platform })) { places.push(d); found.push(...manifests(d, 'steamcmd')); for (const e of listDir(d)) if (e.isDirectory() && !/^(steamapps|package|public|logs|appcache|config|depotcache|userdata|dumps|siteserverui|linux32|linux64)$/i.test(e.name)) found.push(...inFolder(path.join(d, e.name), 'steamcmd')); }
  for (const h of roots.lgsm || (platform === 'linux' ? lgsmHomes({ home }) : [])) { places.push(h); found.push(...walk(h, { depth: 1, maxDirs: 200, source: 'lgsm' })); }
  if (folder) { places.push(folder); found.push(...walk(folder, { depth: 2 })); }
  // Each folder once, nothing Hostwerk already manages
  const out = [];
  for (const it of found) {
    if (managed.some((m) => within(it.dir, m) || within(m, it.dir))) continue;
    if (out.some((x) => same(x.dir, it.dir) && (x.appid || x.script) === (it.appid || it.script))) continue;
    out.push(it);
  }
  return { items: out, places };
}

/* ---------------------------------------------------------------- Docker containers */

/** LinuxGSM image ("gameservermanagers/gameserver:vh") → { lgsm: 'vh' }; another known game server image → { other: true }. */
const OTHER_GAME_IMAGES = /valheim|palworld|satisfactory|rust-server|\/rust\b|7dtd|7daystodie|sdtd|zomboid|\bark\b|ark-?(server|ascended|survival)|asa[-_]server|enshrouded|v-?rising|terraria|tshock|factorio|conan|counter-?strike|\bcs2\b|csgo|gmod|garrys?mod|space-?engineers|unturned|\btf2\b|cm2network\/|steamcmd|linuxgsm|soulmask|sons-?of-?the-?forest|the-?forest|abiotic|icarus|necesse|eco-server|core-?keeper|starbound|dst-?server|dontstarve/i;
function dockerGameImage(image) {
  const img = String(image || '').toLowerCase();
  if (!img || /minecraft|itzg\/|bedrock/.test(img)) return null; // Minecraft has its own management
  const m = img.match(/(?:^|\/)gameservermanagers\/gameserver:([a-z0-9]+)$/);
  if (m) return { lgsm: m[1] };
  return OTHER_GAME_IMAGES.test(img) ? { other: true } : null;
}
/** Ports a container publishes ({ "2456/udp": [{ HostPort: "2456" }] } → [{ name, port, proto }]). */
function dockerPorts(bindings) {
  const out = [];
  for (const [k, list] of Object.entries(bindings || {})) {
    const [, proto = 'tcp'] = k.split('/');
    for (const b of Array.isArray(list) ? list : []) {
      const port = Number(b && b.HostPort);
      if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
      const have = out.find((x) => x.port === port);
      if (have) { if (!have.proto.includes(proto.toUpperCase())) have.proto = 'TCP/UDP'; continue; }
      out.push({ name: out.length ? `Port ${out.length + 1}` : 'Game', port, proto: proto.toUpperCase() });
    }
  }
  return out.sort((a, b) => a.port - b.port);
}
/** Container (docker ps row + docker inspect) → found entry; LinuxGSM containers with their data in a volume can be taken over. */
function dockerItem(row, det) {
  const kind = dockerGameImage(row.Image);
  if (!kind) return null;
  const name = String(row.Names || '').split(',')[0].replace(/^\//, '');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(name)) return null;
  const env = Object.fromEntries(((det && det.Config && det.Config.Env) || []).map((e) => { const i = String(e).indexOf('='); return [String(e).slice(0, i), String(e).slice(i + 1)]; }));
  const data = ((det && det.Mounts) || []).find((m) => m.Destination === '/data');
  const volume = data ? (data.Type === 'volume' ? data.Name : data.Source) : null;
  const ports = dockerPorts(det && det.HostConfig && det.HostConfig.PortBindings);
  const running = String(row.State || '').toLowerCase() === 'running';
  const base = { key: `docker-${String(row.ID).slice(0, 12)}`, kind: 'docker', source: 'docker', container: name, image: row.Image, running, ports, dir: null };
  if (kind.lgsm) {
    const script = /^[a-z0-9]+server$/.test(env.LGSM_GAMESERVER || '') ? env.LGSM_GAMESERVER : `${kind.lgsm}server`;
    const reason = volume ? null : 'no-volume';
    return { ...base, script, short: script.replace(/server$/, ''), name, volume, canInPlace: !reason, canCopy: false, reason };
  }
  return { ...base, name, volume: null, canInPlace: false, canCopy: false, reason: 'docker-other' };
}

/* ---------------------------------------------------------------- copying (import as a copy) */

/** Size and file count of a folder (bounded – a server folder can be big but not endless). */
async function folderSize(dir, max = 500000) {
  let bytes = 0; let files = 0;
  const stack = [dir];
  while (stack.length && files < max) {
    const d = stack.pop();
    let list; try { list = await fs.promises.readdir(d, { withFileTypes: true }); } catch { continue; }
    for (const e of list) {
      const f = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) stack.push(f);
      else if (e.isFile()) { files++; try { bytes += (await fs.promises.stat(f)).size; } catch { /* gone */ } }
    }
  }
  return { bytes, files };
}
/** Free space on the drive of `dir` in bytes (null = unknown). */
function freeSpace(dir) {
  try { if (typeof fs.statfsSync !== 'function') return null; const s = fs.statfsSync(dir); return Number(s.bavail) * Number(s.bsize); } catch { return null; }
}
/** Copy a folder with progress (onProgress(done, total) in bytes); the target must not exist yet. Links are copied as links. */
async function copyTree(src, dest, { onProgress = () => {}, total = null, cancelled = () => false } = {}) {
  if (fs.existsSync(dest)) throw new Error('The target folder exists already.');
  const all = total || (await folderSize(src)).bytes;
  let done = 0; let last = 0;
  const go = async (s, d) => {
    await fs.promises.mkdir(d, { recursive: true });
    for (const e of await fs.promises.readdir(s, { withFileTypes: true })) {
      if (cancelled()) throw new Error('Cancelled');
      const a = path.join(s, e.name); const b = path.join(d, e.name);
      if (e.isDirectory()) await go(a, b);
      else if (e.isSymbolicLink()) { try { await fs.promises.symlink(await fs.promises.readlink(a), b); } catch { /* not allowed (Windows without rights) – skip */ } }
      else if (e.isFile()) {
        await fs.promises.copyFile(a, b, fs.constants.COPYFILE_EXCL);
        try { done += (await fs.promises.stat(b)).size; } catch { /* egal */ }
        if (done - last > 32 * 1048576) { last = done; onProgress(done, all); }
      }
    }
  };
  await go(src, dest);
  onProgress(all, all);
  return { bytes: done };
}

module.exports = { dockerGameImage, dockerPorts, dockerItem, parseVdf, parseShellVars, steamRoots, steamcmdDirs, libraries, manifests, serverApp, profileByExe, startScript, valuesOf, tokens, lgsmIn, inFolder, walk, scanPlaces, folderSize, freeSpace, copyTree, within, same };
