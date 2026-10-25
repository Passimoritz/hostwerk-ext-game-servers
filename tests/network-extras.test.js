'use strict';
/*
 * 1.2: shared settings (password, player slots), backups of the whole network (by hand and on schedule), ports with
 * conflicts, router forwardings with owner "game-network", players per server and in total – all with fake servers.
 */
const test = require('node:test');
const assert = require('node:assert');
const { GameNetwork, due } = require('../server/network');

function world() {
  const S = {};
  const calls = [];
  const fwd = [];
  const mcList = [
    { id: 'lobby', name: 'Lobby', type: 'paper', port: 25566, network: { proxy: 'proxy', key: 'lobby' } },
    { id: 'solo', name: 'Solo', type: 'paper', port: 27015, geyser: { port: 19132 } },
  ];
  const gl = [
    { id: 'ark1', name: 'ARK Island', kind: 'steam', running: true, ports: [{ name: 'Game', port: 7777, proto: 'udp' }, { name: 'Query', port: 27015, proto: 'udp' }] },
    { id: 'ark2', name: 'ARK Scorched', kind: 'steam', running: false, ports: [{ name: 'Game', port: 7779, proto: 'udp' }] },
    { id: 'vh', name: 'Valheim', running: false, ports: [{ name: 'Game', port: 2456, proto: 'udp/tcp' }] },
    { id: 'other', name: 'Other PC game', running: false, ports: [{ name: 'Game', port: 7779, proto: 'udp' }] },
  ];
  const minecraft = {
    list: () => mcList, get: (id) => mcList.find((x) => x.id === id), isProxy: () => false,
    proc: () => ({ isRunning: () => false, extra: {} }),
    setProperties: (id, v) => calls.push(['props', id, v]),
    backup: (id, label) => ({ promise: Promise.resolve(calls.push(['mc-backup', id, label])) }),
  };
  const games = {
    list: () => gl, get: (id) => gl.find((x) => x.id === id), portsOf: (s) => s.ports,
    live: async (s) => (s.id === 'ark1' ? { players: 4, maxPlayers: 70 } : null),
    steamSet: (s, b) => calls.push(['steam', s.id, b]),
    quickSet: async (s, b) => calls.push(['lgsm', s.id, b]),
    run: (id, action) => ({ promise: Promise.resolve(calls.push([action, id])) }),
  };
  const router = { cfg: { auto: true }, forwards: { owned: (o) => fwd.filter((x) => x.owner === o), add: async (x, o) => { fwd.push({ port: x.port, protocol: x.protocol, owner: o }); }, remove: async (x, o) => { const i = fwd.findIndex((y) => y.port === x.port && y.protocol === x.protocol && y.owner === o); if (i >= 0) fwd.splice(i, 1); return i >= 0; } } };
  const host = {
    ctx: { settings: { get: () => S, save: () => {} }, minecraft, games, router },
    t: (s, v) => (v ? String(s).replace(/\{(\w+)\}/g, (m, k) => (v[k] !== undefined ? v[k] : m)) : s),
    broadcast: () => {},
    core: () => ({ runJob: (title, fn) => { const job = { log: () => {}, progress: () => {} }; return { id: 'j', promise: fn(job) }; } }),
  };
  return { host, calls, fwd, S };
}

test('cluster with a shared password and slots: Steam servers, LinuxGSM servers and Minecraft each the right way', async () => {
  const w = world();
  const n = new GameNetwork(w.host);
  const g = n.create({ name: 'ARK cluster', members: [{ kind: 'game', id: 'ark1' }, { kind: 'game', id: 'ark2' }, { kind: 'game', id: 'vh' }, { kind: 'mc', id: 'solo' }] });
  assert.throws(() => n.applyShared(g.id, { password: 'has space' }), /may not contain/);
  assert.throws(() => n.applyShared(g.id, { maxPlayers: 5000 }), /between 1 and 1000/);
  const r = await n.applyShared(g.id, { password: 'geheim1', maxPlayers: 20 }).promise;
  assert.deepStrictEqual(w.calls.filter((c) => c[0] === 'steam').map((c) => c[1]), ['ark1', 'ark2']);
  assert.deepStrictEqual(w.calls.find((c) => c[0] === 'lgsm')[2], { serverpassword: 'geheim1', maxplayers: '20' });
  assert.deepStrictEqual(w.calls.find((c) => c[0] === 'props')[2], { 'max-players': '20' });
  assert.ok(r.results.find((x) => x.name === 'Solo').note, 'Minecraft has no password – says so');
  const v = n.view(n.get(g.id));
  assert.deepStrictEqual(v.shared, { maxPlayers: 20, password: true }, 'the password itself is not sent to the page');
});

