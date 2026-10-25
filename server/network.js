'use strict';
/*
 * Game server network: several game and Minecraft servers as one group – started in order (backends first, then the proxy),
 * stopped in reverse order (proxy first, so nobody lands on a server that is going down), with one status line for all of
 * them. A Minecraft network with a Velocity proxy (Hostwerk's Minecraft → Network) is detected and can be taken over as a
 * group with one click; the proxy then always starts last and stops first.
 *
 * Starting waits until each server is really ready (Minecraft: "Done", game servers: answer to the Steam query) before
 * the next one starts; the pause comes on top. If a backend fails, the proxy is not started (unless asked to anyway).
 * A scheduled restart announces itself in the chat beforehand; a scheduled backup saves every server of the network.
 *
 * 1.2: shared settings (server password, player slots) for every game server of the network, a port overview with
 * conflicts against everything else on this PC, router forwardings for the whole network in one go ("Router & port
 * forwarding" ≥ 1.2, owner game-network), players per server and in total. Minecraft networks with a proxy, Bedrock and
 * version bridges live in the extension "Minecraft server network" (mc-network) – here a Minecraft server is just a member.
 *
 * Data: settings.gameNetwork.groups = [{ id, name, members: [{ kind: 'game' | 'mc', id }] (order = start order), delay,
 *   restart: { enabled, at, warn }, backup: { enabled, at }, shared: { password, maxPlayers } }]
 */
const crypto = require('crypto');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/**
 * Geplanter Neustart: was ist jetzt fällig? 'warn' = Ansage (warn Minuten vorher), 'restart' = Neustart, sonst null.
 * Jede Phase höchstens einmal am Tag (fired merkt sich „<gruppe>:<tag>:<phase>“). Ein verpasster Zeitpunkt (Hostwerk
 * lief nicht) wird nur innerhalb von 5 Minuten nachgeholt – kein Neustart mitten am Tag.
 */
function due(g, now, fired) {
  const out = dueRestart(g, now, fired);
  if (out) return out;
  const b = g.backup;
  if (!b || !b.enabled || !/^\d{2}:\d{2}$/.test(b.at || '')) return null;
  const d = new Date(now);
  const [h, m] = b.at.split(':').map(Number);
  const at = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m).getTime();
  return now >= at && now - at < 5 * 60000 && !fired.has(`${g.id}:${dayKey(d)}:backup`) ? 'backup' : null;
}
function dueRestart(g, now, fired) {
  const r = g.restart;
  if (!r || !r.enabled || !/^\d{2}:\d{2}$/.test(r.at || '')) return null;
  const d = new Date(now);
  const [h, m] = r.at.split(':').map(Number);
  const at = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m).getTime();
  const key = `${g.id}:${dayKey(d)}`;
  if (now >= at && now - at < 5 * 60000 && !fired.has(`${key}:restart`)) return 'restart';
  const warnAt = at - (r.warn || 0) * 60000;
  if (r.warn > 0 && now >= warnAt && now < at && !fired.has(`${key}:warn`)) return 'warn';
  return null;
}

class GameNetwork {
  constructor(host) {
    this.host = host;
    this.ctx = host.ctx;
    this.T = (s, v) => host.t(s, v);
    this.pollMs = 2000; // wie oft „bereit?“ gefragt wird
    this.readyMs = 180000; // höchstens so lange auf einen Server warten
    this.fired = new Set();
  }
  /** Zeitplan prüfen (alle 30 Sekunden) – geplante Neustarts mit Ansage im Chat. */
  startTimer() {
    this.timer = setInterval(() => this.tick().catch(() => {}), 30000);
    if (this.timer.unref) this.timer.unref();
  }
  stopTimer() { clearInterval(this.timer); }
  async tick(now = Date.now()) {
    for (const g of this.list()) {
      const what = due(g, now, this.fired);
      if (!what) continue;
      this.fired.add(`${g.id}:${dayKey(new Date(now))}:${what}`);
      if (what === 'backup') { this.backupAll(g.id).promise.catch(() => {}); continue; }
      if (what === 'warn') await this.announce(g, this.T('Scheduled restart of the network in {n} minutes.', { n: g.restart.warn }));
      else if (this.view(g).running > 0) { await this.announce(g, this.T('The network restarts now – back in a moment.')); this.run(g.id, 'restart').promise.catch(() => {}); }
    }
  }
  /** Nachricht in den Chat aller laufenden Server des Verbunds (Minecraft: say auf den Backends, Spiele-Server: say per Konsole). */
  async announce(g, text) {
    const msg = String(text).replace(/[\r\n]+/g, ' ').slice(0, 200);
    for (const m of g.members.map((x) => this.member(x)).filter((x) => x.running && !x.missing && !x.proxy)) {
      try {
        if (m.kind === 'mc') await this.ctx.minecraft.command(m.id, `say ${msg}`);
        else if (this.ctx.games && typeof this.ctx.games.send === 'function') await this.ctx.games.send(this.ctx.games.get(m.id), `say ${msg}`);
      } catch { /* ein Server ohne Konsole hält die anderen nicht auf */ }
    }
  }
  get cfg() { const s = this.ctx.settings.get(); if (!s.gameNetwork) s.gameNetwork = { groups: [] }; return s.gameNetwork; }
  list() { return this.cfg.groups; }
  get(id) { const g = this.list().find((x) => x.id === id); if (!g) throw Object.assign(new Error(this.T('Network not found')), { status: 404 }); return g; }

