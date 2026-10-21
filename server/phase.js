'use strict';
/*
 * Was ein Spiele-Server gerade wirklich tut – statt nur „Container läuft“:
 *   installing → wird zum ersten Mal installiert (SteamCMD lädt das Spiel)
 *   updating   → wird aktualisiert oder geprüft (Update beim Start, Validate)
 *   starting   → Installation fertig, das Spiel startet gerade
 *   ready      → das Spiel läuft (LinuxGSM meldet „[ OK ] Starting …“, der Docker-Healthcheck ist „healthy“ oder die
 *                Steam-Abfrage antwortet)
 *   failed     → LinuxGSM meldet „[ FAIL ] Starting …“
 *
 * Wartungsfrei und für jedes Spiel gleich: Es werden nur Zeilen ausgewertet, die SteamCMD und LinuxGSM für JEDES Spiel
 * schreiben (Abschnittsköpfe des LinuxGSM-Images „Installing <server>“, „Checking for Update <server>“, „Starting
 * <server>“, „Tail log files“, die Statuszeilen „[  OK  ] / [ FAIL ]“, das Skript-Protokoll „<server>: START: PASS: …“ und
 * SteamCMDs „Update state (0x61) downloading, progress: 80.06 (a / b)“). Keine Spielnamen, keine Listen.
 * Zeitlimit-Rückfall: Kommt lange nichts Neues (Download hängt, Zeile nie gesehen), gilt der Server wieder als „läuft“ –
 * nichts bleibt ewig „wird installiert“.
 */

const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b[()][0-9A-Za-z]|\x1b[=>]/g;
const MB = 1048576;
const GB = 1073741824;

/** Stille ohne neue Ausgabe, nach der eine Installation/Aktualisierung nicht mehr als „läuft noch“ zählt */
const STALL_MS = 20 * 60000;
/** „Startet …“ höchstens so lange – manche Spiele melden ihr OK nie (alte LinuxGSM-Versionen, eigene Images) */
const STARTING_MS = 10 * 60000;
/** Obergrenze für eine ganze Installation (auch sehr große Spiele mit langsamer Leitung) */
const BUSY_MAX_MS = 12 * 3600e3;
/** Container gerade gestartet, aber noch keine Zeile da: so lange „Startet …“ */
const FRESH_MS = 90000;

const BUSY = new Set(['installing', 'updating', 'starting']);
/** Befehle, die während Installation/Update/Start trotzdem gehen: Starten (nichts zu tun), Stoppen, Erzwingen, Überwachen */
const ALLOWED_WHILE_BUSY = /^(start|stop|kill|monitor)$/;

/** Steuerzeichen entfernen; bei Zeilen mit \r (Fortschritt im selben Terminal-Feld) zählt das letzte Stück */
function clean(line) {
  const parts = String(line == null ? '' : line).replace(ANSI, '').split('\r').map((x) => x.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trimEnd()).filter((x) => x.trim());
  return parts.length ? parts[parts.length - 1] : '';
}
/** Ganze Zeile ohne Steuerzeichen (für die Erkennung: „[ .... ] Starting x: …[  OK  ] Starting x: …“ steht in einer Zeile) */
function flat(line) { return String(line == null ? '' : line).replace(ANSI, '').replace(/[\r\x00-\x08\x0b-\x1f\x7f]/g, ' ').trim(); }

/** SteamCMD-Fortschritt: „Update state (0x61) downloading, progress: 80.06 (5513662632 / 6886764390)“ */
function parseSteamLine(line) {
  const s = flat(line);
  const m = s.match(/Update state \((0x[0-9a-f]+)\) ([a-z ]+?), progress: ([\d.]+)(?: \((\d+) \/ (\d+)\))?/i);
  if (m) return { code: m[1].toLowerCase(), state: m[2].trim().toLowerCase(), pct: Math.min(100, Number(m[3]) || 0), done: m[4] ? Number(m[4]) : null, total: m[5] ? Number(m[5]) : null };
  if (/Success! App '\d+' (fully installed|already up to date)/i.test(s)) return { state: 'done', pct: 100, done: null, total: null };
  const e = s.match(/Error! App '\d+' state is (0x[0-9a-f]+)/i);
  if (e) return { state: 'error', error: e[1].toLowerCase(), pct: null, done: null, total: null };
  return null;
}
/** SteamCMD lädt sich selbst nach: „[ 45%] Downloading update (18,392 of 41,425 KB)...“ – für die Konsole zusammengefasst */
const SELF_UPDATE = /^\[\s*(\d+%|----)\]\s/;
const CURL = /^\s*(\d+\s+){3,}|% Total\s+% Received/;

