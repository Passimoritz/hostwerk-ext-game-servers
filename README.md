![Game servers](banner.svg)

# Game servers

Valheim, Palworld, Satisfactory, Rust, ARK and every other Steam server tool through SteamCMD – plus more than 100 games through LinuxGSM. Natively where possible, in Docker containers where not.

[Deutsch](README.de.md) · An official [Hostwerk](https://github.com/Passimoritz/hostwerk-public) extension (SDK 2.7, native extension)

![Screenshot](docs/screenshot.png)

## What it does

- **One-step setup:** pick a game → Docker (only if needed, set up for you) → install → start, as one job with numbered steps
- **Two ways:** Steam server tools through SteamCMD (natively on Windows and Linux, Linux-only tools in Docker) and every game from LinuxGSM’s list
- Steam list stays small: ready-made start lines for popular games built in; the complete list of Steam server tools only on request, read once as a stream, filtered, gzipped, reused for 7 days, searched page by page
- Console, send commands, player list, map and version through the Steam query (A2S)
- Every LinuxGSM command – including the game-specific ones the script offers (e.g. wipe for Rust)
- Updates (automatic when nobody plays), backups, monitor with restart after a crash
- Security updates for the Docker image of LinuxGSM servers through Hostwerk's security updates – with a trial and the previous image as fallback (Hostwerk 2.11 or newer)
- Ports and addresses, forwarding through the “Router & port forwarding” extension
- Start with Hostwerk, settings editor (lgsm config) and file browser
- Settings per server: name, ports, max players, password, start line, config files, update on start, restart after a crash, CPU/RAM limits for containers, scheduled restarts/backups (through Hostwerk’s tasks)
- Console input for Steam servers through RCON (CS2, Garry’s Mod, TF2, Rust, ARK …)
- **Steam Workshop** for Steam server tools: list of items (id or link), downloaded and updated with SteamCMD in one run
- **Messages** after a crash or an update to a new game version – in Hostwerk, on the phone (push) and optionally in a Discord channel (webhook)
- **Players for other extensions:** `GET /api/games-players` and `ctx.games.allPlayers()` (Steam query) – e.g. for a player ticker or a leaderboard
- Error state with *Try again*, no polling while hidden, game colours readable in light and dark mode
- Other extensions may add tabs (`allowExtensions`)

## Install

In Hostwerk: **Extensions → Discover** and click “Install”. If you already used this feature in Hostwerk 2.8, the update installs the extension by itself – with all your data.

Native extensions run as part of Hostwerk (own server and interface part). That is why Hostwerk only installs them from the official catalogue (with checksum) or in developer mode.

## Data

`settings.games, <Hostwerk>/spiele/<server>, Docker volumes hw-game-<server>`, SteamCMD and the cached Steam list in `<Hostwerk>/data/game-servers` – exactly where Hostwerk always kept it. Removing the extension deletes nothing.

## Develop

```bash
node --test tests/*.test.js          # tests
node build-native.js .               # build the interface (sdk/build-native.js from hostwerk-public)
node check.js . --strict             # same check as the catalogue (sdk/check.js)
```

Interface source in `ui/src`, server part in `server/`. Texts in the code are English, German is in `locales/de.json`.

## License

MIT
