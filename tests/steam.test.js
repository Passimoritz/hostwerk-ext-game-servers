'use strict';
/*
 * SteamCMD method without network, Docker or real game servers: the app list is filtered while streaming, cached gzipped
 * for 7 days and searched page by page; start profiles produce clean argument arrays; paths from the interface never leave
 * the server folder; LinuxGSM settings refuse shell characters; the one-step setup builds one job with clear steps.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { EventEmitter } = require('events');

const { SteamAppList, isServerTool, createStreamFilter, MAX_AGE, CACHE_FILE } = require('../server/steamlist');
const SG = require('../server/steamgames');
const { SteamServers, planFor, safeRel, safeRelPosix, parseSteamProgress, steamResult, steamcmdArgs, BAT_SAFE } = require('../server/steam');
const { encode, decode, AUTH } = require('../server/rcon');
const { GameServers, pickFor, PICKS, parseShellVars, setShellVars, cleanLimits } = require('../server/gameservers');
const de = require('../locales/de.json');

const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `gs-${n}-`));
const fill = (s, v) => (v ? String(s).replace(/\{(\w+)\}/g, (m, k) => (v[k] !== undefined ? v[k] : m)) : s);

/** Fake Steam answer: many filler apps + a few server tools, delivered in small chunks (as a stream). */
function fakeAppList(extra = []) {
  const apps = [];
  for (let i = 1; i <= 1500; i++) apps.push({ appid: 100000 + i, name: `Some Game ${i}` });
  apps.push({ appid: 896660, name: 'Valheim Dedicated Server' }, { appid: 555001, name: 'Cool "Quoted" Game Dedicated Server' }, { appid: 555002, name: 'Space Station Server' },
    { appid: 555003, name: 'Server Tycoon' }, { appid: 555004, name: 'Big Game Soundtrack' }, { appid: 555005, name: 'Arena DS' }, ...extra);
  return JSON.stringify({ applist: { apps } });
}
function fakeFetch(body, calls) {
  return async (url) => {
    calls.push(url);
    const chunks = []; for (let i = 0; i < body.length; i += 997) chunks.push(body.slice(i, i + 997)); // odd size → objects are cut
    const enc = new TextEncoder();
    let k = 0;
    return { ok: true, status: 200, body: { getReader: () => ({ read: async () => (k < chunks.length ? { done: false, value: enc.encode(chunks[k++]) } : { done: true }) }) } };
  };
}

test('server tool filter: dedicated servers yes, soundtracks/tycoons/test servers no', () => {
  for (const n of ['Valheim Dedicated Server', 'Rust Dedicated Server', 'Arma 3 Server', 'Arena DS', 'Space Station Server']) assert.ok(isServerTool(n), n);
  for (const n of ['Server Tycoon', 'Valheim Soundtrack', 'Server Manager Simulator', 'Game Public Test Server', 'Server Wars DLC', 'Server', '']) assert.ok(!isServerTool(n), n);
});

test('stream filter: objects cut across chunks and escaped quotes are handled, memory stays small', () => {
  const f = createStreamFilter();
  const body = '{"applist":{"apps":[{"appid":1,"name":"A Dedicated Server"},{"appid":2,"name":"Quote \\"X\\" Dedicated Server"},{"appid":3,"name":"Not one"}]}}';
  for (let i = 0; i < body.length; i += 7) f.push(body.slice(i, i + 7));
  const r = f.result();
  assert.strictEqual(r.seen, 3);
  assert.deepStrictEqual(r.apps.map((x) => x.appid).sort(), [1, 2]);
  assert.strictEqual(r.apps.find((x) => x.appid === 2).name, 'Quote "X" Dedicated Server');
});