/** Deutsche bzw. englische Größe: „5,1 GB“ / „512 MB“ */
function size(n, lang = 'de') {
  const s = n >= GB ? (n / GB).toFixed(n >= 10 * GB ? 0 : 1) + ' GB' : `${Math.max(0, Math.round(n / MB))} MB`;
  return lang === 'de' ? s.replace('.', ',') : s;
}
/** Restzeit in Worten (wie Hostwerks Modell-Download) – null, solange keine verlässliche Schätzung da ist */
function eta(sec, T) {
  if (!isFinite(sec) || sec <= 0) return null;
  if (sec < 60) return T('about {n} sec. left', { n: Math.max(5, Math.round(sec / 5) * 5) });
  const min = Math.round(sec / 60);
  if (min < 60) return T('about {n} min. left', { n: min });
  const h = Math.floor(min / 60); const m = min % 60;
  return m ? T('about {h} h {m} min. left', { h, m }) : T('about {h} h left', { h });
}
const VERB = { downloading: 'Downloading', verifying: 'Checking files', 'verifying install': 'Checking files', 'verifying update': 'Checking the download', committing: 'Saving', preallocating: 'Reserving space', reconfiguring: 'Preparing', running: 'Preparing', unknown: 'Preparing', done: 'Done' };
const verbOf = (state) => VERB[state] || (/verif/.test(state) ? 'Checking files' : /download/.test(state) ? 'Downloading' : 'Preparing');

const noT = (s, v) => (v ? String(s).replace(/\{(\w+)\}/g, (m, k) => (v[k] !== undefined ? String(v[k]) : m)) : s);

/**
 * Fortschritt über mehrere SteamCMD-Zeilen: Prozent, Größe, Geschwindigkeit (aus Zeitstempeln – auch wenn die Zeilen in
 * einem Schwung gelesen werden) und Restzeit. Gleiches Textmuster wie Hostwerks Modell-Download:
 * „Herunterladen: 5,1 GB von 6,4 GB – 20 MB/s, noch etwa 2 Min.“
 */
class SteamMeter {
  constructor({ T = noT, lang = 'de' } = {}) { this.T = T; this.lang = lang; this.cur = null; this.samples = []; this.speed = 0; }
  /** p aus parseSteamLine, t = Zeit der Zeile (ms) */
  feed(p, t = Date.now()) {
    if (!p || p.state === 'error') return this.value();
    if (p.state === 'done') { this.cur = { ...(this.cur || {}), state: 'done', pct: 100 }; return this.value(); }
    // Neuer Abschnitt (Download → Prüfen) oder neue Gesamtgröße: Geschwindigkeit neu messen
    if (!this.cur || this.cur.code !== p.code || this.cur.total !== p.total) { this.samples = []; this.speed = 0; }
    this.cur = { ...p };
    if (p.done !== null && p.total) {
      this.samples.push({ t, done: p.done });
      while (this.samples.length > 2 && t - this.samples[0].t > 60000) this.samples.shift();
      const a = this.samples[0];
      if (t - a.t >= 2000 && p.done >= a.done) this.speed = (p.done - a.done) / ((t - a.t) / 1000);
    }
    return this.value();
  }
  value() {
    if (!this.cur) return null;
    const { T, lang } = this;
    const c = this.cur;
    const verb = T(verbOf(c.state));
    let text = verb;
    if (c.total) {
      text = T('{verb}: {done} of {total}', { verb, done: size(c.done || 0, lang), total: size(c.total, lang) });
      if (c.state !== 'done' && c.done < c.total && this.speed > 0) {
        const rest = eta((c.total - c.done) / this.speed, T);
        text += ` – ${size(this.speed, lang)}/s${rest ? `, ${rest}` : ''}`;
      }
    } else if (c.pct > 0 && c.state !== 'done') text = `${verb} ${Math.round(c.pct)} %`;
    // Herunterladen zählt bis 90 %, Prüfen/Speichern danach – der Balken springt nicht zurück, wenn SteamCMD die Phase wechselt
    const pct = c.state === 'done' ? 100 : /download/.test(c.state) ? c.pct * 0.9 : /verif|commit/.test(c.state) ? 90 + c.pct * 0.1 : c.pct * 0.9;
    return { pct: Math.round(pct * 10) / 10, text, done: c.done, total: c.total, rate: this.speed || null, state: c.state };
  }
}

