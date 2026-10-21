'use strict';
/*
 * Game pictures (store art) – found once, kept locally, nothing to maintain.
 *
 * Why this exists: dedicated server tools (e.g. "Valheim Dedicated Server", app 896660) have no store page and therefore
 * no pictures of their own, entries from Steam's full app list do not know which game they belong to, and LinuxGSM games
 * only have small icons. So every picture is looked up by the GAME:
 *
 *   1. Steam app id of the game (profiles know it) → header / library art on Steam's CDN (two hosts, old and new paths)
 *   2. otherwise the app id of the tool itself (some tools do have art)
 *   3. otherwise the game's name in Steam's store search (once, the answer is remembered) → art of the app found
 *   4. LinuxGSM icon of the game (square, always there for LinuxGSM games)
 *
 * Every download goes through Hostwerk's image cache (ctx.imageCache: https only, images only, 3 MB, cached 14 days and
 * served offline). Which address worked is remembered in <data>/game-servers/art.json, so the next time it is ONE cached
 * request. Nothing found → 404 and the interface shows a monogram tile. In offline mode nothing is asked and no
 * "not found" is remembered.
 */
const fs = require('fs');
const path = require('path');

const STEAM_CDN = ['https://shared.akamai.steamstatic.com/store_item_assets/steam/apps', 'https://cdn.cloudflare.steamstatic.com/steam/apps'];
const LGSM_ICON = (short) => `https://raw.githubusercontent.com/GameServerManagers/LinuxGSM/master/lgsm/data/gameicons/${short}-icon.png`;
const SEARCH_URL = (term) => `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(term)}&l=english&cc=US`;
const MISS_AGE = 7 * 24 * 3600e3; // try again after a week (a new game may get its art later)
const FILE = 'art.json';

