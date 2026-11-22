'use strict';
/*
 * „Port belegt“ vor dem Start: Lauscht schon ein Programm auf einem Port des Servers (oft eine verwaiste Instanz, deren
 * Startskript beim harten Beenden von Hostwerk wegfiel), scheitert der Start sonst unklar oder still. TCP und UDP werden
 * nur gelesen (netstat / ss) – kein Probe-Lauschen, das die Windows-Firewall-Rückfrage auslösen könnte.
 */
const cp = require('child_process');

const IS_WIN = process.platform === 'win32';
const run = (cmd, args) => new Promise((resolve) => cp.execFile(cmd, args, { windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024 }, (err, out) => resolve(err ? '' : String(out))));

/** netstat -ano (Windows) → Map(port → pid) für TCP (lauschend) bzw. UDP (gebunden). */
function parseNetstat(text, proto) {
  const map = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.trim().split(/\s+/);
    if (m[0] !== proto) continue;
    if (proto === 'TCP' && !(/:0$/.test(m[2] || '') || /LISTEN|ABH/i.test(m[3] || ''))) continue;
    const port = Number(((m[1] || '').match(/:(\d+)$/) || [])[1]);
    const pid = Number(m[m.length - 1]);
    if (port && !map.has(port)) map.set(port, pid || 0);
  }
  return map;
}
/** ss -lntupH (Linux) → { tcp: Map, udp: Map } (port → { pid, name }). */
function parseSs(text) {
  const out = { tcp: new Map(), udp: new Map() };
  for (const line of String(text || '').split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5) continue;
    const kind = /^udp/i.test(cols[0]) ? 'udp' : /^tcp/i.test(cols[0]) ? 'tcp' : null;
    if (!kind) continue;
    const port = Number((cols[4].match(/:(\d+)$/) || [])[1]);
    const m = line.match(/users:\(\("([^"]+)",pid=(\d+)/);
    if (port && !out[kind].has(port)) out[kind].set(port, { pid: m ? Number(m[2]) : 0, name: m ? m[1] : '' });
  }
  return out;
}
/** tasklist /FO CSV /NH → Map(pid → Name). */
function parseTasklist(text) {
  const names = new Map();
  for (const line of String(text || '').split(/\r?\n/)) { const m = line.match(/^"([^"]+)","(\d+)"/); if (m) names.set(Number(m[2]), m[1]); }
  return names;
}

/** Protokolle eines Port-Eintrags ({ port, proto: 'UDP' | 'TCP' | 'TCP/UDP' }). */
const protosOf = (p) => { const s = String(p.proto || 'udp').toLowerCase(); return [...(/tcp/.test(s) ? ['tcp'] : []), ...(/udp/.test(s) || !/tcp/.test(s) ? ['udp'] : [])]; };

/** Welche der Ports sind schon belegt? → [{ port, proto: 'TCP'|'UDP', pid, name }] */
async function busyPorts(ports, { exec = run, win = IS_WIN } = {}) {
  const want = [];
  for (const p of ports || []) { const port = Number(p.port); if (Number.isInteger(port) && port > 0 && port < 65536) for (const pr of protosOf(p)) want.push({ port, proto: pr }); }
  if (!want.length) return [];
  const hits = [];
  if (win) {
    const [tcp, udp, tl] = await Promise.all([exec('netstat', ['-ano', '-p', 'TCP']), exec('netstat', ['-ano', '-p', 'UDP']), exec('tasklist', ['/FO', 'CSV', '/NH'])]);
    const maps = { tcp: parseNetstat(tcp, 'TCP'), udp: parseNetstat(udp, 'UDP') };
    const names = parseTasklist(tl);
    for (const w of want) if (maps[w.proto].has(w.port)) { const pid = maps[w.proto].get(w.port); hits.push({ port: w.port, proto: w.proto.toUpperCase(), pid, name: names.get(pid) || '' }); }
  } else {
    const maps = parseSs(await exec('ss', ['-lntupH']));
    for (const w of want) if (maps[w.proto].has(w.port)) { const x = maps[w.proto].get(w.port); hits.push({ port: w.port, proto: w.proto.toUpperCase(), pid: x.pid, name: x.name }); }
  }
  // Gleicher Port mit TCP und UDP vom selben Programm: einmal nennen
  return hits.filter((h, i) => hits.findIndex((x) => x.port === h.port && x.pid === h.pid) === i);
}

module.exports = { busyPorts, parseNetstat, parseSs, parseTasklist };