/** Eine Zeile → Signal für den Zustand (oder null). Reihenfolge zählt: „OK“ vor „Starting“. */
function signalOf(line) {
  const s = flat(line);
  if (!s) return null;
  if (/\[\s*OK\s*\]\s*Starting\b/i.test(s) || /:\s*[A-Z-]+:\s*PASS:\s*Started\b/.test(s) || /^Tail log files$/i.test(s)) return 'ready';
  if (/\[\s*FAIL\s*\]\s*Starting\b/i.test(s) || /:\s*START:\s*FAIL:\s*(?!core_exit)/.test(s)) return 'failed';
  if (/^Install Complete!?$/i.test(s)) return 'installed';
  if (/^Installing\b/i.test(s) || /^\[[^\]]*\]\s*Installing\b/i.test(s)) return 'installing';
  if (/^(Checking for Update|Validating|Updating)\b/i.test(s) || /^\[[^\]]*\]\s*(Updating|Validating|Checking for update)\b/i.test(s) || (/:\s*UPDATE:\s*INFO:.*\bupdate available\b/i.test(s) && !/\bno update available\b/i.test(s))) return 'updating';
  if (/^Starting \S+$/i.test(s) || /^\[[^\]]*\]\s*Starting\b/i.test(s)) return 'starting';
  return null;
}

/** „2026-10-21T21:25:09.344230881Z text“ (docker logs --timestamps) → [{ ts, t, text }], nach Zeit sortiert */
function parseDockerLogs(out) {
  const list = [];
  for (const raw of String(out || '').split('\n')) {
    const m = raw.match(/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)\s?(.*)$/);
    if (m) list.push({ ts: m[1], t: Date.parse(m[1]), text: m[2] });
    else if (raw.trim()) list.push({ ts: null, t: null, text: raw });
  }
  return list.sort((a, b) => (a.ts && b.ts ? (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0) : 0));
}

/**
 * Zustand eines laufenden LinuxGSM-Containers seit seinem Start – gefüttert mit seiner Ausgabe (auch in Teilen,
 * nacheinander). installedBefore: Der Server war schon einmal bereit → SteamCMD-Fortschritt heißt dann „Aktualisieren“.
 */
