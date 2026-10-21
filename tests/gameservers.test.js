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

test('reachable from outside: only running public servers report their ports (TCP/UDP), the router follows in automatic mode', async () => {
  const h = fakeHost();
  let synced = 0;
  h.ctx.router = { cfg: { auto: true }, sync: async () => { synced++; return {}; } };
  const providers = new Map();
  h.ctx.security = { addPortProvider: (id, fn) => providers.set(id, fn), removePortProvider: (id) => providers.delete(id) };
  const g = new GameServers(h);
  h.S.games = { servers: [
    { id: 'a', name: 'Valheim', game: 'vhserver', public: true, running: true, detail: { ports: [{ name: 'Game', port: 2456, proto: 'udp' }, { name: 'Query', port: 2457, proto: 'tcp+udp' }] } },
    { id: 'b', name: 'Rust', game: 'rustserver', public: true, running: false, detail: { ports: [{ name: 'Game', port: 28015, proto: 'udp' }] } },
    { id: 'c', name: 'CS2', game: 'cs2server', public: false, running: true, detail: { ports: [{ name: 'Game', port: 27015, proto: 'udp' }] } },
  ] };
  assert.deepStrictEqual(g.publicPorts().map((p) => `${p.port}/${p.proto}`), ['2456/UDP', '2457/TCP', '2457/UDP']);
  g.portsChanged();
  assert.strictEqual(synced, 1);
  h.ctx.router.cfg.auto = false; g.portsChanged();
  assert.strictEqual(synced, 1, 'without automatic mode the router is left alone');
  assert.strictEqual(g.info(h.S.games.servers[0]).outside.supported, true);
});

/* ---------- Container: als Nutzer des Images ausführen, Zustand „wird installiert“, gesperrte Befehle ---------- */

const { execUserOf } = require('../server/gameservers');
// Zeitstempel kurz vor jetzt (sonst greift das Zeitlimit) – Zeilen wie aus docker logs --timestamps
const ago = (sec) => new Date(Date.now() - sec * 1000).toISOString().replace('Z', '000000Z');
const INSTALLING = [
  `${ago(600)} Installing gmodserver`,
  `${ago(20)} \x1b[0m Update state (0x61) downloading, progress: 78.00 (5371676224 / 6886764390)`,
  `${ago(10)} \x1b[0m Update state (0x61) downloading, progress: 80.06 (5513662632 / 6886764390)`,
].join('\n');
/** Docker-Attrappe: zeichnet jeden Aufruf auf; Antworten je Befehl */
function fakeDocker(g, { logs = INSTALLING, health = 'unhealthy', exec = () => ({ code: 0, stdout: 'ok', stderr: '' }), user = '' } = {}) {
  const calls = [];
  const startedAt = new Date(Date.now() - 15 * 60000).toISOString();
  g.dx = async (args) => {
    calls.push(args);
    if (args[0] === 'inspect' && /Config/.test(args[2])) return { code: 0, stdout: JSON.stringify({ User: user, Env: ['PATH=/usr/bin', 'USER=linuxgsm', 'UID=1000'] }), stderr: '' };
    if (args[0] === 'inspect' && /State\.Health/.test(args[2])) return { code: 0, stdout: `true|${startedAt}|${health}`, stderr: '' };
    if (args[0] === 'inspect') return { code: 0, stdout: 'true', stderr: '' };
    if (args[0] === 'logs') return { code: 0, stdout: typeof logs === 'function' ? logs(args) : logs, stderr: '' };
    if (args[0] === 'exec') return exec(args);
    return { code: 0, stdout: '', stderr: '' };
  };
  g.dockerAvailable = async () => true;
  g.dockerReady = async () => {};
  return calls;
}

test('exec user: never root – Config.User, else USER of the image, else linuxgsm', () => {
  assert.strictEqual(execUserOf({ User: 'root', Env: ['USER=linuxgsm'] }), 'linuxgsm');
  assert.strictEqual(execUserOf({ User: '', Env: ['USER=steam'] }), 'steam');
  assert.strictEqual(execUserOf({ User: '1000:1000', Env: [] }), '1000:1000');
  assert.strictEqual(execUserOf({ User: '0', Env: ['USER=root'] }), 'linuxgsm');
  assert.strictEqual(execUserOf({ User: 'x; rm -rf /', Env: [] }), 'linuxgsm');
  assert.strictEqual(execUserOf({}), 'linuxgsm');
});

