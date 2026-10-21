'use strict';
/*
 * Import of existing game servers – with dummy folders only (no Steam, no Docker, no network): Steam libraries and
 * SteamCMD folders are found through their manifests, start scripts give port/name/start line, LinuxGSM instances
 * through lgsm/config-lgsm, containers through their image; searching never changes anything, taking over in place
 * keeps the folder (also when the server is removed again), a copy leaves the original untouched.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const IM = require('../server/importer');
const { GameServers } = require('../server/gameservers');
const de = require('../locales/de.json');

const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `gs-imp-${n}-`));
const fill = (s, v) => (v ? String(s).replace(/\{(\w+)\}/g, (m, k) => (v[k] !== undefined ? v[k] : m)) : s);
const write = (f, text = '') => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
const acf = (appid, name, installdir, size = 1234) => `"AppState"\n{\n\t"appid"\t\t"${appid}"\n\t"name"\t\t"${name}"\n\t"installdir"\t\t"${installdir}"\n\t"SizeOnDisk"\t\t"${size}"\n\t"buildid"\t\t"42"\n}\n`;
/** Every file below a folder with its content – to prove that searching changes nothing. */
const snapshot = (dir) => { const out = {}; const go = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) go(f); else out[path.relative(dir, f)] = fs.readFileSync(f, 'utf8'); } }; go(dir); return out; };

/** A Steam folder with a second library: Valheim's server tool (with start script), a normal game, a broken entry. */
function fakeSteam() {
  const root = tmp('steam');
  const lib2 = tmp('lib2');
  write(path.join(root, 'steamapps', 'libraryfolders.vdf'), `"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"${root.replace(/\\/g, '\\\\')}"\n\t}\n\t"1"\n\t{\n\t\t"path"\t\t"${lib2.replace(/\\/g, '\\\\')}"\n\t\t"apps" { "896660" "1" }\n\t}\n}\n`);
  write(path.join(root, 'steamapps', 'appmanifest_440.acf'), acf(440, 'Team Fortress 2', 'Team Fortress 2'));
  write(path.join(root, 'steamapps', 'common', 'Team Fortress 2', 'hl2.exe'), 'x');
  write(path.join(root, 'steamapps', 'appmanifest_258550.acf'), acf(258550, 'Rust Dedicated Server', 'rust_dedicated')); // folder missing → skipped
  write(path.join(lib2, 'steamapps', 'appmanifest_896660.acf'), acf(896660, 'Valheim Dedicated Server', 'Valheim dedicated server', 1900000000));
  const vh = path.join(lib2, 'steamapps', 'common', 'Valheim dedicated server');
  write(path.join(vh, 'valheim_server.exe'), 'exe');
  write(path.join(vh, 'valheim_server.x86_64'), 'elf');
  write(path.join(vh, 'start_headless_server.bat'), '@echo off\r\nset SteamAppId=892970\r\n\r\necho "Starting server PRESS CTRL-C to exit"\r\n\r\nvaliheim_typo\r\nvalheim_server.exe -nographics -batchmode -name "Wikinger Runde" -port 2470 -world "Midgard" -password "geheim1" -savedir saves -crossplay\r\n');
  write(path.join(vh, 'saves', 'worlds_local', 'Midgard.db'), 'world');
  return { root, lib2, vh };
}