class PhaseTracker {
  constructor({ startedAt = Date.now(), installedBefore = false, T = noT, lang = 'de' } = {}) {
    this.T = T;
    this.startedAt = startedAt;
    this.installedBefore = installedBefore;
    this.phase = null;
    this.since = startedAt; // seit wann der aktuelle Zustand gilt
    this.lastLineAt = null;
    this.lastTs = null;
    this.meter = new SteamMeter({ T, lang });
    this.progress = null;
    this.error = null;
    this.readyBy = null; // woran „bereit“ erkannt wurde (für Tests und das Protokoll)
  }
  set(phase, t) { if (this.phase !== phase) { this.phase = phase; this.since = t; if (phase !== 'installing' && phase !== 'updating') { this.progress = null; this.meter = new SteamMeter({ T: this.T, lang: this.meter.lang }); } } }
  /** Zeilen verarbeiten: [{ ts, t, text }] oder Strings (dann zählt die Uhr now) */
  feed(entries, now = Date.now()) {
    for (const e of entries || []) {
      const text = typeof e === 'string' ? e : e.text;
      const t = typeof e === 'string' || !e.t ? now : e.t;
      if (e && e.ts) { if (this.lastTs && e.ts <= this.lastTs) continue; this.lastTs = e.ts; }
      if (!flat(text)) continue;
      this.lastLineAt = Math.max(this.lastLineAt || 0, t);
      const p = parseSteamLine(text);
      if (p) {
        if (p.state === 'error') { this.error = flat(text); continue; }
        if (!BUSY.has(this.phase) || this.phase === 'starting') this.set(this.installedBefore ? 'updating' : 'installing', t);
        this.progress = this.meter.feed(p, t);
        continue;
      }
      if (/\[\s*FAIL\s*\]/i.test(flat(text))) this.error = flat(text).slice(0, 240);
      const sig = signalOf(text);
      if (!sig) continue;
      if (sig === 'ready') { this.set('ready', t); this.readyBy = 'log'; this.installedBefore = true; }
      else if (sig === 'failed') this.set('failed', t);
      else if (sig === 'installed') { this.installedBefore = true; this.set('starting', t); }
      else if (sig === 'installing') this.set('installing', t); // „Installing <server>“ kommt nur bei leerem serverfiles/
      else if (sig === 'updating') { if (this.phase !== 'updating' && this.phase !== 'installing') this.set('updating', t); }
      else if (sig === 'starting') { if (this.phase !== 'starting') this.set('starting', t); }
    }
    return this;
  }
  /** Antwort der Steam-Abfrage oder healthy = das Spiel läuft */
  markReady(by, now = Date.now()) { if (this.phase !== 'ready') { this.set('ready', now); this.readyBy = by; this.installedBefore = true; } }
  /**
   * Zustand jetzt – mit Rückfall: health „healthy“ (LinuxGSM-monitor im Image) gilt sofort als bereit; zu lange still,
   * zu lange „startet“ oder insgesamt zu lange beschäftigt → „bereit“ (fallback: true), damit nichts hängen bleibt.
   */
  result({ now = Date.now(), health = null } = {}) {
    if (health === 'healthy' && this.phase !== 'ready') this.markReady('health', now);
    let state = this.phase;
    let fallback = false;
    if (!state) state = now - this.startedAt < FRESH_MS ? 'starting' : 'ready';
    if (BUSY.has(state)) {
      const quiet = now - (this.lastLineAt || this.startedAt);
      if ((state === 'starting' && now - this.since > STARTING_MS) || quiet > STALL_MS || now - this.startedAt > BUSY_MAX_MS) { state = 'ready'; fallback = true; }
    }
    const T = this.T;
    let text = null;
    if (state === 'installing' || state === 'updating') text = this.progress ? this.progress.text : state === 'installing' ? T('Installing the game …') : T('Checking for updates …');
    else if (state === 'starting') text = T('The game is starting …');
    else if (state === 'failed') text = T('The game did not start – the console says why.');
    return { state, pct: (state === 'installing' || state === 'updating') && this.progress ? this.progress.pct : null, text, progress: state === 'installing' || state === 'updating' ? this.progress : null, since: this.since, fallback, error: this.error };
  }
}

/** Für die Oberfläche: null = läuft normal; sonst { state, pct, text, since } */
function publicPhase(r) {
  if (!r || r.state === 'ready') return null;
  return { state: r.state, pct: r.pct, text: r.text, since: r.since, done: r.progress ? r.progress.done : null, total: r.progress ? r.progress.total : null, rate: r.progress ? r.progress.rate : null };
}
const isBusy = (p) => !!(p && BUSY.has(p.state));

/**
 * Konsole lesbar: SteamCMD-Fortschritt (hunderte Zeilen „Update state … progress …“), SteamCMDs Selbst-Update und
 * curl-Balken werden zu je EINER Zeile (der neuesten), Steuerzeichen und \r-Überschreibungen aufgelöst.
 * Die Rohausgabe bleibt über ?raw=1 abrufbar.
 */