test('app list: downloaded once, filtered, saved gzipped, reused for 7 days, refreshed after', async () => {
  const dir = tmp('apps');
  const calls = [];
  let now = 1_000_000;
  const list = new SteamAppList({ dataDir: dir, fetchImpl: fakeFetch(fakeAppList(), calls), now: () => now });
  assert.strictEqual(list.state().full, false);
  const d = await list.refresh();
  assert.strictEqual(calls.length, 1);
  assert.ok(d.apps.length >= 3 && d.apps.length < 10, 'only server tools are kept');
  assert.ok(!d.apps.some((x) => /Tycoon|Soundtrack|Some Game/.test(x.name)));
  const file = path.join(dir, CACHE_FILE);
  const raw = fs.readFileSync(file);
  assert.strictEqual(raw[0], 0x1f, 'gzip'); assert.strictEqual(raw[1], 0x8b);
  assert.strictEqual(JSON.parse(zlib.gunzipSync(raw)).apps.length, d.apps.length);
  assert.ok(raw.length < 2048, `small on disk (${raw.length} bytes)`);
  // a new instance reads the file – no download within 7 days
  const again = new SteamAppList({ dataDir: dir, fetchImpl: fakeFetch(fakeAppList(), calls), now: () => now + MAX_AGE - 1000 });
  await again.refresh();
  assert.strictEqual(calls.length, 1, 'cached for 7 days');
  assert.strictEqual(again.state().full, true);
  // after 7 days: fetched again (and only then)
  const later = new SteamAppList({ dataDir: dir, fetchImpl: fakeFetch(fakeAppList([{ appid: 777777, name: 'New Game Dedicated Server' }]), calls), now: () => now + MAX_AGE + 1000 });
  assert.strictEqual(later.state().stale, true);
  await later.refresh();
  assert.strictEqual(calls.length, 2);
  assert.ok(later.find(777777));
  // two refreshes at the same time → one download
  now += 3 * MAX_AGE;
  const once = new SteamAppList({ dataDir: dir, fetchImpl: fakeFetch(fakeAppList(), calls), now: () => now });
  await Promise.all([once.refresh(), once.refresh()]);
  assert.strictEqual(calls.length, 3);
});

test('app list: errors keep the built-in list, an incomplete answer is not saved', async () => {
  const dir = tmp('apps-err');
  const broken = new SteamAppList({ dataDir: dir, fetchImpl: async () => ({ ok: false, status: 503 }) });
  await assert.rejects(broken.refresh(), /503/);
  const tiny = new SteamAppList({ dataDir: dir, fetchImpl: fakeFetch('{"applist":{"apps":[{"appid":1,"name":"A Dedicated Server"}]}}', []) });
  await assert.rejects(tiny.refresh(), /incomplete/);
  assert.ok(!fs.existsSync(path.join(dir, CACHE_FILE)));
  assert.ok(tiny.search({}).total >= Object.keys(SG.PROFILES).length, 'built-in list still there');
});

test('search: profiles first, paging, limit capped, app id search, only one page leaves the server', async () => {
  const dir = tmp('search');
  const list = new SteamAppList({ dataDir: dir, fetchImpl: fakeFetch(fakeAppList(), []) });
  await list.refresh();
  const all = list.search({ limit: 1000 });
  assert.strictEqual(all.limit, 100);
  assert.ok(all.items[0].profile, 'ready-made profiles first');
  const p1 = list.search({ limit: 5 });
  const p2 = list.search({ limit: 5, offset: 5 });
  assert.strictEqual(p1.items.length, 5);
  assert.ok(!p1.items.some((a) => p2.items.some((b) => b.appid === a.appid)), 'pages do not overlap');
  assert.strictEqual(p1.total, p2.total);
  const v = list.search({ q: 'valheim' });
  assert.strictEqual(v.items[0].appid, 896660);
  assert.strictEqual(v.items.filter((x) => x.appid === 896660).length, 1, 'no duplicates between built-in and downloaded');
  assert.strictEqual(list.search({ q: '2394010' }).items[0].name, 'Palworld Dedicated Server');
  assert.ok(list.search({ q: 'quoted dedicated' }).items.some((x) => x.appid === 555001));
  assert.strictEqual(list.search({ q: 'zzzz-nothing' }).total, 0);
  const login = list.search({ q: 'arma 3' }).items.find((x) => x.appid === 233780);
  assert.ok(login && login.login, 'tools that need a Steam account are marked');
});

