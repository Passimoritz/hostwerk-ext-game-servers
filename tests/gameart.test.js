'use strict';
/*
 * Picking a game: pictures are looked up by the GAME (server tools have none of their own), found once and remembered,
 * nothing is remembered offline; popular games come first, filters narrow before paging; memory hints; a free port that
 * clashes neither with other game servers nor with programs on this PC; an own folder must be empty or new.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { GameArt, gameNameOf, steamUrls, LGSM_ICON } = require('../server/gameart');
const GI = require('../server/gameinfo');
const { SteamAppList } = require('../server/steamlist');
const { ownFolder } = require('../server/steam');

const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `gs-art-${n}-`));

/** Image cache that "has" only the given addresses (and counts what was asked). */
function fakeCache(have) {
  const asked = [];
  return { asked, get: async (url) => { asked.push(url); return have.includes(url) ? { file: `/cache/${asked.length}.jpg`, type: 'image/jpeg' } : null; } };
}

test('names: server tool → game for the store search', () => {
  assert.strictEqual(gameNameOf('Valheim Dedicated Server'), 'Valheim');
  assert.strictEqual(gameNameOf('ARK: Survival Evolved Dedicated Server'), 'ARK: Survival Evolved');
  assert.strictEqual(gameNameOf('Terraria (dedicated server in the game)'), 'Terraria');
  assert.strictEqual(gameNameOf('Arena DS'), 'Arena');
});

