'use strict';
/*
 * Spielstände in der Sicherungs-Zentrale ohne echte Server: Liste, Zurückspielen (vorher sichern, Server stoppen und
 * wieder starten), Löschen, externe Sicherung und die Anmeldung bei Hostwerk (neu und alt).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { backupSource, registerBackups, parseId } = require('../server/backupsource');

function fake() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-bk-'));
  const servers = [
    { id: 'valheim', name: 'Valheim', kind: 'steam', mode: 'native', saves: 'saves' },
    { id: 'rust', name: 'Rust', kind: 'lgsm', mode: 'native' },
    { id: 'ark', name: 'ARK', kind: 'steam', mode: 'docker', saves: 'Saved' },
  ];
  const calls = [];
  let alive = true;
  const games = {
    list: () => servers,
    get: (id) => { const s = servers.find((x) => x.id === id); if (!s) throw Object.assign(new Error('Game server not found'), { status: 404 }); return s; },
    dir: (s) => path.join(root, s.id),
    isSteam: (s) => s.kind === 'steam',
    isDocker: (s) => s.mode === 'docker',
    backups: (s) => { const d = path.join(root, s.id, 'backups'); if (!fs.existsSync(d)) return []; return fs.readdirSync(d).map((file) => ({ file, size: fs.statSync(path.join(d, file)).size, time: fs.statSync(path.join(d, file)).mtimeMs })).sort((a, b) => b.time - a.time || b.file.localeCompare(a.file)); },
    run: (id, cmd) => { calls.push(`${cmd}:${id}`); if (cmd === 'stop') alive = false; if (cmd === 'start') alive = true; return { promise: Promise.resolve({ ok: true }) }; },
    steam: { alive: async () => alive, restore: async (s, file) => { calls.push(`restore:${file}`); if (alive) throw new Error('Stop the server first.'); return { ok: true, text: 'Restored' }; } },
  };
  const put = (rel, text = 'x') => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f; };
  put('valheim/saves/world.db', 'world');
  put('valheim/backups/valheim-20261001-120000.zip', 'zip1');
  put('rust/backups/rust-auto-2026.tar.gz', 'tar');
  const zipped = [];
  const deps = {
    t: (s, v) => (v ? s.replace(/\{(\w+)\}/g, (m, k) => v[k]) : s),
    runJob: (title, fn) => { const job = { log() {}, progress() {}, status() {} }; const promise = fn(job); return { id: 'job1', title, promise }; },
    zipDir: async (src, dest) => { zipped.push([path.basename(src), path.basename(dest)]); fs.writeFileSync(dest, 'packed'); return dest; },
  };
  return { root, games, deps, calls, zipped, src: backupSource(games, deps) };
}

test('id: server and file name only – no paths', () => {
  const err = (status, text) => Object.assign(new Error(text), { status });
  assert.deepStrictEqual(parseId('valheim~a.zip', err), { server: 'valheim', file: 'a.zip' });
  for (const bad of ['valheim~../x.zip', 'valheim~a.txt', '~a.zip', 'valheim', 'va/l~a.zip', 'valheim~sub/a.zip']) assert.throws(() => parseId(bad, err), /Backup not found/, bad);
});

test('list: backups of every server with name, size and time; Docker without', () => {
  const { src } = fake();
  const items = src.list();
  assert.deepStrictEqual(items.map((x) => x.id).sort(), ['rust~rust-auto-2026.tar.gz', 'valheim~valheim-20261001-120000.zip']);
  const v = items.find((x) => x.svc === 'valheim');
  assert.strictEqual(v.svcName, 'Valheim'); assert.strictEqual(v.size, 4); assert.strictEqual(v.stopsService, true); assert.strictEqual(v.label, 'valheim-20261001-120000');
  assert.strictEqual(items.find((x) => x.svc === 'rust').auto, true);
});

test('restore: stops the server, backs up the current state first, restores, starts again', async () => {
  const { src, calls, zipped, games } = fake();
  const job = src.restore('valheim~valheim-20261001-120000.zip');
  const r = await job.promise;
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(calls, ['stop:valheim', 'restore:valheim-20261001-120000.zip', 'start:valheim']);
  assert.strictEqual(zipped.length, 1); assert.match(zipped[0][1], /^valheim-\d{8}-\d{6}-before-restore\.zip$/);
  assert.ok(games.backups(games.get('valheim')).some((b) => /before-restore/.test(b.file)), 'the state before shows up as its own backup');
});

test('restore: LinuxGSM and Docker say why not, unknown backups are 404', () => {
  const { src } = fake();
  assert.throws(() => src.restore('rust~rust-auto-2026.tar.gz'), /LinuxGSM/);
  assert.throws(() => src.restore('valheim~missing.zip'), (e) => e.status === 404);
  assert.throws(() => src.restore('nope~a.zip'), (e) => e.status === 404);
});

test('remove: deletes exactly that file', () => {
  const { src, root } = fake();
  src.remove('rust~rust-auto-2026.tar.gz');
  assert.strictEqual(fs.existsSync(path.join(root, 'rust/backups/rust-auto-2026.tar.gz')), false);
  assert.strictEqual(fs.existsSync(path.join(root, 'valheim/backups/valheim-20261001-120000.zip')), true);
});

test('offsite: fresh save zip for Steam servers, newest LinuxGSM backup, Docker skipped with a note', async () => {
  const { src } = fake();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-off-'));
  const logs = [];
  const files = await src.offsite({ dir, job: { log: (t) => logs.push(t) } });
  assert.deepStrictEqual(files.map((f) => path.basename(f)).sort(), ['game-rust-rust-auto-2026.tar.gz', 'game-valheim.zip']);
  for (const f of files) assert.ok(fs.existsSync(f));
  assert.ok(logs.some((l) => /ARK: runs in Docker/.test(l)));
});

test('register: host.backups (Hostwerk 2.12+), else ctx.backupCenter, else nothing', () => {
  const seen = [];
  const off = () => {};
  assert.strictEqual(registerBackups({ backups: { register: (d) => { seen.push(['host', d]); return off; } } }, { list() {} }), off);
  registerBackups({ id: 'game-servers', ctx: { backupCenter: { register: (id) => { seen.push(['ctx', id]); return off; } } } }, { list() {} });
  assert.deepStrictEqual(seen.map((x) => x[0]), ['host', 'ctx']); assert.strictEqual(seen[1][1], 'game-servers');
  assert.strictEqual(registerBackups({ ctx: {} }, { list() {} }), null);
});
