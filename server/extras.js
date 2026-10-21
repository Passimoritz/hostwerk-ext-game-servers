'use strict';
/*
 * Extras next to the game servers themselves (own paths, so they never collide with /games/:id/:command):
 *   GET  /api/games-notify             → { crash, update, discord: bool } – who gets told about crashes and updates
 *   PUT  /api/games-notify             → { crash?, update?, discord? (webhook url, '' = off) }
 *   POST /api/games-notify/test        → test message to every channel that is on
 *   GET  /api/games-players            → players of every running server (Steam query) – also ctx.games.allPlayers()
 *   GET  /api/games-workshop/:id       → { appid, items: [{ id, there, at }], dir, docker }
 *   PUT  /api/games-workshop/:id       → { appid, items: 'id or link per line' }
 *   POST /api/games-workshop/:id/update → job: download/update every item with SteamCMD
 */
const { notifier, checkWebhook } = require('./notify');
const W = require('./workshop');
const { DOCKER_IMAGE } = require('./steam');

function extras(games, host) {
  const { ctx } = host;
  const T = (s, v) => host.t(s, v);
  const cfg = () => { const c = games.cfg; if (!c.notify) c.notify = { crash: true, update: true, discord: '' }; return c.notify; };
  games.notifier = notifier(cfg, { broadcast: (m) => host.broadcast(m), push: ctx.push || null });
  const r = host.router;
  r.get('/games-notify', (req, res) => { const c = cfg(); res.json({ crash: c.crash !== false, update: c.update !== false, discord: !!c.discord }); });
  r.put('/games-notify', (req, res) => {
    const b = req.body || {}; const c = cfg();
    for (const k of ['crash', 'update']) if (typeof b[k] === 'boolean') c[k] = b[k];
    if (b.discord !== undefined) c.discord = checkWebhook(b.discord);
    ctx.settings.save();
    res.json({ crash: c.crash !== false, update: c.update !== false, discord: !!c.discord });
  });
  r.post('/games-notify/test', async (req, res) => res.json(await games.notifier({ event: 'test', text: T('Test message from Hostwerk’s game servers'), kind: 'info' })));
  r.get('/games-players', async (req, res) => res.json(await games.allPlayers()));

  const steamOnly = (s) => { if (!games.isSteam(s)) throw Object.assign(new Error(T('The workshop list is for Steam server tools – LinuxGSM servers use the command “mods-install”.')), { status: 400 }); return s; };
  const view = (s) => {
    const w = s.workshop || {}; const appid = w.appid || s.gameAppId || null; const items = w.items || [];
    const dir = games.dir(s);
    return { appid, items: games.isDocker(s) ? items.map((id) => ({ id, there: null, at: null })) : appid ? W.status(dir, appid, items) : items.map((id) => ({ id, there: false, at: null })), dir: appid ? W.contentDir(games.isDocker(s) ? '/data/server' : dir, appid) : null, docker: games.isDocker(s), updatedAt: w.updatedAt || null, failed: w.failed || [] };
  };
  r.get('/games-workshop/:id', (req, res) => res.json(view(steamOnly(games.get(req.params.id)))));
  r.put('/games-workshop/:id', (req, res) => {
    const s = steamOnly(games.get(req.params.id)); const b = req.body || {};
    const appid = b.appid === undefined ? (s.workshop || {}).appid : Number(b.appid) || null;
    if (appid !== null && appid !== undefined && !(Number.isInteger(appid) && appid > 0 && appid < 1e8)) throw Object.assign(new Error(T('The app id is a number (from the game’s Steam page).')), { status: 400 });
    s.workshop = { ...(s.workshop || {}), appid: appid || null, items: b.items !== undefined ? W.parseList(b.items) : (s.workshop || {}).items || [] };
    ctx.settings.save();
    res.json(view(s));
  });
  r.post('/games-workshop/:id/update', (req, res) => {
    const s = steamOnly(games.get(req.params.id));
    const w = s.workshop || {}; const appid = w.appid || s.gameAppId; const items = w.items || [];
    if (!appid) throw Object.assign(new Error(T('Enter the game’s app id first.')), { status: 400 });
    if (!items.length) throw Object.assign(new Error(T('Add workshop items first.')), { status: 400 });
    const { runJob } = host.core('jobs');
    const job = runJob(T('{name}: update workshop items', { name: s.name }), async (j) => {
      let out;
      if (games.isDocker(s)) {
        await games.dockerReady();
        const r2 = await games.dx(['run', '--rm', '--name', `hostwerk-workshop-${s.id}`, '-v', `${games.steam.volume(s)}:/data`, DOCKER_IMAGE, '/home/steam/steamcmd/steamcmd.sh', ...W.workshopArgs('/data/server', appid, items)], { ok: true, timeout: 3 * 3600e3 });
        out = r2.stdout + r2.stderr;
      } else {
        const exe = await games.steam.ensureSteamCmd(j);
        out = (await games.steam.runLogged(j, exe, W.workshopArgs(games.dir(s), appid, items), { cwd: require('path').dirname(exe) })).out;
      }
      const x = W.results(out);
      s.workshop = { ...(s.workshop || {}), updatedAt: Date.now(), failed: x.failed };
      ctx.settings.save();
      games.broadcast({ type: 'games' });
      if (x.failed.length) throw new Error(T('{n} items failed: {list}', { n: x.failed.length, list: x.failed.map((f) => `${f.id} (${f.why})`).join(', ') }));
      return { ok: true, text: T('{n} workshop items up to date', { n: x.ok.length || items.length }) };
    }, { key: `game-workshop-${s.id}` });
    res.json({ job: job.id });
  });
}

module.exports = { extras };
