'use strict';
/*
 * Zustand eines laufenden Spiele-Servers aus seiner Ausgabe (server/phase.js) – mit echten Zeilen aus dem offiziellen
 * LinuxGSM-Image (Garry's Mod, Erstinstallation 21.10.2026) und denselben Mustern für andere Spiele (Valheim, Rust, ARK):
 * Installieren mit Fortschritt in Worten, Update beim Start, Starten, bereit, Zeitlimit-Rückfall, Fehlstart,
 * zusammengefasste Konsole und verständliche Ursachen statt „Code 1“.
 */
const test = require('node:test');
const assert = require('node:assert');
const P = require('../server/phase');
const de = require('../locales/de.json');

const fill = (s, v) => (v ? String(s).replace(/\{(\w+)\}/g, (m, k) => (v[k] !== undefined ? v[k] : m)) : s);
const TDE = (s, v) => fill(de[s] || s, v);
const E = '\x1b[0m';
const at = (iso) => Date.parse(iso);
// Echte Zeilen (docker logs --timestamps) – Passwörter/IP-Adressen weggelassen
const GMOD_INSTALL = [
  '2026-10-21T21:25:09.345828018Z Welcome to the LinuxGSM',
  '2026-10-21T21:25:09.352962541Z GAMESERVER: gmodserver',
  '2026-10-21T21:25:10.275371109Z creating gmodserver',
  '2026-10-21T21:25:10.660363840Z Installing gmodserver',
  '2026-10-21T21:25:10.660366580Z =================================',
  '2026-10-21T21:25:18.662248155Z Installing SteamCMD',
  '2026-10-21T21:25:18.903244677Z Installing Garry\'s Mod Server',
  '2026-10-21T21:25:19.939488514Z [ .... ] Installing gmodserver: SteamCMD\r[ START ] Installing gmodserver: SteamCMD',
  '2026-10-21T21:25:30.537907820Z [  0%] Downloading update (0 of 41,425 KB)...',
  '2026-10-21T21:25:30.540531744Z [100%] Downloading update (41,425 of 41,425 KB)...',
  '2026-10-21T21:25:40.568088461Z Connecting anonymously to Steam Public...OK',
  `2026-10-21T21:25:47.212379366Z ${E} Update state (0x3) reconfiguring, progress: 0.00 (0 / 0)`,
  `2026-10-21T21:25:53.248350929Z ${E} Update state (0x61) downloading, progress: 0.17 (11827560 / 6886764390)`,
  `2026-10-21T21:39:00.000000000Z ${E} Update state (0x61) downloading, progress: 78.00 (5371676224 / 6886764390)`,
  `2026-10-21T21:39:10.000000000Z ${E} Update state (0x61) downloading, progress: 80.06 (5513662632 / 6886764390)`,
];
const GMOD_DONE = [
  `2026-10-21T21:41:58.854175500Z ${E} Update state (0x81) verifying update, progress: 25.65 (1766740240 / 6886764390)`,
  '2026-10-21T21:42:00.873308944Z Success! App \'4020\' fully installed.',
  '2026-10-21T21:42:01.715498507Z Success! Installing gmodserver: SteamCMD',
  '2026-10-21T21:42:01.949613564Z Installing Gamedig',
  '2026-10-21T21:42:13.665715423Z Install Complete!',
  '2026-10-21T21:42:13.791287721Z Starting Update Checks',
  '2026-10-21T21:42:13.801201712Z Starting gmodserver',
  '2026-10-21T21:42:15.592124231Z [ .... ] Starting gmodserver: Checking for log files[ INFO ] Starting gmodserver: Checking for log files: Creating log file',
  '2026-10-21T21:42:28.481396527Z [ .... ] Starting gmodserver: LinuxGSM[  OK  ] Starting gmodserver: LinuxGSM',
];
const logs = (lines) => P.parseDockerLogs(lines.join('\n'));