test('every LinuxGSM command in the container runs as the image user (no „attempted to run as root“)', async () => {
  const h = fakeHost('de');
  const g = new GameServers(h);
  const s = { id: 'gmod-1', name: "Garry's Mod", game: 'gmodserver', mode: 'docker', installed: true, running: true, readyAt: 1, cmds: { at: Date.now(), list: [{ cmd: 'send' }] } };
  h.S.games = { servers: [s] };
  const calls = fakeDocker(g, { logs: '2026-10-21T21:42:28.481396527Z [  OK  ] Starting gmodserver: LinuxGSM', health: 'healthy' });
  await g.details(s);
  await g.send(s, 'say hi');
  await g.commandsFor(s, { fresh: true });
  const execs = calls.filter((a) => a[0] === 'exec');
  assert.strictEqual(execs.length, 3);
  for (const a of execs) assert.deepStrictEqual(a.slice(0, 3), ['exec', '-u', 'linuxgsm'], a.join(' '));
  assert.strictEqual(calls.filter((a) => a[0] === 'inspect' && /Config/.test(a[2])).length, 1, 'the user is read once per container');
});

test('safety net: LinuxGSM still says „as root“ → once more as linuxgsm; root lines become a clear message', async () => {
  const h = fakeHost('de');
  const g = new GameServers(h);
  const s = { id: 'g2', name: 'Eigenes Image', game: 'gmodserver', mode: 'docker', installed: true, running: true };
  h.S.games = { servers: [s] };
  const ROOT = 'Oct 21 21:43:36.323 gmodserver: CORE: FAIL: gmodserver attempted to run as root.\nOct 21 21:43:36.345 gmodserver: CORE: FAIL: core_exit.sh exiting with code: 1';
  const calls = fakeDocker(g, { user: 'steam', exec: (a) => (a[2] === 'steam' ? { code: 1, stdout: ROOT, stderr: '' } : { code: 0, stdout: 'Details', stderr: '' }) });
  const r = await g.lgsmExec(s, ['details']);
  assert.strictEqual(r.stdout, 'Details');
  assert.deepStrictEqual(calls.filter((a) => a[0] === 'exec').map((a) => a[2]), ['steam', 'linuxgsm']);
  assert.strictEqual(g.failText('update', 1, ROOT), 'Aktualisieren (SteamCMD) hat nicht geklappt: LinuxGSM läuft nicht als root.');
  assert.doesNotMatch(g.failText('backup', 1, 'Error! App \'4020\' state is 0x202 after update job.'), /Code 1/);
});

test('installing in the container: state „installing“ with progress, care commands refused clearly, stop still works', async () => {
  const h = fakeHost('de');
  const g = new GameServers(h);
  const s = { id: 'gmod-3', name: "Garry's Mod", game: 'gmodserver', mode: 'docker', installed: true, wantRun: true };
  h.S.games = { servers: [s] };
  const calls = fakeDocker(g);
  await g.refresh(s);
  assert.strictEqual(s.running, true, 'the container runs – the state says what it does');
  const info = g.info(s);
  assert.strictEqual(info.phase.state, 'installing');
  assert.match(info.phase.text, /^Herunterladen: 5,1 GB von 6,4 GB/);
  assert.strictEqual(g.summary()[0].phase.state, 'installing');
  for (const cmd of ['update', 'validate', 'check-update', 'backup', 'update-lgsm', 'mods-install', 'restart']) {
    assert.throws(() => g.run(s.id, cmd), (e) => e.status === 409 && e.code === 'GAME_BUSY' && /wird noch installiert/.test(e.message) && /Erst|sobald die Installation fertig/.test(e.message), cmd);
  }
  await assert.rejects(g.send(s, 'status'), /wird noch installiert/);
  const d = await g.details(s);
  assert.strictEqual(d.busy, true);
  assert.ok(!calls.some((a) => a[0] === 'exec'), 'no LinuxGSM command runs into the installation');
  // Stoppen geht (die Attrappe von runJob führt nichts aus – es zählt, dass kein Fehler kommt)
  assert.ok(g.run(s.id, 'stop'));
  assert.ok(g.run(s.id, 'kill'));
  // Konsole: zusammengefasst, Rohausgabe auf Wunsch
  const many = ['Installing gmodserver', ...Array.from({ length: 300 }, (_, i) => ` Update state (0x61) downloading, progress: ${i / 10} (${i} / 100)`)].join('\n');
  g.dx = async (a) => (a[0] === 'logs' ? { code: 0, stdout: many, stderr: '' } : { code: 0, stdout: '', stderr: '' });
  assert.strictEqual((await g.consoleLogAsync(s, 400)).length, 2);
  assert.strictEqual((await g.consoleLogAsync(s, 400, { raw: true })).length, 301);
});

