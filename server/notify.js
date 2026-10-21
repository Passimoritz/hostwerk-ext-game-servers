'use strict';
/*
 * Messages about game servers (crash, restart by the monitor, update to a new version) – through Hostwerk's channels
 * (message in the interface, push to the phone if set up) and optionally a Discord channel (webhook).
 * Settings: settings.games.notify = { crash: true, update: true, discord: '<webhook url>' | '' }
 */

const DISCORD = /^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d{5,25}\/[\w-]{20,120}$/;

/** Webhook-Adresse prüfen: nur echte Discord-Webhooks (sonst könnte man Hostwerk beliebige Adressen aufrufen lassen). */
function checkWebhook(url) {
  const u = String(url || '').trim();
  if (!u) return '';
  if (!DISCORD.test(u)) throw Object.assign(new Error('This is not a Discord webhook address (https://discord.com/api/webhooks/…).'), { status: 400 });
  return u;
}

/**
 * notifier(cfg, deps) → async ({ event: 'crash' | 'update' | 'test', text, kind }) – sends to the channels that are on.
 * deps: { broadcast(msg), push?: { send }, fetch? } – injectable for tests.
 */
function notifier(cfg, { broadcast = () => {}, push = null, fetch: doFetch = globalThis.fetch } = {}) {
  return async ({ event, text, kind = 'info' }) => {
    const c = cfg();
    if (event !== 'test' && c[event] === false) return { sent: [] };
    const sent = [];
    try { broadcast({ type: 'toast', kind, text }); sent.push('toast'); } catch { /* egal */ }
    if (push && typeof push.send === 'function') { try { await push.send({ title: text, kind: kind === 'warn' ? 'warn' : kind, url: '/#/ext/game-servers', event: 'games' }); sent.push('push'); } catch { /* egal */ } }
    if (c.discord && doFetch) {
      try {
        const r = await doFetch(c.discord, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: String(text).slice(0, 1900), allowed_mentions: { parse: [] } }), signal: AbortSignal.timeout(8000) });
        if (r && r.ok !== false) sent.push('discord');
      } catch { /* Discord nicht erreichbar – Hostwerk meldet trotzdem */ }
    }
    return { sent };
  };
}

module.exports = { notifier, checkWebhook, DISCORD };