test('Garry\'s Mod first install: „Wird installiert“ with size, speed and time left – then starting, then ready', () => {
  const tr = new P.PhaseTracker({ startedAt: at('2026-10-21T21:25:09Z'), T: TDE, lang: 'de' });
  tr.feed(logs(GMOD_INSTALL));
  const r = tr.result({ now: at('2026-10-21T21:39:12Z'), health: 'unhealthy' });
  assert.strictEqual(r.state, 'installing');
  assert.match(r.text, /^Herunterladen: 5,1 GB von 6,4 GB – 14 MB\/s, noch etwa 2 Min\.$/);
  assert.ok(r.pct > 70 && r.pct < 75, `bar ${r.pct}`);
  assert.deepStrictEqual(P.publicPhase(r).state, 'installing');
  tr.feed(logs(GMOD_DONE.slice(0, 1)));
  const v = tr.result({ now: at('2026-10-21T21:42:00Z') });
  assert.strictEqual(v.state, 'installing');
  assert.match(v.text, /^Download prüfen: 1,6 GB von 6,4 GB/);
  assert.ok(v.pct >= 90, 'checking comes after the download – the bar does not jump back');
  tr.feed(logs(GMOD_DONE.slice(1, 7)));
  assert.strictEqual(tr.result({ now: at('2026-10-21T21:42:14Z') }).state, 'starting');
  tr.feed(logs(GMOD_DONE.slice(7)));
  const done = tr.result({ now: at('2026-10-21T21:42:30Z') });
  assert.strictEqual(done.state, 'ready');
  assert.strictEqual(P.publicPhase(done), null, 'ready = no phase for the interface (shows „Läuft“)');
  assert.strictEqual(tr.readyBy, 'log');
});

test('lines are read in parts: nothing is counted twice, older lines are skipped', () => {
  const tr = new P.PhaseTracker({ startedAt: at('2026-10-21T21:25:09Z') });
  tr.feed(logs(GMOD_INSTALL));
  const before = tr.result({ now: at('2026-10-21T21:39:12Z') }).text;
  tr.feed(logs(GMOD_INSTALL)); // dieselben Zeilen noch einmal (--since ist inklusiv)
  assert.strictEqual(tr.result({ now: at('2026-10-21T21:39:12Z') }).text, before);
});

test('Valheim restart: update on start shows „Wird aktualisiert“, then ready', () => {
  const tr = new P.PhaseTracker({ startedAt: at('2026-10-22T08:00:00Z'), installedBefore: true, T: TDE });
  tr.feed(logs([
    '2026-10-22T08:00:01.000000000Z Welcome to the LinuxGSM',
    '2026-10-22T08:00:04.000000000Z Checking for Update vhserver',
    '2026-10-22T08:00:05.000000000Z [ .... ] Checking for update: SteamCMD',
    `2026-10-22T08:00:20.000000000Z ${E} Update state (0x61) downloading, progress: 10.00 (104857600 / 1048576000)`,
    `2026-10-22T08:00:30.000000000Z ${E} Update state (0x61) downloading, progress: 20.00 (209715200 / 1048576000)`,
  ]));
  const r = tr.result({ now: at('2026-10-22T08:00:31Z') });
  assert.strictEqual(r.state, 'updating');
  assert.match(r.text, /^Herunterladen: 200 MB von 1000 MB – 10 MB\/s, noch etwa 1 Min\.$/);
  tr.feed(logs(['2026-10-22T08:02:00.000000000Z Starting vhserver', '2026-10-22T08:02:09.000000000Z [  OK  ] Starting vhserver: Hostwerk']));
  assert.strictEqual(tr.result({ now: at('2026-10-22T08:02:10Z') }).state, 'ready');
});

test('progress without a heading (tail cut off): installing the first time, updating once it was ready before', () => {
  const line = [`2026-10-22T09:00:00.000000000Z ${E} Update state (0x61) downloading, progress: 50.00 (1 / 2)`];
  assert.strictEqual(new P.PhaseTracker({ startedAt: at('2026-10-22T08:00:00Z') }).feed(logs(line)).result({ now: at('2026-10-22T09:00:01Z') }).state, 'installing');
  assert.strictEqual(new P.PhaseTracker({ startedAt: at('2026-10-22T08:00:00Z'), installedBefore: true }).feed(logs(line)).result({ now: at('2026-10-22T09:00:01Z') }).state, 'updating');
});

