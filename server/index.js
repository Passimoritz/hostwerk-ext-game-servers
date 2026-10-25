'use strict';
/*
 * Game servers (LinuxGSM): Valheim, Palworld, Rust, CS2, Satisfactory … – natively on Linux, in Docker everywhere else.
 * Provides ctx.games (Hostwerk's overview, tasks, audit log, icons and the game network extension use it).
 */
const { GameServers } = require('./gameservers');
const { imageSource } = require('./imageupdates');
const { backupSource, registerBackups } = require('./backupsource');

exports.activate = (host) => {
  const games = host.provide('games', new GameServers(host));
  games.art.routes(host.router); // /games/art before /games/:id
  games.routes(host.router);
  // Dienst-Art „game“ und Beiträge (SDK 3.5): Übersicht, Dateien, Aufgaben, Bilder, Selbstwartung, Änderungsprotokoll
  if (typeof host.serviceKind === 'function') host.serviceKind(require('./kind').gameKind(games));
  if (typeof host.contribute === 'function') host.contribute('clickguard', { block: [/^\/games\/[^/]+\/(send|install)/, /^\/games$/, /^\/games\/steam\/apps\/refresh/, /^\/games\/[^/]+\/backups\/[^/]+\/restore/] }); // Klick-Test: wirkt außerhalb des Test-Ordners
  if (typeof host.contribute === 'function') {
    const name = (id) => { try { return games.get(id).name; } catch { return id; } };
    host.contribute('advisor', { kind: 'game', label: 'Spiele-Server', open: { id: 'game', route: '/spiele' }, start: /valheim|rust\b|palworld|terraria|ark\b|satisfactory|counter-?strike|gmod|garry|zomboid|7 days|factorio|spieleserver|game ?server|steam/i }); // Berater „Was brauche ich?“
    host.contribute('keeper', { catalogs: [{ id: 'lgsm', label: 'Spiele-Server (LinuxGSM-Serverliste)', text: 'täglich aus GitHub, Rückfall eingebaut' }] });
    host.contribute('audit', { routes: [[/^\/games\/([^/]+)\/(start|stop|restart|update|validate|backup|install|command)$/, (m) => ({ kind: 'Spiele-Server', target: name(m[1]), action: { start: 'gestartet', stop: 'gestoppt', restart: 'neu gestartet', update: 'aktualisiert', validate: 'Dateien geprüft', backup: 'Backup erstellt', install: 'installiert', command: 'Befehl ausgeführt' }[m[2]], undo: ['start', 'stop'].includes(m[2]) ? { method: 'POST', path: `/games/${m[1]}/${m[2] === 'start' ? 'stop' : 'start'}`, label: m[2] === 'start' ? 'wieder stoppen' : 'wieder starten' } : null })]] });
  }
  require('./extras').extras(games, host); // Meldungen (Absturz/Update, Discord), Spieler für andere Erweiterungen, Steam-Workshop
  // "Start with Hostwerk": native servers right away, Docker servers once the engine is ready (monitor tick)
  host.on('autostart', () => (process.env.HW_TEST ? [] : [() => games.startAutostart()]));
  // Synergie mit Router & Portfreigaben: „von außen erreichbar“ → Firewall und Router-Automatik (Hostwerk ab 2.11)
  if (host.ctx.security && typeof host.ctx.security.addPortProvider === 'function') host.ctx.security.addPortProvider('game-servers', () => games.publicPorts());
  // Security updates for the LinuxGSM image of Docker servers (Hostwerk 2.11+: patchUpdates.register) – with trial and fallback
  const pu = host.ctx.patchUpdates;
  const offUpdates = pu && typeof pu.register === 'function' ? pu.register('game-servers', imageSource(games, host)) : null;
  // Spielstände in der Sicherungs-Zentrale und in der externen Sicherung (Hostwerk 2.12+, SDK 2.10) – vorher ohne
  const { runJob } = host.core('jobs');
  const offBackups = registerBackups(host, backupSource(games, { t: (s, v) => host.t(s, v), runJob, zipDir: (src, dest) => host.core('util').zipDir(src, dest) }));
  host.on('shutdown', () => { if (offBackups) offBackups(); if (offUpdates) offUpdates(); if (host.ctx.security && host.ctx.security.removePortProvider) host.ctx.security.removePortProvider('game-servers'); return games.stop(); });
  // 2.0: Teil „Verbund“ (bis 1.3 eigene Erweiterung „Spiele-Server-Verbund“) – Daten settings.gameNetwork, Dienst gameNetwork
  require('./network-ext').activate(host);
};

exports.deactivate = () => {};
