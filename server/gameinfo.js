'use strict';
/*
 * Small facts around picking a game: which games are popular (shown first), roughly how much memory a server wants,
 * and a free port for a new server (no clash with other game servers or with programs already listening).
 *
 * Memory values are rough guides for a small group (the makers' and the community's usual numbers, rounded up) – they
 * only lead to a hint ("this PC has 8 GB"), never to a refusal.
 */
const os = require('os');
const net = require('net');
const dgram = require('dgram');
const SG = require('./steamgames');

/** Popular games – Steam app ids of the SERVER TOOLS, in this order on top of the list. */
const POPULAR_STEAM = [896660, 2394010, 1690800, 258550, 294420, 380870, 2430930, 730, 2278520, 1829350, 443030, 4020, 1110390, 298740, 376030, 232250];
/** Same for LinuxGSM scripts. */
const POPULAR_LGSM = ['vhserver', 'pwserver', 'sfserver', 'rustserver', 'sdtdserver', 'pzserver', 'cs2server', 'tsserver', 'arkserver', 'gmodserver', 'fctrserver', 'unturnedserver', 'tf2server', 'ets2server', 'squadserver', 'stserver'];

/** Rough memory need (GB) – by Steam app id of the server tool and by LinuxGSM script. */
const RAM_STEAM = { 896660: 4, 2394010: 16, 1690800: 12, 258550: 12, 294420: 8, 380870: 4, 2430930: 16, 376030: 8, 730: 4, 2278520: 8, 1829350: 4, 443030: 8, 4020: 2, 1110390: 2, 298740: 8, 232250: 2 };
const RAM_LGSM = { vhserver: 4, pwserver: 16, sfserver: 12, rustserver: 12, sdtdserver: 8, pzserver: 4, cs2server: 4, csgoserver: 2, tsserver: 1, terrariaserver: 1, arkserver: 8, gmodserver: 2, fctrserver: 2, unturnedserver: 2, tf2server: 2, ets2server: 2, squadserver: 8, stserver: 4 };

const popularRank = (list, key) => { const i = list.indexOf(key); return i < 0 ? null : i; };
function ramFor({ appid, game } = {}) {
  if (appid && RAM_STEAM[Number(appid)]) return RAM_STEAM[Number(appid)];
  if (game && RAM_LGSM[String(game)]) return RAM_LGSM[String(game)];
  return null;
}
/** Memory hint for the interface: { gb, total, tight } – tight = the server wants more than ~¾ of this PC's memory. */
function ramHint(key, totalBytes = os.totalmem()) {
  const gb = ramFor(key);
  if (!gb) return null;
  const total = Math.round(totalBytes / 1073741824);
  return { gb, total, tight: gb > totalBytes / 1073741824 * 0.75 };
}

/**
 * Ports a profile uses relative to its main port (moved together) – fixed extra ports (e.g. Palworld's query 27015)
 * stay where they are. Valheim: [0, 1] → the next free main port is 2 further.
 */
function portOffsets(appid, base) {
  const p = SG.profileFor(appid);
  if (!p) return [0];
  const offs = p.ports(base).map((x) => x.port - base).filter((d) => d >= 0 && d <= 20);
  return offs.length ? [...new Set([0, ...offs])] : [0];
}

/** Can a program listen on this port (TCP and UDP)? */
function portFree(port) {
  const tcp = new Promise((res) => {
    const s = net.createServer();
    s.once('error', () => res(false));
    s.listen({ port, host: '0.0.0.0', exclusive: true }, () => s.close(() => res(true)));
  });
  const udp = new Promise((res) => {
    const s = dgram.createSocket('udp4');
    s.once('error', () => { try { s.close(); } catch { /* closed */ } res(false); });
    s.bind({ port, address: '0.0.0.0', exclusive: true }, () => s.close(() => res(true)));
  });
  return Promise.all([tcp, udp]).then(([a, b]) => a && b);
}

/**
 * Next main port from `base` on whose ports (base + offsets) nothing is in the way: neither another game server of this
 * list (`used`) nor a program on this PC (`isFree`). Gives { port, moved, taken: [ports in the way at base] }.
 */
async function suggestPort({ base, offsets = [0], used = new Set(), isFree = portFree, tries = 40 }) {
  const step = Math.max(...offsets) + 1;
  const taken = [];
  for (let i = 0; i < tries; i++) {
    const main = base + i * step;
    const ports = offsets.map((o) => main + o);
    if (ports.some((p) => p > 65535)) break;
    const clash = [];
    for (const p of ports) if (used.has(p) || !(await isFree(p))) clash.push(p);
    if (i === 0) taken.push(...clash);
    if (!clash.length) return { port: main, moved: i > 0, taken };
  }
  return { port: base, moved: false, taken };
}

module.exports = { POPULAR_STEAM, POPULAR_LGSM, RAM_STEAM, RAM_LGSM, popularRank, ramFor, ramHint, portOffsets, portFree, suggestPort };