test('ready from other signals: script log (Rust), healthcheck „healthy“, Steam query', () => {
  const rust = new P.PhaseTracker({ startedAt: at('2026-10-22T08:00:00Z') }).feed(logs(['2026-10-22T08:00:02.000000000Z Starting rustserver', '2026-10-22T08:01:00.000000000Z Oct 22 08:01:00.368 rustserver: START: PASS: Started Rust Server']));
  assert.strictEqual(rust.result({ now: at('2026-10-22T08:01:01Z') }).state, 'ready');
  const ark = new P.PhaseTracker({ startedAt: at('2026-10-22T08:00:00Z') }).feed(logs(['2026-10-22T08:00:02.000000000Z Starting arkserver']));
  assert.strictEqual(ark.result({ now: at('2026-10-22T08:01:00Z') }).state, 'starting');
  assert.strictEqual(ark.result({ now: at('2026-10-22T08:01:00Z'), health: 'healthy' }).state, 'ready');
  const q = new P.PhaseTracker({ startedAt: at('2026-10-22T08:00:00Z') }).feed(logs(['2026-10-22T08:00:02.000000000Z Starting sdtdserver']));
  q.markReady('query', at('2026-10-22T08:00:30Z'));
  assert.strictEqual(q.result({ now: at('2026-10-22T08:00:31Z') }).state, 'ready');
  // „MONITOR: PASS“ oder „CORE: FAIL … root“ sind kein Start
  const m = new P.PhaseTracker({ startedAt: at('2026-10-22T08:00:00Z') }).feed(logs(['2026-10-22T08:00:02.000000000Z Installing gmodserver', '2026-10-22T08:00:03.000000000Z Oct 21 21:43:36.323 gmodserver: CORE: FAIL: gmodserver attempted to run as root.', '2026-10-22T08:00:04.000000000Z Oct 21 21:43:05.272 gmodserver: MONITOR: PASS: core_exit.sh exiting with code: 0']));
  assert.strictEqual(m.result({ now: at('2026-10-22T08:00:05Z') }).state, 'installing');
});

test('time limit: nothing stays „installing“ or „starting“ forever', () => {
  const t0 = at('2026-10-22T08:00:00Z');
  const quiet = new P.PhaseTracker({ startedAt: t0 }).feed(logs([`2026-10-22T08:00:10.000000000Z ${E} Update state (0x61) downloading, progress: 5.00 (5 / 100)`]));
  assert.strictEqual(quiet.result({ now: t0 + 10000 + P.STALL_MS - 1000 }).state, 'installing');
  const r = quiet.result({ now: t0 + 10000 + P.STALL_MS + 1000 });
  assert.strictEqual(r.state, 'ready'); assert.strictEqual(r.fallback, true);
  const st = new P.PhaseTracker({ startedAt: t0 }).feed(logs(['2026-10-22T08:00:01.000000000Z Starting pzserver']));
  assert.strictEqual(st.result({ now: t0 + 60000 }).state, 'starting');
  assert.strictEqual(st.result({ now: t0 + P.STARTING_MS + 5000 }).state, 'ready');
  // Ohne jede Zeile: kurz „startet“, danach wie bisher „läuft“
  const none = new P.PhaseTracker({ startedAt: t0 });
  assert.strictEqual(none.result({ now: t0 + 30000 }).state, 'starting');
  assert.strictEqual(none.result({ now: t0 + P.FRESH_MS + 1000 }).state, 'ready');
  // Obergrenze auch bei ständig neuer Ausgabe
  const long = new P.PhaseTracker({ startedAt: t0 }).feed([{ ts: null, t: t0 + P.BUSY_MAX_MS, text: 'Installing arkserver' }]);
  assert.strictEqual(long.result({ now: t0 + P.BUSY_MAX_MS + 1000 }).state, 'ready');
});

test('failed start is reported (with the FAIL line), not „running“', () => {
  const tr = new P.PhaseTracker({ startedAt: at('2026-10-22T08:00:00Z'), T: TDE }).feed(logs(['2026-10-22T08:00:01.000000000Z Starting cs2server', '2026-10-22T08:00:09.000000000Z [ .... ] Starting cs2server: Hostwerk[ FAIL ] Starting cs2server: Unable to start Hostwerk']));
  const r = tr.result({ now: at('2026-10-22T08:00:10Z') });
  assert.strictEqual(r.state, 'failed');
  assert.match(r.error, /FAIL/);
  assert.strictEqual(P.publicPhase(r).state, 'failed');
  assert.strictEqual(P.isBusy(P.publicPhase(r)), false, 'failed is not busy – the buttons stay usable');
});