function fakeHost() {
  process.env.HW_TEST = '1';
  const base = tmp('host');
  const S = { general: { language: 'de' } };
  const jobs = [];
  const runJob = (title, fn, opts) => { const job = { title, opts, logs: [], progress: (p, t) => job.logs.push(`${Math.round(p)}:${t || ''}`), log: (l) => job.logs.push(l), onCancel: () => {} }; jobs.push(job); job.promise = Promise.resolve().then(() => fn(job)); job.promise.catch(() => {}); job.id = `j${jobs.length}`; return job; };
  const core = {
    jobs: { registerResumer: () => {}, runJob },
    download: { cached: async (k, ttl, fn) => fn(), fetchText: async () => '', fmtBytes: (n) => `${n} B`, isOffline: () => false },
    util: { exec: async () => ({ code: 1, stdout: '', stderr: '' }) },
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

test('VDF: library folders (new and old layout) and app manifests are read', () => {
  const v = IM.parseVdf('"libraryfolders"\n{\n "0" { "path" "C:\\\\Program Files (x86)\\\\Steam" "apps" { "1" "2" } }\n "1" "D:\\\\SteamLibrary"\n}');
  assert.strictEqual(v.libraryfolders['0'].path, 'C:\\Program Files (x86)\\Steam');
  assert.strictEqual(v.libraryfolders['1'], 'D:\\SteamLibrary');
  const a = IM.parseVdf(acf(896660, 'Valheim "Dedicated" Server', 'vh').replace('"Valheim "Dedicated" Server"', '"Valheim \\"Dedicated\\" Server"'));
  assert.strictEqual(a.appstate.name, 'Valheim "Dedicated" Server');
  assert.strictEqual(a.appstate.installdir, 'vh');
});

test('Steam libraries: only server tools, with folder, size and the start line of their script – nothing is changed', async () => {
  const { root, lib2, vh } = fakeSteam();
  const before = [snapshot(root), snapshot(lib2)];
  const { items, places } = await IM.scanPlaces({ roots: { steam: [root], steamcmd: [], lgsm: [] } });
  assert.ok(places.some((p) => IM.same(p, lib2)), 'second library from libraryfolders.vdf');
  assert.strictEqual(items.length, 1, 'TF2 (a game) and Rust (folder missing) are not offered');
  const it = items[0];
  assert.strictEqual(it.appid, 896660);
  assert.strictEqual(it.game, 892970, 'the GAME app id comes from the profile (for its picture)');
  assert.ok(IM.same(it.dir, vh));
  assert.strictEqual(it.size, 1900000000);
  assert.strictEqual(it.client, true);
  assert.strictEqual(it.manifestInside, false);
  const st = IM.startScript(it.dir, { exe: 'valheim_server.exe' });
  assert.strictEqual(st.script, 'start_headless_server.bat');
  assert.strictEqual(st.exe, 'valheim_server.exe');
  assert.deepStrictEqual(st.values, { name: 'Wikinger Runde', port: 2470, password: 'geheim1' });
  assert.match(st.args, /^-nographics -batchmode -name "Wikinger Runde" -port 2470 -world Midgard -password geheim1 -savedir saves -crossplay$/);
  assert.deepStrictEqual([snapshot(root), snapshot(lib2)], before, 'searching only reads');
});

test('start lines with variables are read for values but not taken over', () => {
  const d = tmp('vars');
  write(path.join(d, 'RustDedicated.exe'), 'x');
  write(path.join(d, 'start.bat'), 'RustDedicated.exe -batchmode +server.port 28100 +server.hostname %NAME% +server.maxplayers 80\n');
  const st = IM.startScript(d, { exe: 'RustDedicated.exe' });
  assert.strictEqual(st.values.port, 28100);
  assert.strictEqual(st.values.maxPlayers, 80);
  assert.strictEqual(st.args, null, 'a line with %VAR% would not start the same way');
  assert.deepStrictEqual(IM.valuesOf(['TheIsland?listen?SessionName=Insel?Port=7790?MaxPlayers=20?ServerPassword=pw']), { name: 'Insel', port: 7790, maxPlayers: 20, password: 'pw' });
});

test('SteamCMD: manifest inside the server folder (+force_install_dir) and a folder found by its start program', async () => {
  const cmd = tmp('steamcmd');
  write(path.join(cmd, 'steamcmd.exe'), 'x');
  write(path.join(cmd, 'rust', 'steamapps', 'appmanifest_258550.acf'), acf(258550, 'Rust Dedicated Server', 'rust_dedicated'));
  write(path.join(cmd, 'rust', 'RustDedicated.exe'), 'x');
  const own = tmp('own');
  write(path.join(own, 'games', 'satisfactory', 'FactoryServer.exe'), 'x');
  write(path.join(own, 'games', 'notes', 'readme.txt'), 'nothing');
  const { items } = await IM.scanPlaces({ folder: own, roots: { steam: [], steamcmd: [cmd], lgsm: [] } });
  const rust = items.find((x) => x.appid === 258550);
  assert.ok(rust && rust.manifestInside && IM.same(rust.dir, path.join(cmd, 'rust')), 'SteamCMD can update it in place');
  const sf = items.find((x) => x.appid === 1690800);
  assert.ok(sf && IM.same(sf.dir, path.join(own, 'games', 'satisfactory')) && sf.source === 'folder', 'found two levels down by FactoryServer.exe');
  // Folders Hostwerk manages are left out
  const again = await IM.scanPlaces({ folder: own, roots: { steam: [], steamcmd: [cmd], lgsm: [] }, managed: [path.join(cmd, 'rust')] });
  assert.ok(!again.items.some((x) => x.appid === 258550));
});

test('LinuxGSM: instances with their config values', async () => {
  const home = tmp('home');
  const d = path.join(home, 'vh');
  write(path.join(d, 'vhserver'), '#!/bin/bash');
  write(path.join(d, 'lgsm', 'config-lgsm', 'vhserver', '_default.cfg'), 'servername="Valheim Server"\nport="2456"\nmaxplayers="10"\n');
  write(path.join(d, 'lgsm', 'config-lgsm', 'vhserver', 'vhserver.cfg'), 'servername="Nordlicht"\nport="2460"\nserverpassword="pw12345"\n');
  fs.mkdirSync(path.join(d, 'serverfiles'));
  const { items } = await IM.scanPlaces({ roots: { steam: [], steamcmd: [], lgsm: [home] } });
  assert.strictEqual(items.length, 1);
  assert.deepStrictEqual({ script: items[0].script, installed: items[0].installed, values: items[0].values }, { script: 'vhserver', installed: true, values: { port: 2460, name: 'Nordlicht', maxPlayers: 10, password: 'pw12345' } });
});

test('Docker: LinuxGSM containers with a volume can be taken over, others stay on the Docker page, Minecraft is not a game server here', () => {
  assert.deepStrictEqual(IM.dockerGameImage('gameservermanagers/gameserver:vh'), { lgsm: 'vh' });
  assert.deepStrictEqual(IM.dockerGameImage('ghcr.io/gameservermanagers/gameserver:rust'), { lgsm: 'rust' });
  assert.deepStrictEqual(IM.dockerGameImage('lloesche/valheim-server:latest'), { other: true });
  assert.strictEqual(IM.dockerGameImage('itzg/minecraft-server'), null);
  assert.strictEqual(IM.dockerGameImage('nginx:alpine'), null);
  const row = { ID: 'abcdef1234567890', Names: 'mein-valheim', Image: 'gameservermanagers/gameserver:vh', State: 'running' };
  const det = { Id: 'abcdef1234567890ffff', Config: { Env: ['LGSM_GAMESERVER=vhserver', 'PATH=/usr/bin'] }, Mounts: [{ Type: 'volume', Name: 'vh-data', Destination: '/data' }], HostConfig: { PortBindings: { '2456/udp': [{ HostPort: '2456' }], '2457/udp': [{ HostPort: '2457' }], '2456/tcp': [{ HostPort: '2456' }] } } };
  const it = IM.dockerItem(row, det);
  assert.strictEqual(it.canInPlace, true);
  assert.strictEqual(it.script, 'vhserver');
  assert.strictEqual(it.volume, 'vh-data');
  assert.deepStrictEqual(it.ports.map((p) => `${p.port}/${p.proto}`), ['2456/TCP/UDP', '2457/UDP']);
  assert.strictEqual(IM.dockerItem(row, { ...det, Mounts: [] }).reason, 'no-volume');
  assert.strictEqual(IM.dockerItem({ ...row, Image: 'lloesche/valheim-server' }, det).reason, 'docker-other');
  assert.strictEqual(IM.dockerItem({ ...row, Names: 'bad name;rm' }, det), null);
});

test('take over in place: same folder, starts like its script, Steam client keeps updating; removing keeps the folder', async () => {
  if (process.platform !== 'win32' && process.platform !== 'linux') return;
  const { root, vh } = fakeSteam();
  const h = fakeHost();
  const g = new GameServers(h);
  g.scanRoots = { steam: [root], steamcmd: [], lgsm: [] };
  g.dockerAvailable = async () => false;
  const before = snapshot(vh);
  const scan = await g.scanImport();
  const it = scan.items.find((x) => x.appid === 896660);
  assert.ok(it && it.canInPlace && it.canCopy, 'runs natively on Windows and Linux');
  assert.strictEqual(it._start, undefined, 'start line and password stay on the server');
  assert.strictEqual(it.values.hasPassword, true);
  assert.strictEqual(it.values.password, undefined);
  assert.strictEqual(it.updates, 'client');
  const r = await g.adopt({ key: it.key, mode: 'inplace', name: 'Wikinger' });
  const s = g.get(r.id);
  assert.ok(IM.same(g.dir(s), vh), 'managed where it is');
  assert.strictEqual(s.kind, 'steam');
  assert.strictEqual(s.installed, true);
  assert.strictEqual(s.autoUpdate, false, 'the Steam client updates a library folder');
  assert.strictEqual(s.port, 2470);
  assert.strictEqual(s.password, 'geheim1');
  assert.strictEqual(s.saves, 'saves', 'the -savedir of the start line');
  if (process.platform === 'win32') assert.deepStrictEqual(s.custom, { exe: 'valheim_server.exe', args: '-nographics -batchmode -name "Wikinger Runde" -port 2470 -world Midgard -password geheim1 -savedir saves -crossplay' });
  assert.deepStrictEqual(s.ports.map((p) => p.port), [2470, 2471]);
  assert.strictEqual(g.info(s).external, true);
  assert.deepStrictEqual(snapshot(vh), before, 'taking over in place changes no file');
  await assert.rejects(g.adopt({ key: it.key, mode: 'inplace' }), /verwaltet Hostwerk schon|nicht mehr|gibt es dort nicht/);
  await g.remove(s.id, { files: true });
  assert.ok(fs.existsSync(path.join(vh, 'valheim_server.exe')), 'an imported folder is never deleted');
});

test('take over as a copy: job copies into Hostwerk, the original stays; a failed copy leaves nothing behind', async () => {
  const cmd = tmp('steamcmd2');
  write(path.join(cmd, 'rust', 'steamapps', 'appmanifest_258550.acf'), acf(258550, 'Rust Dedicated Server', 'rust_dedicated'));
  write(path.join(cmd, 'rust', 'RustDedicated.exe'), 'x');
  write(path.join(cmd, 'rust', 'RustDedicated'), 'x');
  write(path.join(cmd, 'rust', 'server', 'hostwerk', 'cfg', 'server.cfg'), 'server.hostname "Alt"');
  const h = fakeHost();
  const g = new GameServers(h);
  g.scanRoots = { steam: [], steamcmd: [cmd], lgsm: [] };
  g.dockerAvailable = async () => false;
  const before = snapshot(cmd);
  const it = (await g.scanImport()).items.find((x) => x.appid === 258550);
  assert.strictEqual(it.updates, 'steamcmd');
  const r = await g.adopt({ key: it.key, mode: 'copy' });
  const s = g.get(r.id);
  assert.strictEqual(s.installed, false, 'until the copy is done');
  const job = h.jobs.find((j) => j.opts && j.opts.key === `game-create-${s.id}`);
  assert.ok(job, 'copy runs as the server\'s setup job (the card shows "installing")');
  await job.promise;
  assert.strictEqual(s.installed, true);
  assert.ok(!s.externalDir);
  assert.strictEqual(fs.readFileSync(path.join(g.dir(s), 'server', 'hostwerk', 'cfg', 'server.cfg'), 'utf8'), 'server.hostname "Alt"');
  assert.strictEqual(s.saves, 'server/hostwerk');
  assert.strictEqual(s.autoUpdate, true);
  assert.deepStrictEqual(snapshot(cmd), before, 'the original is untouched');
  // Failing copy: the half copy and the entry are gone again
  const g2 = new GameServers(h);
  g2.scanRoots = g.scanRoots; g2.dockerAvailable = async () => false;
  g2.cfg.servers = [];
  const it2 = (await g2.scanImport()).items.find((x) => x.appid === 258550);
  const orig = IM.copyTree;
  IM.copyTree = async (src, dest) => { fs.mkdirSync(dest, { recursive: true }); fs.writeFileSync(path.join(dest, 'half'), 'x'); throw new Error('disk full'); };
  try {
    const r2 = await g2.adopt({ key: it2.key, mode: 'copy' });
    const job2 = h.jobs.find((j) => j.opts && j.opts.key === `game-create-${r2.id}`);
    await assert.rejects(job2.promise, /disk full/);
    assert.ok(!fs.existsSync(path.join(g2.root, r2.id)));
    assert.strictEqual(g2.list().length, 0);
  } finally { IM.copyTree = orig; }
});

test('take over a LinuxGSM container: own name and volume are kept for every later step', async () => {
  const h = fakeHost();
  const g = new GameServers(h);
  g.scanRoots = { steam: [], steamcmd: [], lgsm: [] };
  const calls = [];
  g.dockerAvailable = async () => true;
  g.dx = async (args) => {
    calls.push(args.join(' '));
    if (args[0] === 'ps') return { code: 0, stdout: `${JSON.stringify({ ID: 'abc123', Names: 'mein-valheim', Image: 'gameservermanagers/gameserver:vh', State: 'exited' })}\n${JSON.stringify({ ID: 'def456', Names: 'web', Image: 'nginx', State: 'running' })}\n` };
    if (args[0] === 'inspect' && args[1] === 'abc123') return { code: 0, stdout: JSON.stringify([{ Id: 'abc123ffff', Config: { Env: [] }, Mounts: [{ Type: 'volume', Name: 'vh-data', Destination: '/data' }], HostConfig: { PortBindings: { '2456/udp': [{ HostPort: '2456' }] } } }]) };
    return { code: 0, stdout: 'false', stderr: '' };
  };
  const scan = await g.scanImport();
  assert.strictEqual(scan.items.length, 1, 'nginx is no game server');
  const r = await g.adopt({ key: scan.items[0].key, mode: 'inplace' });
  const s = g.get(r.id);
  assert.strictEqual(g.cname(s), 'mein-valheim');
  assert.strictEqual(g.lgsmVolume(s), 'vh-data');
  assert.ok(g.lgsmCreateArgs(s).includes('vh-data:/data'), 'a new container keeps the data volume');
  assert.ok(!calls.some((c) => /^(rm|create|start|stop|volume)/.test(c)), 'taking over changes nothing in Docker');
});

test('copy: progress, links, refuses an existing target', async () => {
  const src = tmp('src');
  write(path.join(src, 'a', 'b.txt'), 'hello');
  write(path.join(src, 'c.bin'), Buffer.alloc(1000));
  const dest = path.join(tmp('dst'), 'copy');
  const prog = [];
  const r = await IM.copyTree(src, dest, { onProgress: (d, t) => prog.push([d, t]) });
  assert.strictEqual(r.bytes, 1005);
  assert.deepStrictEqual(prog[prog.length - 1], [1005, 1005]);
  assert.strictEqual(fs.readFileSync(path.join(dest, 'a', 'b.txt'), 'utf8'), 'hello');
  await assert.rejects(IM.copyTree(src, dest), /exists already/);
});