  /* ---------- members ---------- */
  /** Everything that can be part of a network: game servers (extension) and Minecraft servers (Hostwerk). */
  candidates() {
    const out = [];
    for (const s of (this.ctx.games ? this.ctx.games.list() : [])) out.push({ kind: 'game', id: s.id, name: s.name, game: s.gameName || s.game, running: !!s.running, proxy: false });
    const mc = this.ctx.minecraft;
    if (mc) for (const s of mc.list()) out.push({ kind: 'mc', id: s.id, name: s.name, game: 'Minecraft', type: s.type, running: this.mcRunning(s.id), proxy: mc.isProxy(s), players: this.mcPlayers(s.id) });
    return out;
  }
  mcRunning(id) { try { return this.ctx.minecraft.proc(id).isRunning(); } catch { return false; } }
  /** Minecraft ist bereit, wenn der Server „Done“ gemeldet hat (ohne diese Angabe: sobald er läuft). */
  mcReady(id) { try { const p = this.ctx.minecraft.proc(id); if (!p.isRunning()) return false; return !p.extra || p.extra.ready === undefined ? true : !!p.extra.ready; } catch { return false; } }
  /** Bereit? Minecraft: „Done“; Spiele-Server: läuft und antwortet auf die Steam-Abfrage (A2S). */
  async ready(m) {
    if (m.kind === 'mc') return this.mcReady(m.id);
    const games = this.ctx.games; if (!games) return false;
    let s; try { s = games.get ? games.get(m.id) : games.list().find((x) => x.id === m.id); } catch { return false; }
    if (!s || !s.running) return false;
    if (typeof games.live !== 'function') return true;
    try { return !!(await games.live(s)); } catch { return false; }
  }
  /** Warten, bis ein Server bereit ist. Spiele-Server ohne Antwort auf die Abfrage: nach der Wartezeit trotzdem weiter. */
  async waitReady(m, job) {
    const until = Date.now() + this.readyMs;
    while (Date.now() < until) {
      if (await this.ready(m)) return true;
      await sleep(this.pollMs);
    }
    if (m.kind === 'game') { if (job) job.log(`… ${this.T('{name} does not answer the server query – carrying on', { name: m.name })}`); return true; }
    throw new Error(this.T('{name} did not get ready in time', { name: m.name }));
  }
  mcPlayers(id) { try { const p = this.ctx.minecraft.proc(id); return (p.extra && p.extra.playerCount) || 0; } catch { return 0; } }
  member(m) {
    const c = this.candidates().find((x) => x.kind === m.kind && x.id === m.id);
    return c || { ...m, name: m.id, missing: true, running: false };
  }

  /** Velocity proxies with their backends (from Hostwerk's Minecraft network) – ready to take over as a group. */
  proxies() {
    const mc = this.ctx.minecraft;
    if (!mc) return [];
    return mc.list().filter((s) => mc.isProxy(s)).map((p) => ({
      id: p.id, name: p.name,
      members: mc.list().filter((s) => s.network && s.network.proxy === p.id).map((s) => ({ kind: 'mc', id: s.id, name: s.name })),
      taken: this.list().some((g) => g.members.some((m) => m.kind === 'mc' && m.id === p.id)),
    }));
  }

