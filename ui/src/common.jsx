import { toast } from '@hostwerk/ui';
import { SvcImage, LazyImg } from '@hostwerk/kit';
import { apiUrl } from '@hostwerk/api';
import { t } from '@hostwerk/i18n';

/* Game servers – shared helpers of the interface (paths, labels, game logos). */

export const BASE = '#/ext/game-servers';
export const isSteam = (s) => s.method === 'steam' || s.kind === 'steam';
/** Initials on a colour from the name – the fallback for a missing picture (never an empty grey box). */
export function Monogram({ name, className = '', style }) {
  const words = String(name || '?').replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  const letters = (words.length > 1 ? words[0][0] + words[1][0] : (words[0] || '?').slice(0, 2)).toUpperCase();
  let h = 0; for (const ch of String(name || '')) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return <span className={`gs-mono ${className}`} style={{ ...style, '--h': h }} aria-hidden="true">{letters}</span>;
}
/**
 * Picture of a game: Hostwerk looks it up once by the game (Steam art of the game – not of the server tool, which has
 * none –, the store search by name, the LinuxGSM icon), keeps it in its image cache and serves it from there, also
 * offline. shape: 'wide' (cards, Steam header) or 'square' (icons). Until it is there a shimmer, without one initials.
 */
export function GameArt({ appid, game, short, name, shape = 'wide', className = '', size }) {
  const q = new URLSearchParams();
  if (appid) q.set('appid', String(appid));
  if (game) q.set('game', String(game));
  if (short) q.set('short', String(short));
  if (name) q.set('name', String(name));
  q.set('shape', shape);
  const style = size ? { width: size, height: size } : undefined;
  const cls = `gs-art ${shape} ${className}`;
  return <LazyImg src={apiUrl(`/api/games/art?${q}`)} className={cls} style={style} fit="cover" fallback={<Monogram name={name || short} className={cls} style={style} />} />;
}
/** Square game picture for icons (server list, quick start). appid = Steam app of the GAME. */
export function GameLogo({ short, appid, size = 28, name }) {
  return <GameArt short={short} game={appid} name={name || short} shape="square" className="game-logo" size={size} />;
}
export const shortOf = (s) => (isSteam(s) ? null : s.short || String(s.game || '').replace(/server$/, ''));
export const GameIcon = ({ s, size = 30, className = 'svc-icon' }) => <SvcImage kind="game" id={s.id} name={s.name} className={className} size={size} fallback={<GameLogo short={shortOf(s)} appid={isSteam(s) ? s.gameAppId : null} size={size} name={s.gameName || s.name} />} />;
export const methodLabel = (s) => `${isSteam(s) ? 'SteamCMD' : 'LinuxGSM'}${s.docker ? ' · Docker' : ''}`;
export const isInstalling = (jobs, id) => { const list = Object.values(jobs || {}).filter((j) => j.state === 'running'); return list.find((j) => j.key === `game-quick-${id}`) || list.find((j) => j.key === `game-create-${id}`) || null; };
export const innerJob = (jobs, id) => Object.values(jobs || {}).find((j) => j.key === `game-create-${id}` && j.state === 'running') || null;
export const stateOf = (s, installing) => (s.running ? 'running' : s.installed ? 'stopped' : installing ? 'starting' : 'error');
export const stateLabel = (s, installing) => (s.installed ? undefined : installing ? t('Installing …') : t('not installed'));
export const fmtTime = (sec) => { const m = Math.floor((sec || 0) / 60); return m >= 60 ? t('{h} h {m} min', { h: Math.floor(m / 60), m: m % 60 }) : t('{m} min', { m }); };
export const copy = (x) => navigator.clipboard.writeText(x).then(() => toast.success('Address copied'));
export const cmdLabel = (s, cmd) => (s.commands && s.commands[cmd] ? t(s.commands[cmd]) : cmd);
// Game names stay as they are
/** Markenfarbe eines Spiels als lesbare Textfarbe: halb Marke, halb Hostwerks Textfarbe – dunkel im hellen Design, hell im dunklen. */
export const readable = (c) => `color-mix(in srgb, ${c} 55%, var(--text))`;
export const POPULAR = [['Valheim', '#d97706'], ['Palworld', '#38bdf8'], ['Rust', '#ce422b'], ['Terraria', '#22c55e'], ['Satisfactory', '#f59e0b'], ['ARK', '#64748b'], ['7 Days to Die', '#b91c1c'], ['Project Zomboid', '#84cc16']];
export const goServer = (id, tab = '') => { location.hash = `${BASE.slice(1)}/${id}${tab ? `/${tab}` : ''}`; };
