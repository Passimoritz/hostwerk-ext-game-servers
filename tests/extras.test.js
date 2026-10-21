'use strict';
/*
 * Extras without real game servers: messages go to the interface, push and Discord (only real webhook addresses), the
 * workshop list understands ids and links, builds one SteamCMD run for all items and reads its results.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { notifier, checkWebhook } = require('../server/notify');
const W = require('../server/workshop');

const HOOK = 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz_ABCDEF-1234';

test('notify: interface, push and Discord; switched-off events stay quiet', async () => {
  const cfg = { crash: true, update: false, discord: HOOK };
  const seen = []; const posts = [];
  const send = notifier(() => cfg, { broadcast: (m) => seen.push(m.text), push: { send: async (m) => seen.push(`push:${m.title}`) }, fetch: async (url, o) => { posts.push([url, JSON.parse(o.body)]); return { ok: true }; } });
  const r = await send({ event: 'crash', text: 'Valheim crashed', kind: 'warn' });
  assert.deepStrictEqual(r.sent, ['toast', 'push', 'discord']);
  assert.deepStrictEqual(seen, ['Valheim crashed', 'push:Valheim crashed']);
  assert.strictEqual(posts[0][0], HOOK); assert.deepStrictEqual(posts[0][1].allowed_mentions, { parse: [] }, 'no @everyone from server names');
  assert.deepStrictEqual((await send({ event: 'update', text: 'x' })).sent, []);
  assert.deepStrictEqual((await send({ event: 'test', text: 'x' })).sent.length, 3, 'test always goes out');
  const quiet = notifier(() => ({ discord: HOOK }), { fetch: async () => { throw new Error('offline'); } });
  assert.deepStrictEqual((await quiet({ event: 'crash', text: 'y' })).sent, ['toast'], 'Discord offline does not break it');
});

test('webhook: only real Discord webhooks, empty = off', () => {
  assert.strictEqual(checkWebhook(` ${HOOK} `), HOOK); assert.strictEqual(checkWebhook(''), '');
  for (const bad of ['http://discord.com/api/webhooks/1/x', 'https://evil.example/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz', 'https://discord.com.evil.io/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz']) assert.throws(() => checkWebhook(bad), /not a Discord webhook/);
});

test('workshop: ids and links, one SteamCMD run, results per item', () => {
  assert.strictEqual(W.parseItem('https://steamcommunity.com/sharedfiles/filedetails/?id=2800000000&searchtext='), '2800000000');
  assert.strictEqual(W.parseItem('731604991'), '731604991'); assert.strictEqual(W.parseItem('abc'), null); assert.strictEqual(W.parseItem('12'), null);
  assert.deepStrictEqual(W.parseList('731604991\nhttps://steamcommunity.com/sharedfiles/filedetails/?id=2800000000, 731604991 junk'), ['731604991', '2800000000']);
  assert.deepStrictEqual(W.workshopArgs('/srv/ark', 346110, ['1', '2']), ['+force_install_dir', '/srv/ark', '+login', 'anonymous', '+workshop_download_item', '346110', '1', 'validate', '+workshop_download_item', '346110', '2', 'validate', '+quit']);
  const r = W.results('Downloading item 1 ...\nSuccess. Downloaded item 1 to "/srv/x" (123 bytes)\nERROR! Download item 2 failed (Access Denied).');
  assert.deepStrictEqual(r, { ok: ['1'], failed: [{ id: '2', why: 'Access Denied' }] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-'));
  fs.mkdirSync(path.join(W.contentDir(dir, 346110), '1'), { recursive: true });
  assert.deepStrictEqual(W.status(dir, 346110, ['1', '2']).map((x) => [x.id, x.there]), [['1', true], ['2', false]]);
});