test('start profiles: every profile is complete and produces a clean argument array', () => {
  const required = [896660, 2394010, 1690800, 2430930, 294420, 380870, 258550, 730, 4020, 1829350, 2278520, 443030, 298740, 1110390];
  for (const id of required) assert.ok(SG.profileFor(id), `profile for ${id}`);
  for (const [id, p] of Object.entries(SG.PROFILES)) {
    assert.ok(p.name && (p.win || p.linux), id);
    const v = SG.cleanValues({ name: 'My "Server"', password: 'secret1', port: p.port || 27015, secret: 'abcdef0123456789' }, p, { url: !!p.urlArgs });
    const args = p.args(v);
    assert.ok(Array.isArray(args) && args.every((a) => typeof a === 'string'), `${id}: args are strings`);
    assert.ok(args.every((a) => !/["`$\n]/.test(a)), `${id}: no quotes or shell characters`);
    for (const x of p.ports(v.port)) assert.ok(Number.isInteger(x.port) && x.port > 0 && x.port < 65536 && /^(TCP|UDP|TCP\/UDP)$/.test(x.proto), `${id}: port ${x.port}`);
    for (const pl of ['windows', 'linux']) for (const f of SG.configsFor(Number(id), pl)) assert.doesNotThrow(() => safeRel(os.tmpdir(), f), f);
    if (p.saves) assert.doesNotThrow(() => safeRel(os.tmpdir(), p.saves));
    if (p.note) assert.ok(de[p.note], `German for the note of ${id}`);
  }
});

test('start line: placeholders, optional password, URL-style values, custom and extra parameters', () => {
  const s = { appid: 896660, name: 'Club', port: 2456, password: 'hunter22', secret: 'abcdef0123456789', extraArgs: '-crossplay "-modifier raids none"' };
  const a = SG.buildArgs(s, 'windows', 'C:/x');
  assert.deepStrictEqual(a.slice(a.indexOf('-port'), a.indexOf('-port') + 2), ['-port', '2456']);
  assert.ok(a.includes('-password') && a.includes('hunter22'));
  assert.deepStrictEqual(a.slice(-2), ['-crossplay', '-modifier raids none']);
  assert.ok(!SG.buildArgs({ ...s, password: '', extraArgs: '' }, 'windows', 'C:/x').includes('-password'), 'no empty password parameter');
  const ark = SG.buildArgs({ appid: 2430930, name: 'Evil?Name=1', port: 7777, password: '', secret: 'abcdef0123456789' }, 'windows', 'C:/x');
  assert.match(ark[0], /SessionName=EvilName1\?Port=7777/);
  const custom = SG.buildArgs({ appid: 99, custom: { exe: 'srv.exe', args: '-a "b c"' }, extraArgs: '-d' }, 'windows', 'C:/x');
  assert.deepStrictEqual(custom, ['-a', 'b c', '-d']);
  assert.throws(() => SG.splitArgs('-a\nrm -rf /'), /Control characters/);
  assert.deepStrictEqual(SG.parsePortList('2456/udp, 2457 27015/tcp 7777/both').map((p) => `${p.port}/${p.proto}`), ['2456/UDP', '2457/UDP', '27015/TCP', '7777/TCP/UDP']);
  assert.throws(() => SG.parsePortList('99999/udp'), /outside/);
  assert.throws(() => SG.parsePortList('abc'), /Invalid port/);
});

test('path safety: nothing leaves the server folder', () => {
  const base = path.join(os.tmpdir(), 'srv');
  for (const bad of ['../x', '..', 'a/../../b', '/etc/passwd', 'C:\\Windows\\x', 'C:/x', '\\\\host\\share', '', 'a\0b']) assert.throws(() => safeRel(base, bad), /outside/, bad);
  assert.strictEqual(safeRel(base, 'Pal/Saved'), path.join(base, 'Pal', 'Saved'));
  assert.strictEqual(safeRel(base, 'a\\b.ini'), path.join(base, 'a', 'b.ini'));
  for (const bad of ['../x', '/x', 'a//b', 'a/../b']) assert.throws(() => safeRelPosix(bad), /outside/);
  assert.strictEqual(safeRelPosix('game\\bin/cs2'), 'game/bin/cs2');
  assert.ok(BAT_SAFE.test('-servername') && BAT_SAFE.test('abcdef0123'));
  for (const bad of ['a&b', 'a|b', '%PATH%', 'a^b', 'a b', '"x"', 'a>b']) assert.ok(!BAT_SAFE.test(bad), bad);
});

test('plan: native where the tool exists, Docker for Linux-only tools on Windows, no Steam login', () => {
  assert.deepStrictEqual(planFor({ appid: 896660 }, 'windows'), { ok: true, mode: 'native', platform: 'windows', needsDocker: false, custom: false });
  assert.strictEqual(planFor({ appid: 2430930 }, 'linux').reason, 'windows-only');
  assert.deepStrictEqual(planFor({ appid: 5, win: false, linux: true }, 'windows'), { ok: true, mode: 'docker', platform: 'linux', needsDocker: true, custom: true });
  assert.strictEqual(planFor({ appid: 233780, login: true }, 'windows').reason, 'login');
  assert.strictEqual(planFor({ appid: 6, win: null, linux: null }, 'linux').mode, 'native', 'unknown tools are tried natively');
});

test('one-step picks: Steam natively on Windows when possible, LinuxGSM on Linux', () => {
  const by = (pl) => Object.fromEntries(PICKS.map((x) => pickFor(x, pl)).filter(Boolean).map((p) => [p.name, p]));
  const win = by('windows'); const lin = by('linux');
  assert.strictEqual(win.Valheim.method, 'steam'); assert.strictEqual(win.Valheim.needsDocker, false);
  assert.strictEqual(win['Terraria (tShock)'].method, 'lgsm'); assert.strictEqual(win['Terraria (tShock)'].needsDocker, true);
  assert.strictEqual(lin.Valheim.method, 'lgsm'); assert.strictEqual(lin.Valheim.needsDocker, false);
  assert.ok(!lin['ARK: Survival Ascended'], 'Windows-only tool without LinuxGSM script is not offered on Linux');
  assert.strictEqual(lin.Enshrouded, undefined);
});

test('SteamCMD: arguments, progress and result', () => {
  assert.deepStrictEqual(steamcmdArgs('/srv/x', 896660, { validate: true }), ['+force_install_dir', '/srv/x', '+login', 'anonymous', '+app_update', '896660', 'validate', '+quit']);
  assert.throws(() => steamcmdArgs('/x', '1; rm -rf /'), /Invalid Steam app id/);
  assert.deepStrictEqual(parseSteamProgress(' Update state (0x61) downloading, progress: 42.17 (1 / 2)'), { pct: 42.17, state: 'downloading' });
  assert.strictEqual(parseSteamProgress('Loading Steam API...OK'), null);
  assert.ok(steamResult("Success! App '896660' fully installed.").ok);
  assert.ok(steamResult("Success! App '896660' already up to date.").ok);
  assert.ok(steamResult('ERROR! Failed to install app \'233780\' (No subscription)').login);
  assert.match(steamResult("Error! App '1' state is 0x202 after update job.").msg, /disk space/);
  assert.ok(!steamResult('').ok);
});

test('RCON packets: encode/decode round trip, incomplete data waits', () => {
  const a = encode(7, AUTH, 'pw');
  assert.strictEqual(a.readInt32LE(0), 12);
  const b = encode(2, 0, 'hello');
  const both = Buffer.concat([a, b]);
  const r = decode(both.slice(0, both.length - 3));
  assert.deepStrictEqual(r.packets, [{ id: 7, type: AUTH, body: 'pw' }]);
  const r2 = decode(Buffer.concat([r.rest, both.slice(both.length - 3)]));
  assert.deepStrictEqual(r2.packets, [{ id: 2, type: 0, body: 'hello' }]);
  assert.throws(() => decode(Buffer.from([1, 0, 0, 0, 0, 0, 0, 0])), /Invalid/);
});

test('LinuxGSM settings: read literal values, refuse shell characters, replace or append lines', () => {
  const v = parseShellVars('# c\nport="2456"\nservername=\'My server\'\nmaxplayers=10\nstartparameters="-name ${servername}"\n');
  assert.deepStrictEqual([v.port, v.servername, v.maxplayers], ['2456', 'My server', '10']);
  const out = setShellVars('port="2456"\n', { port: '2466', serverpassword: 'abc' });
  assert.strictEqual(out, 'port="2466"\nserverpassword="abc"\n');
  for (const bad of ['$(reboot)', 'a"b', '`id`', 'a\\b', 'a\nb']) assert.throws(() => setShellVars('', { serverpassword: bad }), /not allowed/, bad);
  assert.throws(() => setShellVars('', { 'bad key': 'x' }), /Invalid/);
});

test('resource limits: cleaned, 0 = no limit, nonsense refused', () => {
  assert.strictEqual(cleanLimits({ cpus: 0, memoryMb: 0 }), null);
  assert.deepStrictEqual(cleanLimits({ cpus: '2.5', memoryMb: '4096' }), { cpus: 2.5, memoryMb: 4096 });
  assert.throws(() => cleanLimits({ cpus: 999 }), /CPU/);
  assert.throws(() => cleanLimits({ memoryMb: 12 }), /Memory/);
});

/* ---------- with a fake Hostwerk ---------- */
function fakeHost() {
  process.env.HW_TEST = '1';
  const base = tmp('host');
  const S = { general: { language: 'de' } };
  const jobs = [];
  const runJob = (title, fn, opts) => { const job = { title, opts, logs: [], progress: (p, t) => job.logs.push(`${p}:${t || ''}`), log: (l) => job.logs.push(l), onCancel: () => {} }; jobs.push(job); job.promise = Promise.resolve().then(() => fn(job)); job.promise.catch(() => {}); job.id = `j${jobs.length}`; return job; };
  const core = {
    jobs: { registerResumer: () => {}, runJob },
    download: { cached: async (k, ttl, fn) => fn(), fetchText: async () => '', downloadFile: async () => { throw new Error('no network in tests'); }, extractZip: async () => {} },
    util: { exec: async () => ({ code: 0, stdout: '', stderr: '' }), readLastLines: (f, n) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).slice(-n), zipDir: async (src, file) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'zip'); return file; } },
    platform: { which: async () => null },
    a2s: { queryInfo: async () => null, queryPlayers: async () => [] },
  };
  return {
    S, jobs,
    ctx: { settings: { get: () => S, save: () => {} }, paths: { base, data: path.join(base, 'data'), cache: base } },
    router: new Proxy({}, { get: () => () => {} }),
    t: (s, v) => fill(de[s] || s, v),
    core: (n) => core[n],
    broadcast: () => {},
    provide: (n, o) => o,
    on: () => {},
  };
}

