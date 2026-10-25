'use strict';
/*
 * Game server network with fake game and Minecraft servers: groups are stored in settings.gameNetwork, members are checked,
 * the start order puts the proxy last and the stop order first, a Velocity network is taken over, a failing member is
 * reported without stopping the others, and every text has German.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { GameNetwork, due } = require('../server/network');
const ext = require('../server/network-ext');
const de = require('../locales/de.json');

const fill = (s, v) => (v ? String(s).replace(/\{(\w+)\}/g, (m, k) => (v[k] !== undefined ? v[k] : m)) : s);

function world(lang = 'en') {
  const S = { general: { language: lang } };
  const calls = [];
  const running = new Set(['lobby']);
  const said = [];
  const plugins = { proxy: [], lobby: ['Geyser-Spigot.jar'], survival: [] };
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-'));
  for (const [id, files] of Object.entries(plugins)) { fs.mkdirSync(path.join(base, id, 'plugins'), { recursive: true }); for (const x of files) fs.writeFileSync(path.join(base, id, 'plugins', x), ''); }
  const mcList = [
    { id: 'proxy', name: 'Velocity', type: 'velocity' },
    { id: 'lobby', name: 'Lobby', type: 'paper', network: { proxy: 'proxy', key: 'lobby' } },
    { id: 'survival', name: 'Survival', type: 'paper', network: { proxy: 'proxy', key: 'survival' } },
  ];
  const minecraft = {
    list: () => mcList,
    isProxy: (s) => s.type === 'velocity',
    proc: (id) => ({ isRunning: () => running.has(id), extra: { playerCount: id === 'lobby' ? 3 : 0, ready: running.has(id) } }),
    dir: (id) => path.join(base, id),
    command: async (id, cmd) => { said.push(`${id}: ${cmd}`); },
    start: async (id) => { calls.push(`start mc:${id}`); if (id === 'broken') throw new Error('crash'); running.add(id); },
    stop: async (id) => { calls.push(`stop mc:${id}`); running.delete(id); },
    restart: async (id) => { calls.push(`restart mc:${id}`); },
  };
  const gl = [{ id: 'vh-1', name: 'Valheim', gameName: 'Valheim', running: false }, { id: 'bad-1', name: 'Broken', running: false }];
  const games = {
    list: () => gl,
    get: (id) => gl.find((x) => x.id === id),
    // Valheim antwortet erst beim zweiten Mal auf die Abfrage – der Verbund wartet so lange
    live: async (s) => { s.asked = (s.asked || 0) + 1; return s.asked > 1 ? { players: 0 } : null; },
    send: async (s, cmd) => { said.push(`${s.id}: ${cmd}`); },
    run: (id, action) => ({ promise: id === 'bad-1' ? Promise.reject(new Error('boom')) : Promise.resolve(calls.push(`${action} game:${id}`)).then(() => { gl.find((x) => x.id === id).running = action !== 'stop'; }) }),
  };
  const jobs = [];
  const host = {
    S, calls, jobs, said, mcList,
    ctx: { settings: { get: () => S, save: () => {} }, minecraft, games },
    t: (s, v) => fill(lang === 'de' && de[s] ? de[s] : s, v),
    broadcast: () => {},
    core: (n) => ({ jobs: { runJob: (title, fn) => { const job = { log: () => {}, progress: () => {} }; const promise = fn(job); jobs.push({ title, promise }); return { id: 'j', promise }; } } }[n]),
  };
  return host;
}

test('groups live in settings.gameNetwork; names and members are checked', () => {
  const h = world('de');
  const n = new GameNetwork(h);
  assert.throws(() => n.create({ name: ' ' }), /Bitte gib dem Verbund einen Namen/);
  const g = n.create({ name: 'Abend', members: [{ kind: 'game', id: 'vh-1' }, { kind: 'game', id: 'vh-1' }, { kind: 'evil', id: 'x' }], delay: 999 });
  assert.strictEqual(h.S.gameNetwork.groups.length, 1);
  assert.strictEqual(g.members.length, 1, 'duplicates and unknown kinds dropped');
  assert.strictEqual(g.delay, 120, 'pause capped');
  assert.strictEqual(n.update(g.id, { name: 'Spieleabend' }).name, 'Spieleabend');
  n.remove(g.id);
  assert.throws(() => n.get(g.id), /Verbund nicht gefunden/);
});

test('Velocity network is found and taken over; proxy starts last and stops first', () => {
  const n = new GameNetwork(world());
  const p = n.proxies();
  assert.strictEqual(p.length, 1);
  assert.deepStrictEqual(p[0].members.map((m) => m.id), ['lobby', 'survival']);
  const g = n.fromProxy('proxy');
  assert.ok(n.proxies()[0].taken);
  const gg = n.get(g.id);
  assert.deepStrictEqual(n.order(gg, 'start').map((m) => m.id), ['lobby', 'survival', 'proxy']);
  assert.deepStrictEqual(n.order(gg, 'stop').map((m) => m.id), ['proxy', 'survival', 'lobby']);
  const v = n.view(gg);
  assert.strictEqual(v.state, 'partial');
  assert.strictEqual(v.players, 3);
  assert.throws(() => n.fromProxy('lobby'), /not a Velocity proxy/);
});

test('start all: already running ones are skipped, the proxy comes last', async () => {
  const h = world();
  const n = new GameNetwork(h); n.pollMs = 5; n.readyMs = 200;
  const g = n.fromProxy('proxy');
  n.update(g.id, { delay: 0 });
  await n.run(g.id, 'start').promise;
  assert.deepStrictEqual(h.calls, ['start mc:survival', 'start mc:proxy']);
});

test('a failing member is reported, the others still run', async () => {
  const h = world('de');
  const n = new GameNetwork(h); n.pollMs = 5; n.readyMs = 200;
  const g = n.create({ name: 'Mix', members: [{ kind: 'game', id: 'bad-1' }, { kind: 'game', id: 'vh-1' }] });
  await assert.rejects(n.run(g.id, 'start').promise, /Nicht alles hat geklappt: Broken/);
  assert.deepStrictEqual(h.calls, ['start game:vh-1']);
  assert.throws(() => n.run(g.id, 'explode'), /Unbekannte Aktion/);
});

test('activate provides gameNetwork with routes', () => {
  const h = world();
  const routes = []; const provided = {};
  ext.activate({ ...h, router: new Proxy({}, { get: (_, m) => (p) => routes.push(`${m.toUpperCase()} ${p}`) }), provide: (k, v) => { provided[k] = v; return v; } });
  assert.ok(provided.gameNetwork instanceof GameNetwork);
  for (const r of ['GET /game-network', 'GET /game-network/totals', 'GET /game-network/member/:kind/:id', 'POST /game-network', 'POST /game-network/from-proxy/:proxy', 'POST /game-network/:id/:action']) assert.ok(routes.includes(r), r);
  provided.gameNetwork.stopTimer();
});

test('every German text has a value', () => {
  for (const [k, v] of Object.entries(de)) if (k !== '$patterns') assert.ok(typeof v === 'string' && v.trim(), k);
});

test('waits until a game server answers the query before the next one starts', async () => {
  const h = world();
  const n = new GameNetwork(h); n.pollMs = 5; n.readyMs = 500;
  const g = n.create({ name: 'Abend', members: [{ kind: 'game', id: 'vh-1' }, { kind: 'mc', id: 'survival' }] });
  await n.run(g.id, 'start').promise;
  assert.deepStrictEqual(h.calls, ['start game:vh-1', 'start mc:survival']);
  assert.ok(h.ctx.games.get('vh-1').asked >= 2, 'asked again until it answered');
});

test('a failed backend keeps the proxy off – unless forced', async () => {
  const h = world('de');
  h.mcList.push({ id: 'broken', name: 'Kaputt', type: 'paper', network: { proxy: 'proxy' } });
  const n = new GameNetwork(h); n.pollMs = 5; n.readyMs = 100;
  const g = n.fromProxy('proxy');
  n.update(g.id, { delay: 0 });
  await assert.rejects(n.run(g.id, 'start').promise, /Proxy wurde nicht gestartet/);
  assert.ok(!h.calls.includes('start mc:proxy'));
  await assert.rejects(n.run(g.id, 'start', { force: true }).promise, /Nicht alles hat geklappt/);
  assert.ok(h.calls.includes('start mc:proxy'));
});

test('scheduled restart: announcement first, then the restart – each once a day', () => {
  const g = { id: 'g1', restart: { enabled: true, at: '05:00', warn: 5 } };
  const at = new Date(2026, 9, 21, 5, 0).getTime();
  const fired = new Set();
  assert.strictEqual(due(g, at - 10 * 60000, fired), null);
  assert.strictEqual(due(g, at - 4 * 60000, fired), 'warn');
  fired.add('g1:2026-10-21:warn');
  assert.strictEqual(due(g, at - 2 * 60000, fired), null);
  assert.strictEqual(due(g, at + 30000, fired), 'restart');
  fired.add('g1:2026-10-21:restart');
  assert.strictEqual(due(g, at + 60000, fired), null);
  assert.strictEqual(due(g, at + 3 * 3600000, new Set()), null, 'missed by hours: no restart in the middle of the day');
  assert.strictEqual(due({ ...g, restart: { ...g.restart, enabled: false } }, at, new Set()), null);
});

test('tick announces in the chat of the running backends (not the proxy)', async () => {
  const h = world('de');
  const n = new GameNetwork(h);
  const g = n.fromProxy('proxy');
  n.update(g.id, { restart: { enabled: true, at: '05:00', warn: 5 } });
  await n.tick(new Date(2026, 9, 21, 4, 57).getTime());
  assert.deepStrictEqual(h.said, ['lobby: say Geplanter Neustart des Verbunds in 5 Minuten.']);
});

test('totals and member lookup; Minecraft networks are pointed to mc-network', () => {
  const h = world();
  const n = new GameNetwork(h);
  const g = n.fromProxy('proxy');
  assert.strictEqual(n.view(n.get(g.id)).geyser, undefined, 'Bedrock lives in mc-network now');
  assert.strictEqual(n.view(n.get(g.id)).mcNetwork, false);
  assert.deepStrictEqual(n.totals(), { networks: 1, servers: 3, running: 1, players: 3 });
  assert.strictEqual(n.forMember('mc', 'survival').length, 1);
  assert.strictEqual(n.forMember('game', 'vh-1').length, 0);
  assert.deepStrictEqual(n.view(n.get(g.id)).restart, { enabled: false, at: '05:00', warn: 5 });
});
