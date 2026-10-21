'use strict';
/*
 * The list of Steam server tools (SteamCMD method) – small, cached and searched on the server.
 *
 *  1. Built in: every game with a start profile plus a few more known server tools (steamgames.js) – always there, no download.
 *  2. Optional, only when the user asks for it ("Load every Steam server tool"): Steam's public app list is read ONCE as a
 *     stream and filtered on the fly – only names that look like a server tool are kept ("Dedicated Server", "… Server",
 *     "… DS"). The full answer is never kept in memory or on disk; what remains (a few thousand entries) is written
 *     gzipped to the extension's data folder and reused for 7 days. Without internet or if Steam ever drops the endpoint,
 *     the built-in list and the last saved file keep working.
 *  3. Searching and paging happen here – the interface only ever receives one page (default 40 entries).
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { curatedApps } = require('./steamgames');

const APPLIST_URL = 'https://api.steampowered.com/ISteamApps/GetAppList/v2/';
const MAX_AGE = 7 * 24 * 3600e3;
const CACHE_FILE = 'steam-servers.json.gz';

/** Does this name look like a dedicated server tool? (and not like a soundtrack, DLC, demo, tycoon game …) */
function isServerTool(name) {
  const n = String(name || '');
  if (n.length < 4 || n.length > 120) return false;
  if (/soundtrack|\bost\b|\bdlc\b|demo|playtest|artbook|wallpaper|season pass|\bpack\b|simulator|tycoon|manager|hacker|\bskin|bundle|test server|beta server|public test|\bpts\b/i.test(n)) return false;
  return /dedicated server|\S\s+server( tool| files)?$|\S\s+ds$/i.test(n.trim());
}

/**
 * Filter Steam's app list while it streams in: chunks come in, complete {"appid":…,"name":"…"} objects are matched,
 * the unfinished tail of a chunk is kept for the next one. Memory stays small no matter how big the answer is.
 */
function createStreamFilter() {
  const found = new Map();
  let tail = '';
  let seen = 0;
  const re = /\{"appid":(\d+),"name":"((?:[^"\\]|\\.)*)"[^}]*\}/g;
  return {
    push(chunk) {
      const text = tail + chunk;
      re.lastIndex = 0;
      let m; let end = 0;
      while ((m = re.exec(text))) {
        seen++;
        end = re.lastIndex;
        let name;
        try { name = JSON.parse(`"${m[2]}"`); } catch { continue; }
        const appid = Number(m[1]);
        if (appid > 0 && isServerTool(name)) found.set(appid, name.trim());
      }
      tail = text.slice(Math.max(end, text.length - 4096)); // never more than a few KB of leftovers
    },
    result() { return { seen, apps: [...found].map(([appid, name]) => ({ appid, name })) }; },
  };
}

class SteamAppList {
  /** dataDir: the extension's data folder; fetchImpl: fetch (tests pass a fake) */
  constructor({ dataDir, fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
    this.dataDir = dataDir;
    this.fetch = fetchImpl;
    this.now = now;
    this.mem = null;
    this.busy = null;
  }
  get file() { return path.join(this.dataDir, CACHE_FILE); }

  /** Saved full list (or null) – read once, then kept in memory. */
  load() {
    if (this.mem !== null) return this.mem || null;
    try { this.mem = JSON.parse(zlib.gunzipSync(fs.readFileSync(this.file)).toString('utf8')); } catch { this.mem = false; }
    return this.mem || null;
  }
  save(data) {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, zlib.gzipSync(Buffer.from(JSON.stringify(data)), { level: 9 }));
    fs.renameSync(tmp, this.file);
    this.mem = data;
  }
  /** State for the interface: is the full list there, how old, how many entries, how big on disk. */
  state() {
    const d = this.load();
    let size = 0; try { size = fs.statSync(this.file).size; } catch { /* none */ }
    return { full: !!d, fetchedAt: d ? d.fetchedAt : null, stale: !!d && this.now() - d.fetchedAt > MAX_AGE, count: d ? d.apps.length : 0, bytes: size, builtIn: curatedApps().length };
  }

  /** Load the full list from Steam (stream + filter); only one download at a time. */
  refresh({ force = false } = {}) {
    const d = this.load();
    if (!force && d && this.now() - d.fetchedAt < MAX_AGE) return Promise.resolve(d);
    if (this.busy) return this.busy;
    this.busy = (async () => {
      const res = await this.fetch(APPLIST_URL, { headers: { 'User-Agent': 'Hostwerk game servers', 'Accept-Encoding': 'gzip' }, signal: AbortSignal.timeout(120000) });
      if (!res || !res.ok) throw new Error(`Steam answers ${res ? res.status : 'nothing'} – the built-in list stays in use.`);
      const filter = createStreamFilter();
      if (res.body && typeof res.body.getReader === 'function') {
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        for (;;) { const { done, value } = await reader.read(); if (done) break; filter.push(dec.decode(value, { stream: true })); }
      } else filter.push(await res.text());
      const r = filter.result();
      if (r.seen < 1000) throw new Error('The Steam app list looks incomplete – the built-in list stays in use.');
      const data = { fetchedAt: this.now(), source: 'steam', apps: r.apps.sort((a, b) => a.name.localeCompare(b.name)) };
      this.save(data);
      return data;
    })().finally(() => { this.busy = null; });
    return this.busy;
  }

  /** Built-in entries first, then the saved full list (without duplicates). */
  all() {
    const cur = curatedApps();
    const have = new Set(cur.map((x) => x.appid));
    const d = this.load();
    const extra = d ? d.apps.filter((x) => !have.has(x.appid)).map((x) => ({ ...x, game: null, win: null, linux: null, profile: false, login: false })) : [];
    return cur.concat(extra);
  }

  /**
   * Search with paging. Ranking: popular games first (without a search term, in the given order), then ready-made
   * profiles, then names starting with the term, then the rest (A–Z). `filter` narrows the list before paging.
   * Only the requested page leaves the server.
   */
  search({ q = '', offset = 0, limit = 40, popular = [], filter = null } = {}) {
    const term = String(q || '').toLowerCase().trim().slice(0, 80);
    const words = term.split(/\s+/).filter(Boolean);
    offset = Math.max(0, Math.min(100000, Number(offset) || 0));
    limit = Math.max(1, Math.min(100, Number(limit) || 40));
    let list = this.all();
    if (/^\d{2,9}$/.test(term)) list = list.filter((x) => String(x.appid) === term || String(x.appid).startsWith(term) || x.name.toLowerCase().includes(term));
    else if (words.length) list = list.filter((x) => { const n = x.name.toLowerCase(); return words.every((w) => n.includes(w)); });
    if (typeof filter === 'function') list = list.filter(filter);
    const pop = (x) => { const i = popular.indexOf(x.appid); return i < 0 ? 1000 : i; };
    const rank = (x) => (x.profile ? 0 : 2) + (term && x.name.toLowerCase().startsWith(term) ? 0 : 1) + (x.login ? 2 : 0);
    list = list.map((x) => [term ? 0 : pop(x), rank(x), x]).sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2].name.localeCompare(b[2].name)).map((x) => x[2]);
    return { total: list.length, offset, limit, items: list.slice(offset, offset + limit), list: this.state() };
  }
  /** One entry (or null). */
  find(appid) { const id = Number(appid); return this.all().find((x) => x.appid === id) || null; }
}

module.exports = { SteamAppList, isServerTool, createStreamFilter, APPLIST_URL, MAX_AGE, CACHE_FILE };