test('console: hundreds of SteamCMD lines become one, \\r and colours are resolved, the rest stays', () => {
  const raw = ['Installing gmodserver', '[  0%] Downloading update (0 of 41,425 KB)...', '[ 50%] Downloading update (20,000 of 41,425 KB)...', '[100%] Download Complete.'];
  for (let i = 1; i <= 480; i++) raw.push(`${E} Update state (0x61) downloading, progress: ${(i / 6).toFixed(2)} (${i} / 6886764390)`);
  raw.push('Success! App \'4020\' fully installed.', '[ .... ] Starting gmodserver: LinuxGSM\r[  OK  ] Starting gmodserver: LinuxGSM');
  const out = P.condenseConsole(raw);
  assert.deepStrictEqual(out, ['Installing gmodserver', '[100%] Download Complete.', ' Update state (0x61) downloading, progress: 80.00 (480 / 6886764390)', 'Success! App \'4020\' fully installed.', '[  OK  ] Starting gmodserver: LinuxGSM']);
});

test('clear causes instead of „Code 1“ – from the real output', () => {
  const T = TDE;
  // Echte Zeilen des Nutzers: jeder Knopf lief als root
  const root = 'Oct 21 21:43:36.323 gmodserver: CORE: FAIL: gmodserver attempted to run as root.\nOct 21 21:43:36.342 gmodserver: CORE: INFO: LinuxGSM version: v26.4.0\nOct 21 21:43:36.345 gmodserver: CORE: FAIL: core_exit.sh exiting with code: 1';
  assert.strictEqual(P.explainFailure(root, { T }), 'LinuxGSM läuft nicht als root.');
  assert.match(P.explainFailure('gmodserver is not installed yet. Start the container without a command to install it, or run auto-install.', { T }), /noch nicht installiert/);
  assert.match(P.explainFailure('Error! App \'258550\' state is 0x202 after update job.', { T }), /Speicherplatz/);
  assert.match(P.explainFailure('Connecting anonymously to Steam Public...FAILED', { T }), /nicht erreichbar/);
  assert.match(P.explainFailure('ERROR! Failed to install app \'2430930\' (No subscription)', { T }), /Steam-Konto/);
  assert.match(P.explainFailure('[ .... ] Checking for update: SteamCMD\n[ FAIL ] Checking for update: SteamCMD: Unable to get remote build', { T }), /^Checking for update: SteamCMD: Unable to get remote build$/);
  assert.strictEqual(P.explainFailure('=================================\nsomething odd happened\n=================================', { T }), 'something odd happened');
  assert.strictEqual(P.explainFailure('', { T }), null);
});

test('SteamCMD lines in every form; German and English sizes', () => {
  assert.deepStrictEqual(P.parseSteamLine(`${E} Update state (0x61) downloading, progress: 80.06 (5513662632 / 6886764390)`), { code: '0x61', state: 'downloading', pct: 80.06, done: 5513662632, total: 6886764390 });
  assert.strictEqual(P.parseSteamLine('Update state (0x5) verifying install, progress: 3.10 (1 / 2)').state, 'verifying install');
  assert.strictEqual(P.parseSteamLine("Error! App '4020' state is 0x602 after update job.").error, '0x602');
  assert.strictEqual(P.parseSteamLine('Loading Steam API...OK'), null);
  assert.strictEqual(P.size(5513662632, 'de'), '5,1 GB');
  assert.strictEqual(P.size(5513662632, 'en'), '5.1 GB');
  assert.strictEqual(P.size(20 * 1048576), '20 MB');
  assert.strictEqual(P.eta(7500, TDE), 'noch etwa 2 Std. 5 Min.');
  assert.strictEqual(P.eta(0, TDE), null);
});

test('every text of phase.js has German', () => {
  const missing = [...P.CAUSES.map((x) => x[1]), ...Object.values(P.VERB)].filter((k) => !de[k]);
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'server', 'phase.js'), 'utf8');
  for (const m of src.matchAll(/\bT\('((?:[^'\\]|\\.)+)'/g)) if (!de[m[1]]) missing.push(m[1]);
  assert.deepStrictEqual(missing, []);
});