test('one-step setup: Steam server is created at once and set up as ONE job with numbered steps', async () => {
  const h = fakeHost();
  const g = new GameServers(h);
  g.steam.install = async (job, s) => { job.log('fake install'); s.installed = true; return { ok: true }; };
  g.steam.start = async () => ({ ok: true });
  g.dockerInstalled = async () => false;
  const appid = process.platform === 'linux' ? 1110390 : 896660; // natively on both systems
  const r = await g.setup({ method: 'steam', appid, name: 'Club', start: true });
  assert.ok(r.job && r.id);
  assert.deepStrictEqual(r.steps, ['install', 'start'], 'no Docker step for a native tool');
  const s = h.S.games.servers[0];
  assert.strictEqual(s.kind, 'steam'); assert.strictEqual(s.name, 'Club'); assert.ok(/^[a-z0-9-]+$/.test(s.id));
  assert.ok(/^[a-f0-9]{16}$/.test(s.secret));
  const job = h.jobs.find((j) => j.opts && j.opts.key === `game-quick-${s.id}`);
  assert.ok(job, 'one job for the whole flow');
  assert.match(job.title, /Spiele-Server „Club“ einrichten/);
  await job.promise;
  assert.ok(job.logs.some((l) => /Schritt 1 von 2/.test(l)) && job.logs.some((l) => /Schritt 2 von 2/.test(l)));
  assert.ok(s.installed);
  assert.strictEqual(g.info(s).secret, undefined, 'the secret is not sent to the interface');
});