test('pictures: the game\'s Steam art first (new CDN path, then the old one), square prefers the LinuxGSM icon', async () => {
  const art = new GameArt({ dataDir: tmp('a'), imageCache: fakeCache([]), fetchImpl: async () => ({ ok: false }) });
  const wide = await art.candidates(GameArt.query({ appid: 896660, game: 892970, name: 'Valheim', shape: 'wide' }));
  assert.strictEqual(wide[0], 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/892970/header.jpg');
  assert.strictEqual(wide[1], 'https://cdn.cloudflare.steamstatic.com/steam/apps/892970/header.jpg');
  assert.ok(wide.indexOf(steamUrls(896660)[0]) > wide.indexOf(steamUrls(892970)[0]), 'the server tool only after the game');
  const sq = await art.candidates(GameArt.query({ short: 'vh', name: 'Valheim', shape: 'square' }));
  assert.strictEqual(sq[0], LGSM_ICON('vh'));
});

test('pictures: found once, remembered on disk – the next time it is one cached request', async () => {
  const dir = tmp('b');
  const want = 'https://cdn.cloudflare.steamstatic.com/steam/apps/892970/header.jpg';
  const c1 = fakeCache([want]);
  const a1 = new GameArt({ dataDir: dir, imageCache: c1 });
  const hit = await a1.resolve({ appid: 896660, game: 892970, name: 'Valheim' });
  assert.strictEqual(hit.url, want);
  assert.strictEqual(c1.asked.length, 2, 'new path tried first, then the old one');
  const c2 = fakeCache([want]);
  const a2 = new GameArt({ dataDir: dir, imageCache: c2 });
  assert.strictEqual((await a2.resolve({ appid: 896660, game: 892970, name: 'Valheim' })).url, want);
  assert.deepStrictEqual(c2.asked, [want]);
  assert.deepStrictEqual(a2.known({ appid: 896660, game: 892970, name: 'Valheim' }), [want], 'Hostwerk\'s icon search gets the address that worked');
});

test('pictures: a tool without game id finds its game through the store search (asked once, answer kept)', async () => {
  const dir = tmp('c');
  const calls = [];
  const fetchImpl = async (url) => { calls.push(url); return { ok: true, json: async () => ({ items: [{ type: 'app', id: 999, name: 'Coolgame Soundtrack' }, { type: 'app', id: 1234, name: 'CoolGame' }] }) }; };
  const want = steamUrls(1234)[0];
  const art = new GameArt({ dataDir: dir, imageCache: fakeCache([want]), fetchImpl });
  assert.strictEqual((await art.resolve({ appid: 555001, name: 'CoolGame Dedicated Server' })).url, want);
  assert.strictEqual(calls.length, 1);
  assert.match(calls[0], /storesearch\/\?term=CoolGame&/);
  assert.strictEqual(await art.appIdByName('CoolGame Server'), 1234);
  assert.strictEqual(calls.length, 1, 'the answer is remembered');
});

test('pictures: nothing found → null (interface shows initials); offline nothing is asked and no miss remembered', async () => {
  const dir = tmp('d');
  let offline = true;
  const calls = [];
  const cache = fakeCache([]);
  const art = new GameArt({ dataDir: dir, imageCache: cache, offline: () => offline, fetchImpl: async (u) => { calls.push(u); return { ok: false }; } });
  assert.strictEqual(await art.resolve({ appid: 777, name: 'Nothing Dedicated Server' }), null);
  assert.strictEqual(cache.asked.length, 0);
  assert.strictEqual(calls.length, 0);
  assert.deepStrictEqual(art.load().art, {}, 'no "not found" while offline');
  offline = false;
  assert.strictEqual(await art.resolve({ appid: 777, name: 'Nothing Dedicated Server' }), null);
  assert.ok(cache.asked.length > 0);
  const n = cache.asked.length;
  assert.strictEqual(await art.resolve({ appid: 777, name: 'Nothing Dedicated Server' }), null);
  assert.strictEqual(cache.asked.length, n, 'a miss is remembered for a week');
  assert.strictEqual(await new GameArt({ dataDir: dir, imageCache: null }).resolve({ appid: 1 }), null, 'without Hostwerk\'s image cache: no picture, no error');
});

test('list: popular first without a search term, filters before paging', () => {
  const list = new SteamAppList({ dataDir: tmp('e') });
  const top = list.search({ limit: 3, popular: GI.POPULAR_STEAM }).items.map((x) => x.appid);
  assert.deepStrictEqual(top, GI.POPULAR_STEAM.slice(0, 3));
  const ready = list.search({ limit: 100, filter: (x) => x.profile });
  assert.ok(ready.items.length > 10 && ready.items.every((x) => x.profile));
  assert.strictEqual(ready.total, ready.items.length);
  assert.strictEqual(list.search({ q: 'valheim', popular: GI.POPULAR_STEAM }).items[0].appid, 896660);
});

test('memory hint: rough need and whether it gets tight on this PC', () => {
  assert.deepStrictEqual(GI.ramHint({ appid: 2394010 }, 8 * 1073741824), { gb: 16, total: 8, tight: true });
  assert.deepStrictEqual(GI.ramHint({ game: 'vhserver' }, 32 * 1073741824), { gb: 4, total: 32, tight: false });
  assert.strictEqual(GI.ramHint({ appid: 1 }), null);
});

test('port: next free main port in steps of the ports a game uses; clashes with other servers and programs count', async () => {
  assert.deepStrictEqual(GI.portOffsets(896660, 2456), [0, 1], 'Valheim: game + query');
  assert.deepStrictEqual(GI.portOffsets(2394010, 8211), [0], 'Palworld: its fixed query port 27015 does not move');
  const free = async (p) => p !== 2460;
  assert.deepStrictEqual(await GI.suggestPort({ base: 2456, offsets: [0, 1], used: new Set([2457]), isFree: free }), { port: 2458, moved: true, taken: [2457] });
  assert.deepStrictEqual(await GI.suggestPort({ base: 2456, offsets: [0, 1], used: new Set([2457, 2459]), isFree: free }), { port: 2462, moved: true, taken: [2457] }, '2458 clashes at 2459, 2460 is used by a program');
  assert.deepStrictEqual(await GI.suggestPort({ base: 2456, offsets: [0, 1], used: new Set(), isFree: async () => true }), { port: 2456, moved: false, taken: [] });
  assert.strictEqual(typeof (await GI.portFree(0)), 'boolean', 'a real check works (port 0 = any)');
});

test('own folder: complete path, new or empty – never a folder that holds something', () => {
  const d = tmp('f');
  assert.strictEqual(ownFolder(path.join(d, 'neu')), path.join(d, 'neu'));
  assert.strictEqual(ownFolder(d), path.resolve(d), 'empty folder is fine');
  fs.writeFileSync(path.join(d, 'x.txt'), 'x');
  assert.throws(() => ownFolder(d), /not empty/);
  assert.throws(() => ownFolder('relative/folder'), /complete path/);
  assert.throws(() => ownFolder(path.join(d, 'missing', 'deeper')), /parent folder/);
});
