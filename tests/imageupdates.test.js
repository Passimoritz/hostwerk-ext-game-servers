'use strict';
/*
 * Security updates for Docker game servers without Docker or Docker Hub: which servers count, digest comparison, trial
 * (container made again, has to keep running), fallback to the previous image, registration with Hostwerk.
 */
const test = require('node:test');
const assert = require('node:assert');
const { imageSource } = require('../server/imageupdates');
const ext = require('../server/index');

/** Fake GameServers with a scripted docker. */
function fakeGs({ remote = 'sha256:bbbbbbbbbbbbbbbb', localDigest = 'sha256:aaaaaaaaaaaaaaaa', keepsRunning = true } = {}) {
  const calls = [];
  const servers = [
    { id: 'vh', name: 'Valheim', game: 'vhserver', mode: 'docker', installed: true },
    { id: 'rs', name: 'Rust', game: 'rustserver', mode: 'native', installed: true },
    { id: 'st', name: 'Palworld', kind: 'steam', mode: 'docker', installed: true },
  ];
  let running = true;
  const gs = {
    list: () => servers, get: (id) => servers.find((s) => s.id === id), isDocker: (s) => s.mode === 'docker', isSteam: (s) => s.kind === 'steam',
    cname: (s) => `hostwerk-game-${s.id}`, lgsmCreateArgs: (s) => ['create', '--name', `hostwerk-game-${s.id}`], lgsmSpecHash: () => 'h2',
    running: async () => running, broadcast: () => {},
    ctx: { settings: { save() {} }, docker: { status: async () => ({ running: true }), pullInto: async (job, image) => { calls.push(`pull ${image}`); } } },
    dx: async (args) => {
      calls.push(args.join(' '));
      const a = args.join(' ');
      if (a.includes('RepoDigests')) return { code: 0, stdout: JSON.stringify([`gameservermanagers/gameserver@${localDigest}`]) };
      if (a.includes('{{.Id}}')) return { code: 0, stdout: 'sha256:oldid' };
      if (a.includes('{{.State.Running}}')) return { code: 0, stdout: keepsRunning ? 'true' : 'false' };
      if (args[0] === 'stop') running = false;
      return { code: 0, stdout: '' };
    },
  };
  return { gs, calls, servers, hub: async (url) => { calls.push(`hub ${url.split('/').pop()}`); return { digest: remote, last_updated: '2026-10-20' }; } };
}

test('only LinuxGSM servers in Docker count; same digest = nothing to do', async () => {
  const f = fakeGs({ remote: 'sha256:aaaaaaaaaaaaaaaa' });
  const src = imageSource(f.gs, null, { fetchJson: f.hub, wait: async () => {} });
  assert.deepStrictEqual(src.items().map((x) => x.key), ['game-vh']);
  assert.deepStrictEqual(await src.updates(), []);
});

test('new image: pulled, container made again and started, has to keep running', async () => {
  const f = fakeGs();
  const src = imageSource(f.gs, null, { fetchJson: f.hub, wait: async () => {} });
  const [u] = await src.updates();
  assert.strictEqual(u.key, 'game-vh');
  assert.strictEqual(u.latest, 'bbbbbbbbbbbb');
  const p = src.plan(u);
  await p.install(); await p.probe(); await p.activate();
  assert.ok(f.calls.includes('pull gameservermanagers/gameserver:vh'));
  assert.ok(f.calls.includes('rm -f hostwerk-game-vh') && f.calls.includes('create --name hostwerk-game-vh') && f.calls.includes('start hostwerk-game-vh'));
  assert.strictEqual(f.servers[0].specHash, 'h2');
});

test('server stops with the new image: previous image back, container made again', async () => {
  const f = fakeGs({ keepsRunning: false });
  const src = imageSource(f.gs, { t: (s, v) => s.replace('{name}', v.name) }, { fetchJson: f.hub, wait: async () => {} });
  const [u] = await src.updates();
  const p = src.plan(u);
  await p.install();
  await assert.rejects(p.probe(), /Valheim does not keep running/);
  await p.discard();
  assert.ok(f.calls.includes('tag sha256:oldid gameservermanagers/gameserver:vh'), f.calls.join('\n'));
});

test('activate registers the update source with Hostwerk and removes it on shutdown', () => {
  process.env.HW_TEST = '1';
  const reg = []; const hooks = {};
  const host = {
    ctx: { settings: { get: () => ({ general: {} }), save() {} }, paths: { base: require('os').tmpdir(), cache: require('os').tmpdir() }, patchUpdates: { register: (id) => { reg.push(id); return () => reg.splice(reg.indexOf(id), 1); } } },
    router: new Proxy({}, { get: () => () => {} }), t: (s) => s, core: () => ({ registerResumer() {}, runJob() {} }), broadcast() {},
    provide: (n, o) => o, on: (ev, fn) => { (hooks[ev] = hooks[ev] || []).push(fn); },
  };
  ext.activate(host);
  assert.deepStrictEqual(reg, ['game-servers']);
  hooks.shutdown[0]();
  assert.deepStrictEqual(reg, []);
});