test('one-step setup: Docker missing → asks (code) unless installDocker; with it the Docker step comes first', async () => {
  const h = fakeHost();
  const g = new GameServers(h);
  g.dockerInstalled = async () => false;
  await assert.rejects(g.setup({ method: 'lgsm', game: 'vhserver', mode: 'docker' }), (e) => e.code === 'DOCKER_MISSING');
  assert.strictEqual(g.list().length, 0, 'nothing created when Docker is missing and not wanted');
  let installed = 0;
  h.ctx.docker = { installWsl: () => ({ promise: Promise.resolve({ restartNeeded: true }) }), install: () => { installed++; return { promise: Promise.resolve({ restartNeeded: true }) }; } };
  if (process.platform === 'win32') h.ctx.docker.installWsl = () => { installed++; return { promise: Promise.resolve({ restartNeeded: true }) }; };
  const r = await g.setup({ method: 'lgsm', game: 'vhserver', mode: 'docker', installDocker: true });
  assert.deepStrictEqual(r.steps, ['docker', 'install', 'start']);
  const job = h.jobs.find((j) => j.opts && j.opts.key === `game-quick-${r.id}`);
  const out = await job.promise;
  assert.strictEqual(installed, 1, 'Hostwerk’s Docker setup was used');
  assert.strictEqual(out.restartNeeded, true, 'stops cleanly when Windows must restart first');
  assert.ok(job.logs.some((l) => /Schritt 1 von 3/.test(l)));
});

