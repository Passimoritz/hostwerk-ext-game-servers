'use strict';
/*
 * Spielstände in Hostwerks Sicherungs-Zentrale (SDK 2.10: host.backups.register, ältere Hostwerk-Fassungen ohne – dann
 * bleibt alles wie bisher auf der eigenen Seite):
 *   list()     Sicherungen aller Server – Steam-Server (ZIP des Spielstand-Ordners) und LinuxGSM auf Linux (.tar.gz)
 *   restore()  nur Steam-Server auf diesem PC: läuft der Server, wird er gestoppt, der aktuelle Stand vorher als eigene
 *              Sicherung („…-before-restore.zip“, zählt nicht gegen „Sicherungen behalten“) gepackt, dann zurückgespielt
 *              und der Server wieder gestartet
 *   remove()   eine Sicherung löschen
 *   offsite()  externe Sicherung (Haken „Daten aus Erweiterungen“): je Steam-Server der Spielstand-Ordner frisch gepackt,
 *              je LinuxGSM-Server die neueste Sicherung; Docker-Server liegen in Volumes und bleiben außen vor (Hinweis im Protokoll)
 * Kennung eines Stands: "<server-id>~<datei>" – die Datei wird nie als Pfad genommen (basename + Endung geprüft).
 */
const fs = require('fs');
const path = require('path');
const { safeRel } = require('./steam');

const SEP = '~';
const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

/** "<server>~<datei>" → { server, file } (wirft bei allem, was kein Dateiname einer Sicherung ist) */
function parseId(id, err) {
  const s = String(id || '');
  const i = s.indexOf(SEP);
  const server = i > 0 ? s.slice(0, i) : '';
  const file = i > 0 ? s.slice(i + 1) : '';
  if (!/^[\w-]{1,64}$/.test(server) || !file || path.basename(file) !== file || !/\.(zip|tar\.gz)$/.test(file)) throw err(404, 'Backup not found');
  return { server, file };
}

/**
 * games = GameServers (server/gameservers.js), deps = { t, runJob, zipDir } – in Tests nachgebildet.
 * Ergebnis ist die Quelle für ctx.backupCenter.register (siehe Hostwerk server/services/backupcenter.js).
 */
function backupSource(games, deps) {
  const T = deps.t || ((s) => s);
  const err = (status, text, vars) => Object.assign(new Error(T(text, vars)), { status });
  const steamLocal = (s) => games.isSteam(s) && !games.isDocker(s);
  const dirOf = (s) => path.join(games.dir(s), 'backups');
  const find = (id) => {
    const { server, file } = parseId(id, err);
    const s = games.get(server);
    const full = path.join(dirOf(s), file);
    if (!fs.existsSync(full)) throw err(404, 'Backup not found');
    return { s, file, full };
  };

  return {
    label: { de: 'Spielstände', en: 'Game saves' },
    list() {
      const out = [];
      for (const s of games.list()) {
        let items = [];
        try { items = games.backups(s) || []; } catch { items = []; }
        for (const b of items) {
          out.push({ id: `${s.id}${SEP}${b.file}`, label: b.file.replace(/\.(zip|tar\.gz)$/, ''), t: b.time, size: b.size, auto: /auto/.test(b.file),
            svc: s.id, svcName: s.name, stopsService: steamLocal(s) });
        }
      }
      return out;
    },
    restore(id) {
      const { s, file } = find(id);
      if (!steamLocal(s)) throw err(400, games.isDocker(s) ? 'Restoring works for servers on this PC – in Docker mode use the Files tab.' : 'Restoring LinuxGSM backups: see the LinuxGSM guide (the archive holds the whole server).');
      if (!/\.zip$/.test(file)) throw err(400, 'Not a backup');
      return deps.runJob(T('{name}: restore backup', { name: s.name }), async (job) => {
        const was = await games.steam.alive(s).catch(() => false);
        if (was) { job.progress(5, T('Stopping the server …')); await games.run(s.id, 'stop').promise; }
        try {
          // Vorher den aktuellen Stand sichern – wie jeder andere Weg in der Sicherungs-Zentrale
          const src = s.saves ? safeRel(games.dir(s), s.saves) : null;
          if (src && fs.existsSync(src)) {
            job.progress(20, T('Backing up the current state first …'));
            fs.mkdirSync(dirOf(s), { recursive: true });
            await deps.zipDir(src, path.join(dirOf(s), `${s.id}-${stamp()}-before-restore.zip`));
          }
          job.progress(60, T('Restoring {file} …', { file }));
          const r = await games.steam.restore(s, file);
          return { ok: true, text: r && r.text ? r.text : T('Restored.') };
        } finally {
          if (was) { job.progress(90, T('Starting the server again …')); await games.run(s.id, 'start').promise.catch(() => {}); }
        }
      }, { key: `game-${s.id}-restore` });
    },
    remove(id) {
      const { full } = find(id);
      fs.rmSync(full, { force: true });
    },
    async offsite({ dir, job }) {
      const files = [];
      const log = (text) => { if (job && job.log) job.log(text); };
      for (const s of games.list()) {
        try {
          if (games.isDocker(s)) { log(T('{name}: runs in Docker – its saves stay in the volume.', { name: s.name })); continue; }
          if (steamLocal(s)) {
            if (!s.saves) { log(T('{name}: no save folder chosen (Settings → Backups).', { name: s.name })); continue; }
            const src = safeRel(games.dir(s), s.saves);
            if (!fs.existsSync(src)) continue;
            const f = path.join(dir, `game-${s.id}.zip`);
            await deps.zipDir(src, f);
            files.push(f);
          } else {
            const newest = (games.backups(s) || [])[0];
            if (!newest) continue;
            const f = path.join(dir, `game-${s.id}-${newest.file}`);
            fs.copyFileSync(path.join(dirOf(s), newest.file), f);
            files.push(f);
          }
        } catch (e) { log(`${s.name}: ${e.message}`); }
      }
      return files;
    },
  };
}

/** Bei Hostwerk anmelden (ab 2.12) – gibt die Abmelde-Funktion zurück oder null, wenn Hostwerk es noch nicht kann. */
function registerBackups(host, source) {
  if (host.backups && typeof host.backups.register === 'function') return host.backups.register(source);
  const bc = host.ctx && host.ctx.backupCenter;
  if (bc && typeof bc.register === 'function') return bc.register(host.id, source);
  return null;
}

module.exports = { backupSource, registerBackups, parseId, SEP };