  /* ---------- groups ---------- */
  clean(b) {
    const name = String(b.name || '').trim().slice(0, 60);
    if (!name) throw Object.assign(new Error(this.T('Please give the network a name.')), { status: 400 });
    const members = [];
    for (const m of Array.isArray(b.members) ? b.members : []) {
      if (!m || !['game', 'mc'].includes(m.kind) || typeof m.id !== 'string') continue;
      if (!members.some((x) => x.kind === m.kind && x.id === m.id)) members.push({ kind: m.kind, id: m.id });
    }
    const delay = Math.max(0, Math.min(120, Number(b.delay) || 0));
    const r = b.restart && typeof b.restart === 'object' ? b.restart : {};
    const restart = { enabled: !!r.enabled, at: /^([01]\d|2[0-3]):[0-5]\d$/.test(String(r.at || '')) ? r.at : '05:00', warn: Math.max(0, Math.min(30, Math.round(Number(r.warn ?? 5)) || 0)) };
    const bk = b.backup && typeof b.backup === 'object' ? b.backup : {};
    const backup = { enabled: !!bk.enabled, at: /^([01]\d|2[0-3]):[0-5]\d$/.test(String(bk.at || '')) ? bk.at : '04:30' };
    return { name, members, delay, restart, backup };
  }
  create(b) {
    const g = { id: crypto.randomBytes(4).toString('hex'), ...this.clean(b || {}), createdAt: Date.now() };
    this.list().push(g); this.ctx.settings.save();
    return this.view(g);
  }
  update(id, b) { const g = this.get(id); Object.assign(g, this.clean({ ...g, ...(b || {}) })); this.ctx.settings.save(); return this.view(g); }
  remove(id) { this.get(id); this.cfg.groups = this.list().filter((x) => x.id !== id); this.ctx.settings.save(); }
  fromProxy(proxyId) {
    const p = this.proxies().find((x) => x.id === proxyId);
    if (!p) throw Object.assign(new Error(this.T('This is not a Velocity proxy.')), { status: 400 });
    return this.create({ name: p.name, members: [...p.members, { kind: 'mc', id: p.id }], delay: 5 });
  }

  /** Start order: every backend first, proxies last. Stop order: the reverse. */
  order(g, dir = 'start') {
    const all = g.members.map((m) => this.member(m));
    const sorted = [...all.filter((m) => !m.proxy), ...all.filter((m) => m.proxy)];
    return dir === 'start' ? sorted : sorted.reverse();
  }
  view(g) {
    const members = g.members.map((m) => this.member(m));
    const running = members.filter((m) => m.running).length;
    const { shared, ...pub } = g;
    return { ...pub, shared: { maxPlayers: (shared && shared.maxPlayers) || null, password: !!(shared && shared.password) }, restart: g.restart || { enabled: false, at: '05:00', warn: 5 }, backup: g.backup || { enabled: false, at: '04:30' }, members, running, total: members.length, players: members.reduce((n, m) => n + (m.players || 0), 0), state: running === 0 ? 'stopped' : running === members.length ? 'running' : 'partial', mcNetwork: !!this.ctx.mcNetworkInstalled || this.hasMcNetwork() };
  }
  /** Is the extension "Minecraft server network" there? (then Minecraft proxies, Bedrock and versions are managed there) */
  hasMcNetwork() { try { return !!(this.ctx.extMarket && this.ctx.extMarket.list().some((e) => e.id === 'mc-network' && !e.error)); } catch { return false; } }

  /* ---------- 1.2: players, ports, router, shared settings, backups ---------- */

  /** Players per member right now – game servers through the Steam query (A2S), Minecraft from the console. */
  async live(id) {
    const g = this.get(id);
    const out = [];
    for (const m of g.members.map((x) => this.member(x))) {
      let players = 0; let max = null;
      if (m.kind === 'mc') players = m.players || 0;
      else if (m.running && this.ctx.games && typeof this.ctx.games.live === 'function') {
        try { const s = this.ctx.games.get(m.id); const v = await Promise.race([this.ctx.games.live(s), sleep(2500).then(() => null)]); if (v) { players = Number(v.players) || 0; max = v.maxPlayers || null; } } catch { /* no answer */ }
      }
      out.push({ kind: m.kind, id: m.id, name: m.name, running: !!m.running, players, max });
    }
    return { members: out, players: out.reduce((n, x) => n + x.players, 0) };
  }

