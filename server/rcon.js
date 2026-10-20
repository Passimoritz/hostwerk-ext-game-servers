'use strict';
/*
 * Source RCON (developer.valvesoftware.com/wiki/Source_RCON_Protocol) – console input for Steam servers started by
 * Hostwerk: srcds games (CS2, Garry's Mod, TF2 …), Rust, ARK. Only ever talks to 127.0.0.1 with the server's own secret.
 *
 * Packet: int32 size | int32 id | int32 type | body (ASCII) \0 \0   (little endian, size = everything after the size field)
 */
const net = require('net');

const AUTH = 3;
const AUTH_RESPONSE = 2;
const EXEC = 2;
const MAX_BODY = 4096;

function encode(id, type, body) {
  const b = Buffer.from(String(body || ''), 'utf8');
  if (b.length > MAX_BODY) throw new Error('RCON command too long');
  const buf = Buffer.alloc(14 + b.length);
  buf.writeInt32LE(10 + b.length, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  b.copy(buf, 12);
  return buf; // the last two bytes stay 0
}

/** Split a byte stream into packets; incomplete data stays in `rest`. */
function decode(buf) {
  const packets = [];
  let off = 0;
  while (buf.length - off >= 4) {
    const size = buf.readInt32LE(off);
    if (size < 10 || size > 1024 * 1024) throw new Error('Invalid RCON packet');
    if (buf.length - off - 4 < size) break;
    const id = buf.readInt32LE(off + 4);
    const type = buf.readInt32LE(off + 8);
    const body = buf.slice(off + 12, off + 4 + size - 2).toString('utf8');
    packets.push({ id, type, body });
    off += 4 + size;
  }
  return { packets, rest: buf.slice(off) };
}

/** Run one command: sign in with the password, send, collect the answer (until a short pause or the timeout). */
function rconExec({ host = '127.0.0.1', port, password, command, timeout = 4000, connect = net.createConnection }) {
  return new Promise((resolve, reject) => {
    if (!Number.isInteger(port) || port < 1 || port > 65535) return reject(new Error('Invalid RCON port'));
    const sock = connect({ host, port });
    let buf = Buffer.alloc(0);
    let authed = false;
    let out = '';
    let quiet = null;
    const done = (err) => { clearTimeout(timer); clearTimeout(quiet); try { sock.destroy(); } catch { /* closed */ } if (err) reject(err); else resolve(out.trim()); };
    const timer = setTimeout(() => (authed ? done() : done(new Error('The server does not answer on the RCON port (still starting?).'))), timeout);
    sock.on('error', (e) => done(new Error(`RCON: ${e.code === 'ECONNREFUSED' ? 'the server does not accept console commands right now (still starting?)' : e.message}`)));
    sock.on('connect', () => sock.write(encode(1, AUTH, password)));
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      let r;
      try { r = decode(buf); } catch (e) { return done(e); }
      buf = r.rest;
      for (const p of r.packets) {
        if (!authed && p.type === AUTH_RESPONSE) {
          if (p.id === -1) return done(new Error('RCON refused the password.'));
          authed = true;
          sock.write(encode(2, EXEC, command));
          quiet = setTimeout(() => done(), 1500);
        } else if (authed && p.id === 2) {
          out += p.body;
          clearTimeout(quiet); quiet = setTimeout(() => done(), 300);
        }
      }
      return undefined;
    });
    sock.on('close', () => { if (authed) done(); });
    return undefined;
  });
}

module.exports = { encode, decode, rconExec, AUTH, EXEC };
