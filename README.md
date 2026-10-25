![Game servers](banner.svg)

# Game servers

> **Since 2.0 with networks:** this also contains the former “Game server network” – as the tab “Network” on the game servers page: servers that belong together start in order, share a schedule and a password, with ports and router forwarding at a glance. Anyone who had it gets this version automatically; the networks stay.

Valheim, Palworld, Satisfactory, Rust, ARK and every other Steam server tool through SteamCMD – plus more than 100 games through LinuxGSM. Natively where possible, in Docker containers where not.

[Deutsch](README.de.md) · An official [Hostwerk](https://github.com/Passimoritz/hostwerk-public) extension (native extension, Hostwerk 2.11 or newer)

![Screenshot](docs/screenshot.png)

## What it does

- Tabs of other extensions on the overview (slot “games.tabs”, Hostwerk 3.0+ with SDK 3.2) – e.g. “Network” from the game network; older Hostwerk versions simply show servers and import.
- **One-step setup:** pick a game → Docker (only if needed, set up for you) → install → start, as one job with numbered steps
- **Two ways:** Steam server tools through SteamCMD (natively on Windows and Linux, Linux-only tools in Docker) and every game from LinuxGSM’s list
- Steam list stays small: ready-made start lines for popular games built in; the complete list of Steam server tools only on request, read once as a stream, filtered, gzipped, reused for 7 days, searched page by page
- **Picking a game in two steps:** search, filters (ready-made start, without Docker, popular) and big cards with the game's picture – then name, a free port, where the files go and native/Docker; memory hint for popular games
- **Game pictures without upkeep:** looked up by the game (Steam CDN, store search, LinuxGSM icon), fetched once and kept in Hostwerk's image cache, also offline; initials when there is none
- **Import existing servers:** Steam libraries, SteamCMD folders, LinuxGSM instances (Linux), LinuxGSM Docker containers and a folder of your choice – take them over where they are or as a copy, with port, players and start line; searching only reads
- **Honest state:** “Installing” / “Updating” / “Starting” instead of “Running” while the container is still downloading the game – with a bar (“Downloading: 5.1 GB of 6.4 GB – 20 MB/s, about 2 min. left”) in the header, the state card, the server list, Hostwerk's overview tile and the task window; recognised for every game from SteamCMD's progress, LinuxGSM's sections and status lines, the image's health check and the Steam query, with a time limit so nothing stays “installing” forever
- Care buttons that would fail during the installation are locked with the reason (ⓘ); stopping always works; errors name the cause (still installing, no disk space, Steam unreachable, login needed …) instead of “code 1”
- Console, send commands, player list, map and version through the Steam query (A2S); SteamCMD progress lines summarized in the console (raw output one click away)
- Every LinuxGSM command – including the game-specific ones the script offers (e.g. wipe for Rust)
- Updates (automatic when nobody plays), backups, monitor with restart after a crash
- Game saves in Hostwerk’s backup centre (restore and delete there, the current state is backed up first) and in the off-site backup (“Data from extensions”) – Hostwerk 2.12 or newer
- Security updates for the Docker image of LinuxGSM servers through Hostwerk's security updates – with a trial and the previous image as fallback (Hostwerk 2.11 or newer)
- Ports and addresses, forwarding through the “Router & port forwarding” extension
- Start with Hostwerk, settings editor (lgsm config) and file browser
- Settings per server: name, ports, max players, password, start line, config files, update on start, restart after a crash, CPU/RAM limits for containers, scheduled restarts/backups (through Hostwerk’s tasks)
- Console input for Steam servers through RCON (CS2, Garry’s Mod, TF2, Rust, ARK …)
- **Steam Workshop** for Steam server tools: list of items (id or link), downloaded and updated with SteamCMD in one run
- **Messages** after a crash or an update to a new game version – in Hostwerk, on the phone (push) and optionally in a Discord channel (webhook)
- **Players for other extensions:** `GET /api/games-players` and `ctx.games.allPlayers()` (Steam query) – e.g. for a player ticker or a leaderboard
- **Versions for other extensions:** `ctx.games.summary()` names the installed build (Steam build id from SteamCMD's app manifest, where Steam knows it) and the Docker image with tag – e.g. for the vulnerability watch; read only
- Error state with *Try again*, no polling while hidden, game colours readable in light and dark mode
- Other extensions may add tabs (`allowExtensions`)

## Install

In Hostwerk: **Extensions → Discover** and click “Install”. If you already used this feature in Hostwerk 2.8, the update installs the extension by itself – with all your data.

Native extensions run as part of Hostwerk (own server and interface part). That is why Hostwerk only installs them from the official catalogue (with checksum) or in developer mode.

## Data

`settings.games, <Hostwerk>/spiele/<server>, Docker volumes hw-game-<server>`, SteamCMD, the cached Steam list and the remembered picture addresses (`art.json`) in `<Hostwerk>/data/game-servers`; servers taken over stay in their folder or container – exactly where Hostwerk always kept it. Removing the extension deletes nothing.

## Develop

```bash
node --test tests/*.test.js          # tests
node build-native.js .               # build the interface (sdk/build-native.js from hostwerk-public)
node check.js . --strict             # same check as the catalogue (sdk/check.js)
```

Interface source in `ui/src`, server part in `server/`. Texts in the code are English, German is in `locales/de.json`.

## License

MIT