  /** Ports of one member: [{ port, proto, name }] */
  portsOfMember(m) {
    if (m.kind === 'mc') {
      const mc = this.ctx.minecraft; let s; try { s = mc.get(m.id); } catch { return []; }
      // Behind a proxy a server listens on 127.0.0.1 only – not a port anybody connects to
      const out = s.network && s.network.proxy ? [] : [{ port: s.port, proto: 'TCP', name: 'Minecraft' }];
      if (s.geyser && s.geyser.port) out.push({ port: s.geyser.port, proto: 'UDP', name: 'Bedrock (Geyser)' });
      return out;
    }
    if (!this.ctx.games) return [];
    let s; try { s = this.ctx.games.get(m.id); } catch { return []; }
    const out = [];
    for (const p of (typeof this.ctx.games.portsOf === 'function' ? this.ctx.games.portsOf(s) : []) || []) {
      const port = Number(p.port); if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
      const proto = String(p.proto || '').toLowerCase();
      for (const pr of /udp/.test(proto) && /tcp/.test(proto) ? ['TCP', 'UDP'] : [/udp/.test(proto) ? 'UDP' : 'TCP']) out.push({ port, proto: pr, name: p.name || 'Game' });
    }
    return out;
  }
  /** Every port the network uses – with conflicts against every other game or Minecraft server on this PC. */
  ports(id) {
    const g = this.get(id);
    const all = this.candidates().map((c) => ({ ...c, ports: this.portsOfMember(c) }));
    const owners = new Map();
    for (const c of all) for (const p of c.ports) { const k = `${p.port}/${p.proto}`; owners.set(k, [...(owners.get(k) || []), c]); }
    const forwarded = new Set(this.owned().map((x) => `${x.port}/${x.protocol}`));
    const rows = [];
    for (const m of g.members.map((x) => this.member(x))) {
      for (const p of this.portsOfMember(m)) {
        const k = `${p.port}/${p.proto}`;
        const others = (owners.get(k) || []).filter((c) => !(c.kind === m.kind && c.id === m.id)).map((c) => c.name);
        rows.push({ member: m.name, kind: m.kind, id: m.id, port: p.port, proto: p.proto, name: p.name, conflict: others, forwarded: forwarded.has(k) });
      }
    }
    return { ports: rows, conflicts: rows.filter((r) => r.conflict.length).length, router: this.routerState() };
  }
  routerState() { const r = this.ctx.router; return { available: !!(r && r.forwards && typeof r.forwards.add === 'function'), auto: !!(r && r.cfg && r.cfg.auto) }; }
  owned() { try { return this.ctx.router && this.ctx.router.forwards ? this.ctx.router.forwards.owned('game-network') : []; } catch { return []; } }
  /** Forward (or remove) every port of the network in the router in one go – owner "game-network", so nothing else is touched. */
  async forward(id, on = true) {
    const r = this.ctx.router;
    if (!r || !r.forwards || typeof r.forwards.add !== 'function') throw Object.assign(new Error(this.T('Needs the extension “Router & port forwarding” (1.2 or newer).')), { status: 409 });
    const { ports } = this.ports(id);
    const out = [];
    for (const p of ports) {
      if (on && p.conflict.length) { out.push({ ...p, ok: false, why: this.T('port also used by {list}', { list: p.conflict.join(', ') }) }); continue; }
      try {
        if (on) await r.forwards.add({ port: p.port, protocol: p.proto, label: `${this.get(id).name}: ${p.member}` }, 'game-network');
        else await r.forwards.remove({ port: p.port, protocol: p.proto }, 'game-network');
        out.push({ ...p, ok: true });
      } catch (e) { out.push({ ...p, ok: false, why: e.message }); }
    }
    return { results: out, ...this.ports(id) };
  }

