'use strict';
/*
 * Security updates for game servers in Docker (Hostwerk 2.11+: ctx.patchUpdates.register). Game servers are the services
 * with the most contact to the internet – the game itself updates on every container start (UPDATE_ON_START), but the
 * LinuxGSM image underneath (Ubuntu, libraries, LinuxGSM) only arrived with a new setup. Now:
 *   updates()  compares the image a server's container uses with the current one on Docker Hub (digest of the tag),
 *   plan(u)    pulls the new image, creates the container again (data stays in the volume) and starts it if it ran –
 *              it has to keep running; otherwise the previous image gets its name back and the container is made again.
 * Native (Linux) and SteamCMD servers keep updating the game themselves (6 h check / on start) – nothing to do here.
 */
const HUB = 'https://hub.docker.com/v2/repositories/gameservermanagers/gameserver/tags/';
const quietJob = { log() {}, progress() {}, status() {} };
const short = (d) => String(d || '').replace(/^.*sha256:/, '').slice(0, 12);

/**
 * gs: GameServers, host: the extension host (texts). opts.fetchJson / opts.wait for tests (never real Docker Hub or Docker).
 */
function imageSource(gs, host, { fetchJson = null, wait = null, settleMs = 15000 } = {}) {
  const T = (s, v) => (host && host.t ? host.t(s, v) : s);
  const get = fetchJson || (async (url) => { const r = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'Hostwerk' }, signal: AbortSignal.timeout(15000) }); if (!r.ok) throw new Error(`Docker Hub ${r.status}`); return r.json(); });
  const sleep = wait || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const imageOf = (s) => `gameservermanagers/gameserver:${s.game.replace(/server$/, '')}`;
  const servers = () => gs.list().filter((s) => s.installed && gs.isDocker(s) && !gs.isSteam(s));
  const dockerUp = async () => { try { return !!(await gs.ctx.docker.status()).running; } catch { return false; } };
  const inspect = async (args) => { const r = await gs.dx(args, { ok: true, timeout: 30000 }); return r.code === 0 ? String(r.stdout || '').trim() : ''; };
  /** Digests the local image is known under (RepoDigests) and its id. */
  const local = async (image) => {
    let digests = [];
    try { digests = JSON.parse((await inspect(['image', 'inspect', '--format', '{{json .RepoDigests}}', image])) || '[]') || []; } catch { digests = []; }
    return { id: await inspect(['image', 'inspect', '--format', '{{.Id}}', image]), digests: digests.map((d) => String(d).replace(/^.*@/, '')) };
  };
  const recreate = async (s, start) => {
    await gs.dx(['rm', '-f', gs.cname(s)], { ok: true });
    await gs.dx(gs.lgsmCreateArgs(s), { timeout: 120000 });
    s.specHash = gs.lgsmSpecHash(s); gs.ctx.settings.save();
    if (start) await gs.dx(['start', gs.cname(s)], { timeout: 60000 });
  };
  const runningNow = async (s) => (await inspect(['inspect', '--format', '{{.State.Running}}', gs.cname(s)])) === 'true';
  return {
    label: 'Game servers (Docker image)',
    labels: { de: 'Spiele-Server (Docker-Image)', en: 'Game servers (Docker image)' },
    items() { return servers().map((s) => ({ key: `game-${s.id}`, label: s.name, version: `LinuxGSM ${s.game.replace(/server$/, '')}` })); },
    async updates() {
      const list = servers();
      if (!list.length || !(await dockerUp())) return [];
      const out = [];
      const seen = new Map(); // one Docker Hub request per image
      for (const s of list) {
        const image = imageOf(s);
        if (!seen.has(image)) {
          const tag = await get(HUB + encodeURIComponent(image.split(':')[1])).catch(() => null);
          seen.set(image, tag && (tag.digest || (Array.isArray(tag.images) && tag.images[0] && tag.images[0].digest)) ? { digest: tag.digest || tag.images[0].digest, at: tag.last_updated || null } : null);
        }
        const remote = seen.get(image);
        if (!remote) continue;
        const l = await local(image);
        if (!l.id || l.digests.includes(remote.digest)) continue;
        out.push({ key: `game-${s.id}`, label: s.name, current: short(l.digests[0] || l.id), latest: short(remote.digest), target: s.id, image });
      }
      return out;
    },
    plan(u) {
      const s = gs.get(u.target);
      const st = { oldId: null, was: false };
      return {
        install: async () => {
          st.oldId = (await local(u.image)).id;
          st.was = await gs.running(s).catch(() => false);
          await gs.ctx.docker.pullInto(quietJob, u.image);
          return st;
        },
        probe: async () => {
          await recreate(s, st.was);
          if (!st.was) return; // stopped: creating the container with the new image is the test
          await sleep(settleMs);
          if (!(await runningNow(s))) throw new Error(T('{name} does not keep running with the new image.', { name: s.name }));
        },
        activate: async () => { gs.broadcast({ type: 'games' }); },
        discard: async () => {
          if (st.oldId) await gs.dx(['tag', st.oldId, u.image], { ok: true });
          await recreate(s, st.was).catch(() => {});
          gs.broadcast({ type: 'games' });
        },
      };
    },
  };
}

module.exports = { imageSource };
