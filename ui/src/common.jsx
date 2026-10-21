import { toast } from '@hostwerk/ui';
import { SvcImage, Logo } from '@hostwerk/kit';
import { t } from '@hostwerk/i18n';

/* Game servers – shared helpers of the interface (paths, labels, game logos). */

export const BASE = '#/ext/game-servers';
export const isSteam = (s) => s.method === 'steam' || s.kind === 'steam';
/** Game logo: LinuxGSM icon or Steam capsule – loaded once visible; without internet a monogram stays. */
export function GameLogo({ short, appid, size = 28, name }) {
  const src = appid ? `https://cdn.cloudflare.steamstatic.com/steam/apps/${Number(appid)}/capsule_sm_120.jpg` : short ? `https://raw.githubusercontent.com/GameServerManagers/LinuxGSM/master/lgsm/data/gameicons/${short}-icon.png` : null;
  return <Logo src={src} name={name || short} className="game-logo" size={size} />;
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