test('after the installation: „ready“ by itself, buttons free again; a running update job counts as „updating“', async () => {
  const h = fakeHost('de');
  const g = new GameServers(h);
  const s = { id: 'gmod-4', name: "Garry's Mod", game: 'gmodserver', mode: 'docker', installed: true };
  h.S.games = { servers: [s] };
  let text = INSTALLING;
  fakeDocker(g, { logs: () => text });
  await g.refresh(s);
  assert.strictEqual(g.info(s).phase.state, 'installing');
  text = `${INSTALLING}\n${ago(5)} Install Complete!\n${ago(1)} [  OK  ] Starting gmodserver: LinuxGSM`;
  await g.trackDocker(s, await g.dockerState(s), { force: true });
  assert.strictEqual(g.info(s).phase, null, 'ready → no phase, the interface shows „Läuft“');
  assert.ok(s.readyAt, 'remembered: next SteamCMD output means updating');
  assert.ok(g.run(s.id, 'update'), 'care commands work again');
  // SteamCMD-Weg: laufende Update-Aufgabe → „wird aktualisiert“
  const st = { id: 'st-1', name: 'Valheim', kind: 'steam', appid: 896660, game: 'steam-896660', installed: true, running: false };
  h.S.games.servers.push(st);
  h.core('jobs').listJobs = () => [{ id: 'j9', key: 'game-st-1-update', state: 'running', progress: 42, text: 'Herunterladen: 1,0 GB von 2,0 GB', startedAt: 1234 }];
  assert.deepStrictEqual(g.phaseNow(st), { state: 'updating', pct: 42, text: 'Herunterladen: 1,0 GB von 2,0 GB', since: 1234, job: 'j9' });
  assert.throws(() => g.run(st.id, 'backup'), /wird gerade aktualisiert/);
  delete h.core('jobs').listJobs;
});

test('the container is created with UPDATE_ON_START=true (the image checks for "true" – "1" switched it off)', () => {
  const g = new GameServers(fakeHost());
  const args = g.lgsmCreateArgs({ id: 'v', game: 'vhserver', ports: [] });
  assert.ok(args.includes('UPDATE_ON_START=true'));
  assert.ok(!args.includes('UPDATE_ON_START=1'));
});

test('the task window: while busy a watching task shows the bar; it ends when the server is ready', async () => {
  const h = fakeHost('de');
  const g = new GameServers(h);
  g.watchInTests = true; g.watchMs = 1;
  const s = { id: 'gmod-5', name: "Garry's Mod", game: 'gmodserver', mode: 'docker', installed: true };
  h.S.games = { servers: [s] };
  let text = INSTALLING;
  fakeDocker(g, { logs: () => text });
  const progress = [];
  let watch = null;
  h.core('jobs').runJob = (title, fn, opts) => { if (watch && watch.opts.key === opts.key) return watch; const job = { progress: (p, t) => progress.push([p, t]), onCancel: () => {}, checkpoint: async () => {} }; watch = { title, opts, promise: fn(job) }; return watch; };
  await g.refresh(s);
  assert.ok(watch, 'a task was started');
  assert.strictEqual(watch.title, "Garry's Mod: wird installiert");
  assert.strictEqual(watch.opts.key, 'game-gmod-5-watch');
  await new Promise((r) => setTimeout(r, 30));
  text = `${INSTALLING}\n${ago(1)} [  OK  ] Starting gmodserver: LinuxGSM`;
  const res = await watch.promise;
  assert.match(res.text, /ist bereit/);
  assert.ok(progress.some(([p, t]) => p > 70 && /^Herunterladen/.test(t)));
});
