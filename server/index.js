'use strict';
/*
 * Game servers (LinuxGSM): Valheim, Palworld, Rust, CS2, Satisfactory … – natively on Linux, in Docker everywhere else.
 * Provides ctx.games (Hostwerk's overview, tasks, audit log, icons and the game network extension use it).
 */
const { GameServers } = require('./gameservers');
const { imageSource } = require('./imageupdates');

exports.activate = (host) => {
  const games = host.provide('games', new GameServers(host));
  games.routes(host.router);
  // "Start with Hostwerk": native servers right away, Docker servers once the engine is ready (monitor tick)
  host.on('autostart', () => (process.env.HW_TEST ? [] : [() => games.startAutostart()]));
  // Synergie mit Router & Portfreigaben: „von außen erreichbar“ → Firewall und Router-Automatik (Hostwerk ab 2.11)
  if (host.ctx.security && typeof host.ctx.security.addPortProvider === 'function') host.ctx.security.addPortProvider('game-servers', () => games.publicPorts());
  // Security updates for the LinuxGSM image of Docker servers (Hostwerk 2.11+: patchUpdates.register) – with trial and fallback
  const pu = host.ctx.patchUpdates;
  const offUpdates = pu && typeof pu.register === 'function' ? pu.register('game-servers', imageSource(games, host)) : null;
  host.on('shutdown', () => { if (offUpdates) offUpdates(); if (host.ctx.security && host.ctx.security.removePortProvider) host.ctx.security.removePortProvider('game-servers'); return games.stop(); });
};

exports.deactivate = () => {};
