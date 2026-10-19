'use strict';
/*
 * Game servers without LinuxGSM or Docker: commands come from the script's help (e.g. wipe for Rust), interactive commands
 * never run as a job, ports and details are parsed, data stays in settings.games, the native mode refuses non-Linux
 * systems, routes and the autostart hook are registered, and every label has German.
 */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const { GameServers, COMMANDS, FAVORITES, IS_LINUX, parseCommands, parseDetails, guideLinks } = require('../server/gameservers');
const ext = require('../server/index');
const de = require('../locales/de.json');

const fill = (s, v) => (v ? String(s).replace(/\{(\w+)\}/g, (m, k) => (v[k] !== undefined ? v[k] : m)) : s);

function fakeHost(lang = 'en') {
  process.env.HW_TEST = '1';
  const S = { general: { language: lang } };
  const routes = [];
  const hooks = {};
  const provided = {};
  const jobs = [];
  const core = {
    jobs: { registerResumer: () => {}, runJob: (title, fn, opts) => { jobs.push({ title, opts }); return { id: `j${jobs.length}`, promise: Promise.resolve() }; } },
    download: { cached: async (k, ttl, fn) => fn(), fetchText: async () => 'shortname,gameservername,gamename,os\nvh,vhserver,Valheim,ubuntu-22.04\nrust,rustserver,Rust,ubuntu-22.04\n', downloadFile: async () => {} },
    util: { exec: async () => ({ code: 1, stdout: '', stderr: '' }), readLastLines: () => [] },
    platform: { which: async () => null },
    a2s: { queryInfo: async () => null, queryPlayers: async () => [] },
  };
  const host = {
    S, routes, hooks, provided, jobs,
    ctx: { settings: { get: () => S, save: () => {} }, paths: { base: os.tmpdir(), cache: os.tmpdir() } },
    router: new Proxy({}, { get: (_, m) => (p) => routes.push(`${m.toUpperCase()} ${p}`) }),
    t: (s, v) => fill(lang === 'de' && de[s] ? de[s] : s, v),
    core: (n) => core[n],
    broadcast: () => {},
    provide: (name, obj) => { provided[name] = obj; return obj; },
    on: (ev, fn) => { (hooks[ev] = hooks[ev] || []).push(fn); },
  };
  return host;
}

const HELP = '\x1b[1mrustserver\x1b[0m - Linux Game Server Manager\nCommands\nstart         st   | Start the server.\nstop          sp   | Stop the server.\nwipe          wi   | Reset the map and/or blueprints.\nmods-install  mi   | View and install available mods/addons.\nconsole       c    | Access server console.\n';

test('commands come from the LinuxGSM help (e.g. wipe for Rust); interactive ones never run as a job', async () => {
  const g = new GameServers(fakeHost());
  g.dx = async () => ({ code: 0, stdout: HELP, stderr: '' });
  const srv = { id: 'r1', game: 'rustserver', mode: 'docker' };
  const list = await g.commandsFor(srv, { fresh: true });
  assert.ok(list.some((x) => x.cmd === 'wipe' && x.short === 'wi' && /map/.test(x.desc)));
  assert.ok(g.allowed(srv, 'wipe') && g.allowed(srv, 'mods-install'));
  assert.ok(!g.allowed(srv, 'console'), 'interactive commands must not run as a job');
  assert.ok(!g.allowed(srv, 'rm-rf'));
  assert.deepStrictEqual(parseCommands(''), []);
});

test('details: ports and key/value lines', () => {
  const d = parseDetails('Server name:   My Valheim\n> Game     2456  udp\n> Query    2457  udp\nRCON  27015 tcp\n');
  assert.deepStrictEqual(d.ports.map((p) => `${p.name}:${p.port}/${p.proto}`), ['Game:2456/UDP', 'Query:2457/UDP', 'RCON:27015/TCP']);
  assert.strictEqual(d.info['Server name'], 'My Valheim');
});

test('query port candidates and game port from the details', () => {
  const g = new GameServers(fakeHost());
  const s = { detail: { ports: [{ name: 'Game', port: 2456, proto: 'UDP' }, { name: 'Query', port: 2457, proto: 'UDP' }] } };
  assert.strictEqual(g.gamePort(s), 2456);
  assert.deepStrictEqual(g.queryCandidates(s), [2457, 2456]);
  assert.strictEqual(g.address(s).local, 'localhost:2456');
});

test('data in settings.games, unique names, game list from LinuxGSM', async () => {
  const h = fakeHost('de');
  const g = new GameServers(h);
  assert.deepStrictEqual(g.list(), []);
  assert.ok(h.S.games && Array.isArray(h.S.games.servers));
  h.S.games.servers.push({ id: 'vh-1', name: 'Valheim', game: 'vhserver' });
  assert.strictEqual(g.uniqueName('Valheim'), 'Valheim 2');
  assert.throws(() => g.get('nope'), /Spiele-Server nicht gefunden/);
  const games = await g.games();
  assert.deepStrictEqual(games.map((x) => x.game), ['vhserver', 'rustserver']);
  assert.strictEqual(games[0].hint, 'Valheim');
});

test('native mode only on Linux; Docker mode creates a job', () => {
  const h = fakeHost('de');
  const g = new GameServers(h);
  if (!IS_LINUX) assert.throws(() => g.create({ game: 'vhserver', mode: 'native' }), /nur auf Linux/);
  assert.throws(() => g.create({ game: '../evil', mode: 'docker' }), /Ungültiges Spiel/);
  const job = g.create({ game: 'vhserver', mode: 'docker', name: 'Club' });
  assert.ok(job.id);
  assert.strictEqual(h.S.games.servers[0].mode, 'docker');
  assert.match(h.jobs[0].title, /Spiele-Server „Club“ \(Docker\) einrichten/);
});

test('activate: provides games, routes and autostart', () => {
  const h = fakeHost();
  ext.activate(h);
  assert.ok(h.provided.games instanceof GameServers);
  for (const r of ['GET /games', 'GET /games/catalog', 'POST /games', 'GET /games/:id', 'POST /games/:id/:command', 'GET /games/:id/console']) assert.ok(h.routes.includes(r), r);
  assert.ok(h.hooks.autostart && h.hooks.shutdown);
  h.hooks.shutdown[0]();
});

test('every command label, favourite hint and guide text has German', () => {
  for (const v of Object.values(COMMANDS)) assert.ok(de[v], `German missing: ${v}`);
  assert.ok(de[FAVORITES.mcserver]);
  for (const l of guideLinks('vhserver', 'Valheim')) { assert.ok(de[l.label], l.label); assert.ok(de[l.text], l.text); }
  for (const [k, v] of Object.entries(de)) if (k !== '$patterns') assert.ok(typeof v === 'string' && v.trim(), k);
});