test('backups: by hand and on schedule – each server its own way, the proxy is skipped', async () => {
  const w = world();
  const n = new GameNetwork(w.host);
  const g = n.create({ name: 'Weekend', members: [{ kind: 'game', id: 'vh' }, { kind: 'mc', id: 'solo' }], backup: { enabled: true, at: '04:30' } });
  await n.backupAll(g.id).promise;
  assert.deepStrictEqual(w.calls.filter((c) => /backup/.test(c[0])), [['backup', 'vh'], ['mc-backup', 'solo', 'Weekend']]);
  const fired = new Set();
  const at = new Date(2026, 9, 21, 4, 31).getTime();
  assert.strictEqual(due(n.get(g.id), at, fired), 'backup');
  fired.add(`${g.id}:2026-10-21:backup`);
  assert.strictEqual(due(n.get(g.id), at, fired), null, 'once a day');
  assert.strictEqual(due(n.get(g.id), new Date(2026, 9, 21, 12, 0).getTime(), new Set()), null, 'a missed time is not made up hours later');
});

test('ports: conflicts with other servers on this PC, Minecraft behind a proxy has no public port, Bedrock counts', () => {
  const w = world();
  const n = new GameNetwork(w.host);
  const g = n.create({ name: 'Mix', members: [{ kind: 'game', id: 'ark2' }, { kind: 'game', id: 'vh' }, { kind: 'mc', id: 'lobby' }, { kind: 'mc', id: 'solo' }] });
  const p = n.ports(g.id);
  const row = (port, proto) => p.ports.find((x) => x.port === port && x.proto === proto);
  assert.deepStrictEqual(row(7779, 'UDP').conflict, ['Other PC game']);
  assert.ok(row(2456, 'TCP') && row(2456, 'UDP'), 'udp/tcp becomes two ports');
  assert.ok(!p.ports.some((x) => x.port === 25566), 'server behind a proxy listens on 127.0.0.1 only');
  assert.ok(row(19132, 'UDP'), 'Geyser port of a single server');
  assert.deepStrictEqual(row(27015, 'TCP').conflict, [], 'TCP 27015 (Minecraft) does not clash with UDP 27015 (ARK query)');
  assert.strictEqual(p.conflicts, 1);
});

test('router: forward the whole network in one go (owner game-network), conflicting ports are left out; and back', async () => {
  const w = world();
  const n = new GameNetwork(w.host);
  const g = n.create({ name: 'Mix', members: [{ kind: 'game', id: 'ark2' }, { kind: 'game', id: 'vh' }] });
  const r = await n.forward(g.id, true);
  assert.deepStrictEqual(w.fwd.map((x) => `${x.port}/${x.protocol}/${x.owner}`).sort(), ['2456/TCP/game-network', '2456/UDP/game-network']);
  assert.ok(r.results.some((x) => x.port === 7779 && !x.ok && /also used/.test(x.why)));
  assert.ok(r.ports.find((x) => x.port === 2456).forwarded);
  await n.forward(g.id, false);
  assert.strictEqual(w.fwd.length, 0);
  delete w.host.ctx.router;
  await assert.rejects(n.forward(g.id, true), /Router & port forwarding/);
});

test('players per server and in total (A2S for game servers)', async () => {
  const w = world();
  const n = new GameNetwork(w.host);
  const g = n.create({ name: 'ARK', members: [{ kind: 'game', id: 'ark1' }, { kind: 'game', id: 'ark2' }] });
  const l = await n.live(g.id);
  assert.strictEqual(l.players, 4);
  assert.deepStrictEqual(l.members.map((x) => [x.id, x.players, x.max]), [['ark1', 4, 70], ['ark2', 0, null]]);
});