  /**
   * Same server password and player slots for every game server of the network (Steam servers: Hostwerk's settings,
   * LinuxGSM: serverpassword/maxplayers in its config; Minecraft: max-players). Applies at the next start of each server.
   */
  applyShared(id, b = {}) {
    const g = this.get(id);
    const T = this.T;
    const password = b.password === undefined ? undefined : String(b.password);
    const maxPlayers = b.maxPlayers === undefined || b.maxPlayers === '' || b.maxPlayers === null ? undefined : Math.round(Number(b.maxPlayers));
    if (maxPlayers !== undefined && (!Number.isInteger(maxPlayers) || maxPlayers < 1 || maxPlayers > 1000)) throw Object.assign(new Error(T('Player slots are a number between 1 and 1000.')), { status: 400 });
    if (password !== undefined && (/[\s"'`$\\]/.test(password) || password.length > 40)) throw Object.assign(new Error(T('The password may not contain spaces, quotes, $ or \\ (at most 40 characters).')), { status: 400 });
    g.shared = { ...(g.shared || {}), ...(password !== undefined ? { password } : {}), ...(maxPlayers !== undefined ? { maxPlayers } : {}) };
    this.ctx.settings.save();
    return this.host.core('jobs').runJob(T('Shared settings for “{name}”', { name: g.name }), async (job) => {
      const results = [];
      for (const m of g.members.map((x) => this.member(x)).filter((x) => !x.missing)) {
        try {
          if (m.kind === 'mc') {
            if (maxPlayers !== undefined && typeof this.ctx.minecraft.setProperties === 'function' && !m.proxy) this.ctx.minecraft.setProperties(m.id, { 'max-players': String(maxPlayers) });
            results.push({ name: m.name, ok: true, note: password !== undefined ? T('Minecraft has no server password – use the whitelist') : null });
          } else {
            const games = this.ctx.games; const s = games.get(m.id);
            if (s.kind === 'steam') games.steamSet(s, { ...(password !== undefined ? { password } : {}), ...(maxPlayers !== undefined ? { maxPlayers } : {}) });
            else await games.quickSet(s, { ...(password !== undefined ? { serverpassword: password } : {}), ...(maxPlayers !== undefined ? { maxplayers: String(maxPlayers) } : {}) });
            results.push({ name: m.name, ok: true, restart: !!m.running });
          }
          job.log(`✓ ${m.name}`);
        } catch (e) { results.push({ name: m.name, ok: false, why: e.message }); job.log(`✗ ${m.name}: ${e.message}`); }
      }
      return { results, text: T('{n} servers updated – applies at their next start', { n: results.filter((x) => x.ok).length }) };
    }, { key: `game-network-shared-${id}` });
  }

  /** Back up every server of the network (game servers: their backup command, Minecraft: Hostwerk's backup). */
  backupAll(id) {
    const g = this.get(id);
    const T = this.T;
    return this.host.core('jobs').runJob(T('Back up network “{name}”', { name: g.name }), async (job) => {
      const failed = [];
      const list = g.members.map((x) => this.member(x)).filter((x) => !x.missing && !x.proxy);
      let i = 0;
      for (const m of list) {
        job.progress(Math.round((i++ / Math.max(1, list.length)) * 100), T('Backing up {name} …', { name: m.name }));
        try {
          if (m.kind === 'mc') await this.ctx.minecraft.backup(m.id, g.name).promise;
          else await this.ctx.games.run(m.id, 'backup').promise;
          job.log(`✓ ${m.name}`);
        } catch (e) { failed.push(m.name); job.log(`✗ ${m.name}: ${e.message}`); }
      }
      if (failed.length) throw new Error(T('Not everything worked: {list}', { list: failed.join(', ') }));
      return { ok: true, text: T('{n} servers backed up', { n: list.length }) };
    }, { key: `game-network-backup-${id}` });
  }
  /** Summen über alle Verbünde (Kachel der Übersicht). */
  totals() {
    const v = this.list().map((g) => this.view(g));
    return { networks: v.length, servers: v.reduce((n, g) => n + g.total, 0), running: v.reduce((n, g) => n + g.running, 0), players: v.reduce((n, g) => n + g.players, 0) };
  }
  /** Verbünde, zu denen ein Server gehört (für seine Seite). */
  forMember(kind, id) { return this.list().filter((g) => g.members.some((m) => m.kind === kind && m.id === id)).map((g) => this.view(g)); }

  async one(m, action) {
    if (m.missing) throw new Error(this.T('“{name}” no longer exists', { name: m.name }));
    if (m.kind === 'mc') {
      const mc = this.ctx.minecraft;
      if (action === 'start') { if (!this.mcRunning(m.id)) await mc.start(m.id); return; }
      if (action === 'stop') { if (this.mcRunning(m.id)) await mc.stop(m.id); return; }
      return mc.restart(m.id);
    }
    if (!this.ctx.games) throw new Error(this.T('The game servers extension is missing.'));
    if (action === 'start' && m.running) return;
    if (action === 'stop' && !m.running) return;
    await this.ctx.games.run(m.id, action).promise;
  }

  /** Start/stop/restart all members of a network as one job, in order and with the chosen pause. */
  run(id, action, { force = false } = {}) {
    if (!['start', 'stop', 'restart'].includes(action)) throw Object.assign(new Error(this.T('Unknown action')), { status: 400 });
    const g = this.get(id);
    const T = this.T;
    const title = { start: T('Start network “{name}”', { name: g.name }), stop: T('Stop network “{name}”', { name: g.name }), restart: T('Restart network “{name}”', { name: g.name }) }[action];
    return this.host.core('jobs').runJob(title, async (job) => {
      const steps = action === 'restart' ? [['stop', this.order(g, 'stop')], ['start', this.order(g, 'start')]] : [[action, this.order(g, action)]];
      const total = steps.reduce((n, [, l]) => n + l.length, 0) || 1;
      let done = 0;
      const failed = [];
      const skipped = [];
      for (const [act, list] of steps) {
        for (const m of list) {
          // Proxy erst, wenn alle Server dahinter laufen – sonst landen Spieler im Leeren (außer ausdrücklich gewünscht)
          if (act === 'start' && m.proxy && failed.length && !force) { skipped.push(m.name); job.log(`– ${m.name}: ${T('not started, because a server behind it failed')}`); done++; continue; }
          job.progress(Math.round((done / total) * 100), `${act === 'stop' ? T('Stopping') : T('Starting')}: ${m.name}`);
          try {
            const was = act === 'start' ? await this.ready(m) : false;
            await this.one(m, act);
            if (act === 'start' && !was) { job.progress(Math.round((done / total) * 100), T('Waiting until {name} is ready', { name: m.name })); await this.waitReady(m, job); }
            job.log(`✓ ${m.name}`);
          } catch (e) { failed.push(m.name); job.log(`✗ ${m.name}: ${e.message}`); }
          done++;
          if (act === 'start' && g.delay && done < total) await sleep(g.delay * 1000);
        }
      }
      this.host.broadcast({ type: 'game-network' });
      if (skipped.length) throw Object.assign(new Error(T('{list} failed – the proxy was not started.', { list: failed.join(', ') })), { code: 'PROXY_SKIPPED' });
      if (failed.length) throw new Error(T('Not everything worked: {list}', { list: failed.join(', ') }));
      return { ok: true, text: T('{n} servers done', { n: done }) };
    }, { key: `game-network-${id}-${action}` });
  }

  routes(r) {
    r.get('/game-network', (req, res) => res.json({ groups: this.list().map((g) => this.view(g)), candidates: this.candidates(), proxies: this.proxies(), totals: this.totals() }));
    r.get('/game-network/totals', (req, res) => res.json(this.totals()));
    r.get('/game-network/member/:kind/:id', (req, res) => res.json(this.forMember(req.params.kind, req.params.id)));
    r.post('/game-network', (req, res) => res.json(this.create(req.body || {})));
    r.post('/game-network/from-proxy/:proxy', (req, res) => res.json(this.fromProxy(req.params.proxy)));
    r.put('/game-network/:id', (req, res) => res.json(this.update(req.params.id, req.body || {})));
    r.delete('/game-network/:id', (req, res) => { this.remove(req.params.id); res.json({ ok: true }); });
    r.get('/game-network/:id/live', async (req, res) => res.json(await this.live(req.params.id)));
    r.get('/game-network/:id/ports', (req, res) => res.json(this.ports(req.params.id)));
    r.post('/game-network/:id/forward', async (req, res) => res.json(await this.forward(req.params.id, (req.body || {}).on !== false)));
    r.put('/game-network/:id/shared', (req, res) => res.json({ job: this.applyShared(req.params.id, req.body || {}).id }));
    r.post('/game-network/:id/backup', (req, res) => res.json({ job: this.backupAll(req.params.id).id }));
    r.post('/game-network/:id/:action', (req, res) => res.json({ job: this.run(req.params.id, req.params.action, { force: !!(req.body || {}).force }).id }));
  }
}

module.exports = { GameNetwork, due };