/** "Valheim Dedicated Server", "ARK: Survival Evolved Server", "Terraria (tShock)" → name of the game for the store search. */
function gameNameOf(name) {
  return String(name || '')
    .replace(/\(.*?\)/g, ' ')
    .replace(/\b(dedicated server|dedicated|server tool|server files|server|ds)\b\s*$/i, '')
    .replace(/\b(dedicated server|dedicated)\b/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}
/** Compare names loosely ("Counter-Strike 2" = "counter strike 2", "Garry's Mod" = "garrys mod"). */
const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim();

/** Picture addresses of one Steam app in the order they are tried. shape: 'wide' (cards) or 'square' (icons). */
function steamUrls(appid, shape = 'wide') {
  const id = Number(appid);
  if (!Number.isInteger(id) || id < 1) return [];
  const files = shape === 'square' ? ['library_600x900.jpg', 'header.jpg'] : ['header.jpg', 'capsule_616x353.jpg', 'capsule_231x87.jpg'];
  return files.flatMap((f) => STEAM_CDN.map((h) => `${h}/${id}/${f}`));
}

class GameArt {
  /**
   * dataDir: the extension's data folder · imageCache: Hostwerk's ctx.imageCache ({ get(url) → { file, type } | null })
   * fetchImpl: fetch for the store search · offline: () => true while Hostwerk's offline mode is on
   */
  constructor({ dataDir, imageCache, fetchImpl = (...a) => globalThis.fetch(...a), offline = () => false, now = () => Date.now() } = {}) {
    this.dataDir = dataDir;
    this.cache = imageCache || null;
    this.fetch = fetchImpl;
    this.offline = offline;
    this.now = now;
    this.mem = null;
    this.pending = new Map();
  }
  get file() { return path.join(this.dataDir, FILE); }
  load() {
    if (!this.mem) { try { this.mem = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { this.mem = {}; } }
    if (!this.mem.art) this.mem.art = {};
    if (!this.mem.names) this.mem.names = {};
    return this.mem;
  }
  save() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.mem));
      fs.renameSync(tmp, this.file);
    } catch { /* only a cache */ }
  }

  /** Cleaned request: { appid (server tool), game (Steam app of the game), short (LinuxGSM), name, shape }. */
  static query(q = {}) {
    const num = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 && n < 1e9 ? n : null; };
    return {
      appid: num(q.appid),
      game: num(q.game),
      short: /^[a-z0-9]{1,24}$/.test(String(q.short || '')) ? String(q.short) : null,
      name: String(q.name || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 120),
      shape: q.shape === 'square' ? 'square' : 'wide',
    };
  }
  key(q) { return [q.shape, q.game || '', q.appid || '', q.short || '', q.game || q.appid ? '' : norm(q.name)].join('|'); }

  /** Steam app id of a game by its name – asked once in the store search, the answer (also "none") is remembered. */
  async appIdByName(name) {
    const term = gameNameOf(name);
    if (term.length < 2) return null;
    const mem = this.load();
    const k = norm(term);
    const hit = mem.names[k];
    if (hit && (hit.id || this.now() - hit.t < MISS_AGE)) return hit.id || null;
    if (this.offline()) return null;
    let id = null;
    try {
      const r = await this.fetch(SEARCH_URL(term), { headers: { Accept: 'application/json', 'User-Agent': 'Hostwerk game servers' }, signal: AbortSignal.timeout(10000) });
      if (!r || !r.ok) return null; // Steam answers badly right now → do not remember anything
      const j = await r.json();
      const items = (j && Array.isArray(j.items) ? j.items : []).filter((x) => x && x.type === 'app' && Number.isInteger(Number(x.id)));
      // Same name first, then a name starting with it ("Rust" must not become "Rusty Lake") – never soundtracks, DLC …
      const ok = (x) => !/soundtrack|\bost\b|\bdlc\b|demo|playtest|artbook/i.test(x.name || '');
      const exact = items.find((x) => ok(x) && norm(x.name) === k);
      const starts = items.find((x) => ok(x) && (norm(x.name).startsWith(`${k} `) || k.startsWith(`${norm(x.name)} `)));
      id = Number((exact || starts || {}).id) || null;
    } catch { return null; }
    mem.names[k] = { id, t: this.now() };
    this.save();
    return id;
  }

  /** Addresses to try, best first. */
  async candidates(q) {
    const sq = q.shape === 'square';
    const lgsm = q.short ? [LGSM_ICON(q.short)] : [];
    const out = [];
    if (sq) out.push(...lgsm);
    if (q.game) out.push(...steamUrls(q.game, q.shape));
    if (q.appid && q.appid !== q.game) out.push(...steamUrls(q.appid, q.shape));
    if (!q.game && q.name) { const id = await this.appIdByName(q.name); if (id && id !== q.appid) out.push(...steamUrls(id, q.shape)); }
    if (!sq) out.push(...lgsm);
    return [...new Set(out)];
  }

  /** { file, type, url } of the picture or null – remembered per request. */
  resolve(raw) {
    const q = GameArt.query(raw);
    if (!this.cache || (!q.game && !q.appid && !q.short && !q.name)) return Promise.resolve(null);
    const k = this.key(q);
    if (this.pending.has(k)) return this.pending.get(k);
    const p = (async () => {
      const mem = this.load();
      const known = mem.art[k];
      if (known && known.url) {
        const hit = await this.cache.get(known.url).catch(() => null);
        if (hit) return { ...hit, url: known.url };
        if (this.offline()) return null;
      } else if (known && this.now() - known.t < MISS_AGE) return null;
      if (this.offline()) return null;
      for (const url of await this.candidates(q)) {
        const hit = await this.cache.get(url).catch(() => null);
        if (hit) { mem.art[k] = { url, t: this.now() }; this.save(); return { ...hit, url }; }
        if (this.offline()) return null; // switched off meanwhile – do not remember a miss
      }
      mem.art[k] = { url: null, t: this.now() };
      this.save();
      return null;
    })().finally(() => this.pending.delete(k));
    this.pending.set(k, p);
    return p;
  }

  /** Address that worked last time (for Hostwerk's own icon search) or the first candidates without asking anyone. */
  known(raw) {
    const q = GameArt.query(raw);
    const hit = this.load().art[this.key(q)];
    if (hit && hit.url) return [hit.url];
    return [...(q.short && q.shape === 'square' ? [LGSM_ICON(q.short)] : []), ...steamUrls(q.game || q.appid, q.shape).slice(0, 2), ...(q.short && q.shape !== 'square' ? [LGSM_ICON(q.short)] : [])];
  }

  routes(r) {
    r.get('/games/art', async (req, res) => {
      const hit = await this.resolve(req.query || {}).catch(() => null);
      if (!hit) return res.status(404).end();
      res.setHeader('Content-Type', hit.type);
      res.setHeader('Cache-Control', 'private, max-age=86400');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
      res.sendFile(hit.file);
    });
  }
}

module.exports = { GameArt, gameNameOf, steamUrls, LGSM_ICON, STEAM_CDN, SEARCH_URL, MISS_AGE };