test('steam server: start uses an argument array (no shell), detached only outside Windows, hidden window, inside the server folder; settings are validated', async () => {
  const h = fakeHost();
  const g = new GameServers(h);
  const s = g.steam.create({ appid: 896660, name: 'Club' }, { appid: 896660, win: true, linux: true });
  assert.ok(s.password.length >= 5, 'Valheim gets a password with at least 5 characters');
  s.installed = true;
  const exe = path.join(g.dir(s), s.platform === 'linux' ? 'valheim_server.x86_64' : 'valheim_server.exe');
  fs.mkdirSync(path.dirname(exe), { recursive: true }); fs.writeFileSync(exe, '');
  const calls = [];
  g.steam.spawn = (cmd, args, opts) => { calls.push({ cmd, args, opts }); const c = new EventEmitter(); c.pid = 999999; c.exitCode = null; c.unref = () => {}; return c; };
  g.steam.alive = async () => false;
  const r = await g.steam.start(null, s);
  assert.ok(r.ok);
  assert.strictEqual(calls[0].cmd, exe);
  assert.ok(Array.isArray(calls[0].args) && calls[0].args.includes('-port'));
  // Windows: not detached – a detached console app would open its own visible console window (PalServer → Shipping-Cmd)
  assert.strictEqual(calls[0].opts.detached, process.platform !== 'win32');
  assert.strictEqual(calls[0].opts.windowsHide, true);
  assert.ok(!calls[0].opts.shell, 'never through a shell');
  assert.strictEqual(calls[0].opts.cwd, path.dirname(exe));
  assert.strictEqual(s.pid, 999999);
  // settings
  assert.throws(() => g.steamSet(s, { password: 'abc' }), /mindestens 5/);
  assert.throws(() => g.steamSet(s, { password: 'a b c d e' }), /Leerzeichen/);
  assert.throws(() => g.steamSet(s, { port: 70000 }), /Ports/);
  assert.throws(() => g.steamSet(s, { saves: '../../etc' }), /Path outside|außerhalb/);
  assert.throws(() => g.steamSet(s, { customExe: 'C:/Windows/system32/cmd.exe' }), /Path outside|außerhalb/);
  g.steamSet(s, { port: 2466, maxPlayers: 20, password: 'secret55' });
  assert.deepStrictEqual(s.ports.map((p) => p.port), [2466, 2467], 'ports follow the game port');
  // config files: only text files, only inside the folder
  await assert.rejects(g.steam.readText(s, 'valheim_server.exe'), /Text|text/);
  await assert.rejects(g.steam.readText(s, '../secret.txt'), /outside|außerhalb/);
  const w = await g.steam.writeText(s, 'saves/adminlist.txt', '76561198000000000\n');
  assert.ok(w.exists);
  assert.strictEqual((await g.steam.readText(s, 'saves/adminlist.txt')).content, '76561198000000000\n');
  // backup: zips the save folder, keeps the newest N
  fs.mkdirSync(path.join(g.dir(s), 'saves'), { recursive: true });
  const b = await g.steam.backup(null, s);
  assert.ok(b.ok && g.steam.backups(s).length === 1);
});

test('every server text and every profile note has German', () => {
  const missing = [];
  for (const f of ['gameservers.js', 'steam.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', f), 'utf8');
    for (const m of src.matchAll(/\bT\('((?:[^'\\]|\\.)+)'/g)) { const k = m[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\'); if (!de[k]) missing.push(k); }
  }
  const ui = fs.readFileSync(path.join(__dirname, '..', 'ui', 'src', 'index.jsx'), 'utf8');
  for (const m of ui.matchAll(/\bt\('((?:[^'\\]|\\.)+)'/g)) { const k = m[1].replace(/\\'/g, "'"); if (!de[k]) missing.push(k); }
  assert.deepStrictEqual([...new Set(missing)], []);
});

test('the server instance can be created twice without sharing state (no leaked globals)', () => {
  const a = new SteamServers({ ctx: { paths: {} }, dataDir: '/a' }, null);
  const b = new SteamServers({ ctx: { paths: {} }, dataDir: '/b' }, null);
  assert.notStrictEqual(a.children, b.children);
  assert.strictEqual(a.dataDir, '/a');
});
