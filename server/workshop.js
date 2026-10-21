'use strict';
/*
 * Steam Workshop for Steam server tools: a list of workshop items per server (id or link), downloaded and updated with
 * SteamCMD ("+workshop_download_item <app> <item>", anonymous login – works for every workshop that allows dedicated
 * servers to download). Items land in <server>/steamapps/workshop/content/<app>/<item>; the game's start line or config
 * points there (game-specific – the page shows the folder). LinuxGSM servers have their own "mods-install".
 * Data: server.workshop = { appid, items: ['123', …], updatedAt }
 */
const fs = require('fs');
const path = require('path');

/** "https://steamcommunity.com/sharedfiles/filedetails/?id=2800000000" or "2800000000" → "2800000000" (else null). */
function parseItem(x) {
  const s = String(x || '').trim();
  const m = s.match(/[?&]id=(\d{4,12})\b/) || s.match(/^(\d{4,12})$/);
  return m ? m[1] : null;
}
/** List from text (one per line, commas or spaces) – unique, at most 200. */
function parseList(text) {
  const out = [];
  for (const part of (Array.isArray(text) ? text : String(text || '').split(/[\s,;]+/))) { const id = parseItem(part); if (id && !out.includes(id)) out.push(id); }
  return out.slice(0, 200);
}
/** SteamCMD arguments for downloading/updating all items in one run. */
function workshopArgs(dir, appid, items) {
  const app = String(Number(appid));
  return ['+force_install_dir', dir, '+login', 'anonymous', ...items.flatMap((id) => ['+workshop_download_item', app, String(id), 'validate']), '+quit'];
}
const contentDir = (dir, appid) => path.join(dir, 'steamapps', 'workshop', 'content', String(Number(appid)));
/** Which items are there (with date) – for the list on the page. */
function status(dir, appid, items) {
  return items.map((id) => { const p = path.join(contentDir(dir, appid), id); let at = null; try { at = fs.statSync(p).mtimeMs; } catch { /* not there */ } return { id, there: at != null, at }; });
}
/** Results of SteamCMD per item: "Success. Downloaded item 123 to …" / "ERROR! Download item 123 failed (…)". */
function results(out) {
  const ok = new Set(); const failed = new Map();
  for (const m of String(out || '').matchAll(/Success\. Downloaded item (\d+)/g)) ok.add(m[1]);
  for (const m of String(out || '').matchAll(/ERROR! Download item (\d+) failed \(([^)]*)\)/g)) failed.set(m[1], m[2]);
  return { ok: [...ok], failed: [...failed].map(([id, why]) => ({ id, why })) };
}

module.exports = { parseItem, parseList, workshopArgs, contentDir, status, results };
