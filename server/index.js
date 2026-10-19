'use strict';
/*
 * Game servers (LinuxGSM): Valheim, Palworld, Rust, CS2, Satisfactory … – natively on Linux, in Docker everywhere else.
 * Provides ctx.games (Hostwerk's overview, tasks, audit log, icons and the game network extension use it).
 */
const { GameServers } = require('./gameservers');

exports.activate = (host) => {
  const games = host.provide('games', new GameServers(host));
  games.routes(host.router);
  // "Start with Hostwerk": native servers right away, Docker servers once the engine is ready (monitor tick)
  host.on('autostart', () => (process.env.HW_TEST ? [] : [() => games.startAutostart()]));
  host.on('shutdown', () => games.stop());
};

exports.deactivate = () => {};
