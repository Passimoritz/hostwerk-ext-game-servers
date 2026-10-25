'use strict';
/*
 * Spiele-Server als Dienst-Art „game“ (SDK 3.5, host.serviceKind): Übersicht, Dateien, Suche, Aufgaben, Bilder und
 * Start/Stopp laufen über Hostwerks gemeinsame Bausteine. Bis Hostwerk 3.1 kannte der Kern ctx.games selbst.
 */
const PH = require('./phase');

/** Ordner eines Servers für Hostwerks Dateien: eigener Ordner, bei Docker das Volume bzw. der Bind-Ordner des Containers */
function fileRootOf(games, g) {
  if (g.mode !== 'docker') return { path: g.externalDir || games.dir(g) };
  const vol = g.volume ? String(g.volume) : `hw-game-${g.id}`;
  const bind = /[\\/]/.test(vol);
  const wsl = `\\\\wsl.localhost\\${process.env.HW_WSL_DISTRO || 'hostwerk-docker'}`;
  const p = process.platform === 'win32'
    ? (bind ? `${wsl}${vol.replace(/\//g, '\\')}` : `${wsl}\\var\\lib\\docker\\volumes\\${vol}\\_data`)
    : (bind ? vol : `/var/lib/docker/volumes/${vol}/_data`);
  return { path: p, docker: true };
}

function gameKind(games) {
  const state = (g) => { const ph = games.phaseNow(g); if (PH.isBusy(ph)) return 'starting'; return g.running ? 'running' : 'stopped'; };
  const job = (id, command) => { const r = games.run(id, command); return r && r.promise ? r.promise : r; };
  return {
    kind: 'game',
    label: { de: 'Spiele-Server', en: 'Game servers' },
    one: { de: 'Spiele-Server', en: 'Game server' },
    icon: 'gamepad-2', color: '#7c3aed', route: '/spiele', api: '/games',
    // Hostwerk.services(): kind „game“ wie seit SDK 2.10; /overview hat die Server weiter unter „games“ (Form wie bisher: summary)
    sdk: { kind: 'game', base: '/games', overviewKey: 'games', overview: () => games.summary() },
    list: () => games.list(),
    get: (id) => games.get(id),
    dir: (id) => fileRootOf(games, games.get(id)).path,
    fileRoot: (g) => fileRootOf(games, g),
    proc: (id) => { const g = games.get(id); return { state: state(g), extra: { players: [] } }; },
    info: (g) => games.info(g),
    start: (id) => job(id, 'start'),
    stop: (id) => job(id, 'stop'),
    restart: (id) => job(id, 'restart'),
    detail: (g) => [g.gameName || g.game, g.mode === 'docker' ? 'Docker' : null].filter(Boolean).join(' · '),
    iconSources: (id) => games.iconSources(id),
    // Docker-Image (Hostwerks Image-Liste für Erweiterungen, z. B. Schwachstellen-Wächter)
    image: (g) => (g.mode === 'docker' ? games.imageOf(g) : null),
    tasks: {
      // Gespeicherte Aufgaben vor 3.2 haben die Art „game“ – darum task.type statt „game-control“
      control: {
        type: 'game',
        label: { de: 'Spiele-Server steuern', en: 'Control a game server' },
        help: 'target = Server-ID, command = start|stop|restart|update|backup|monitor …',
        fields: [{ key: 'command', type: 'select', default: 'monitor', label: { de: 'Befehl', en: 'Command' },
          options: ['monitor', 'start', 'stop', 'restart', 'update', 'backup', 'validate'].map((c) => ({ value: c, label: { de: games.label(c), en: games.label(c) } })) }],
        validate: (a) => { games.get(a.target); },
        clean: (a) => ({ command: String(a.command || 'monitor').replace(/[^a-z-]/g, '') || 'monitor' }),
        async run(a) {
          const r = await job(a.target, a.command || 'monitor');
          return String((r && (r.output || r.text)) || 'ok').slice(-3000);
        },
      },
    },
  };
}

module.exports = { gameKind, fileRootOf };