function condenseConsole(lines) {
  const out = [];
  let lastKind = null;
  for (const raw of lines || []) {
    const s = clean(raw);
    if (!s.trim()) { out.push(''); lastKind = null; continue; }
    const p = parseSteamLine(s);
    const kind = p && p.state !== 'error' && p.state !== 'done' ? 'steam' : SELF_UPDATE.test(s) ? 'self' : CURL.test(s) ? 'curl' : null;
    if (kind && kind === lastKind) out[out.length - 1] = s;
    else out.push(s);
    lastKind = kind;
  }
  // Leere Zeilen nicht stapeln
  return out.filter((l, i) => l || (i > 0 && out[i - 1]));
}

/*
 * Verständliche Ursache aus der Ausgabe eines Befehls (LinuxGSM, SteamCMD, Docker) – statt „meldet Code 1“.
 * Englische Quelltexte, die Oberfläche übersetzt (locales/de.json).
 */
const CAUSES = [
  [/attempted to run as root/i, 'LinuxGSM refuses to run as root.'],
  [/is not installed yet|serverfiles.*(missing|not found)/i, 'The game is not installed yet – this works once the installation is done.'],
  [/lockfile|another (update|install|instance)|already (being )?(updating|installing|running an? (update|install))/i, 'Another LinuxGSM command is still running (installation or update) – try again once it is done.'],
  [/0x202|0x212|not enough (free )?(disk )?space|No space left on device|disk full/i, 'Not enough free disk space.'],
  [/No subscription|Login Failure|requires a license|Invalid Password|Steam Guard|rate limit exceeded/i, 'This server needs a Steam login that owns the game.'],
  [/Connecting anonymously to Steam Public\.\.\.\s*FAIL|Could not connect to Steam|Network is unreachable|Temporary failure in name resolution|Could not resolve host|Connection timed out|Timed out waiting/i, 'Steam or the internet cannot be reached right now – try again later.'],
  [/Cannot connect to the Docker daemon|docker daemon is not running|error during connect/i, 'The Docker engine is not running.'],
  [/No such container/i, 'The container does not exist any more.'],
  [/Permission denied|Operation not permitted/i, 'No permission for a file or folder of the server.'],
];
/** Zeilen ohne Aussage (Trenner, Banner, Fortschritt, „core_exit … code 1“) – für den Rückfall „letzte sinnvolle Zeile“ */
const NOISE = /^[=\-─*\s]*$|core_exit\.sh exiting|LinuxGSM version|^\s*\[\s*(\.\.\.\.|INFO|OK)\s*\]|Update state \(0x|^Loading|^Redirecting|^Logging directory|^UpdateUI|^steamcmd\.sh\[/i;

function explainFailure(out, { T = noT } = {}) {
  const text = String(out || '');
  for (const [re, msg] of CAUSES) if (re.test(text)) return T(msg);
  const lines = text.split('\n').map(flat).filter(Boolean);
  // LinuxGSM-Fehlerzeile: „[ FAIL ] …“ oder im Skript-Protokoll „<server>: CORE: FAIL: …“
  const fail = lines.slice().reverse().map((l) => (l.match(/\[\s*FAIL\s*\]\s*(.+)$/) || l.match(/:\s*[A-Z-]+:\s*FAIL:\s*(.+)$/) || [])[1]).find((x) => x && !/core_exit\.sh/.test(x));
  if (fail) return fail.replace(/\s*\[\s*FAIL\s*\].*$/, '').trim().slice(0, 240);
  const err = lines.slice().reverse().find((l) => /ERROR!|Error!|error:|FAILED/i.test(l) && !NOISE.test(l));
  if (err) return err.slice(0, 240);
  const last = lines.slice().reverse().find((l) => !NOISE.test(l));
  return last ? last.slice(0, 240) : null;
}

module.exports = { CAUSES, VERB, clean, flat, parseSteamLine, SteamMeter, PhaseTracker, signalOf, parseDockerLogs, publicPhase, isBusy, condenseConsole, explainFailure, size, eta, ALLOWED_WHILE_BUSY, STALL_MS, STARTING_MS, BUSY_MAX_MS, FRESH_MS };
