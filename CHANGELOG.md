## 1.8.0

- Tabs of other extensions on the overview (slot “games.tabs”, Hostwerk 3.0+ with SDK 3.2) – e.g. “Network” from the game network; older Hostwerk versions simply show servers and import. / Reiter anderer Erweiterungen auf der Übersicht (Steckplatz „games.tabs“, Hostwerk 3.0+ mit SDK 3.2) – z. B. „Verbund“ vom Spiele-Verbund; ältere Hostwerk-Versionen zeigen einfach Server und Import.

## 1.7.0

- New “Create game server” dialog in two clear steps: first pick the game (search on top, filters, big cards with the game's picture, popular games first), then set it up (name, free port, where the files go, right on this PC or in Docker, what happens). Explanations sit in one ⓘ instead of text blocks; no more tiny clustered buttons. / Neuer Dialog „Spiele-Server anlegen“ in zwei klaren Schritten: erst das Spiel wählen (Suche oben, Filter, große Karten mit Spielbild, beliebte Spiele zuerst), dann einrichten (Name, freier Port, Speicherort, direkt oder in Docker, was passiert). Erklärungen in einem ⓘ statt Textblöcken; keine gedrängten Mini-Knöpfe mehr.
- Game pictures load: they are looked up by the game (dedicated server tools have no store art of their own), through Steam's current CDN path with the old one as fallback, the store search by name and the LinuxGSM icon – fetched once, kept in Hostwerk's image cache (also offline), initials instead of empty grey boxes. Hostwerk's own server icons use the same pictures (Hostwerk 3.0 or newer). / Spielbilder laden: Sie werden über das Spiel gesucht (Dedicated-Server-Tools haben keine eigenen Shop-Bilder), über Steams aktuellen CDN-Pfad mit dem alten als Rückfall, die Shop-Suche nach Namen und das LinuxGSM-Symbol – einmal geholt, in Hostwerks Bild-Cache gehalten (auch offline), Anfangsbuchstaben statt leerer grauer Kästen. Hostwerks eigene Server-Symbole nutzen dieselben Bilder (ab Hostwerk 3.0).
- Import tab: finds game servers that already exist on this PC – Steam libraries (libraryfolders.vdf, appmanifest), SteamCMD folders, LinuxGSM instances (Linux), LinuxGSM Docker containers and any folder you choose. Take them over where they are or as a copy; port, players and the start line of their script come along. Searching only reads. / Reiter Import: findet vorhandene Spiele-Server auf diesem PC – Steam-Bibliotheken (libraryfolders.vdf, appmanifest), SteamCMD-Ordner, LinuxGSM-Instanzen (Linux), LinuxGSM-Docker-Container und jeden Ordner deiner Wahl. Übernehmen am bisherigen Ort oder als Kopie; Port, Spielerzahl und die Startzeile ihres Skripts kommen mit. Die Suche liest nur.
- Memory hint per popular game (“wants about 16 GB – this PC has 8 GB”), port suggestion without clashes (other game servers and programs on this PC), own folder for a new Steam server, Steam tools with a Linux build can also run in Docker on Windows. / Arbeitsspeicher-Hinweis je beliebtem Spiel („braucht etwa 16 GB – dieser PC hat 8 GB“), Port-Vorschlag ohne Konflikte (andere Spiele-Server und Programme auf diesem PC), eigener Ordner für einen neuen Steam-Server, Steam-Tools mit Linux-Version laufen unter Windows auf Wunsch auch in Docker.
- Removing a server that was taken over in place never deletes its folder. / Ein am bisherigen Ort übernommener Server wird beim Entfernen nie samt Ordner gelöscht.

## 1.6.0

- Game saves in Hostwerk's backup centre (Hostwerk 2.12 or newer): every backup of every server with size and time, restore and delete right there. Restoring stops a running server, first packs the current state as its own backup (“…-before-restore”) and starts the server again afterwards. / Spielstände in Hostwerks Sicherungs-Zentrale (ab Hostwerk 2.12): jede Sicherung jedes Servers mit Größe und Zeit, Zurückspielen und Löschen direkt dort. Beim Zurückspielen wird ein laufender Server gestoppt, der aktuelle Stand vorher als eigene Sicherung gepackt („…-before-restore“) und der Server danach wieder gestartet.
- The off-site backup takes the game saves along (tick “Data from extensions”): the save folder of every Steam server freshly packed, the newest backup of every LinuxGSM server. Docker servers keep their saves in the volume. / Die externe Sicherung nimmt die Spielstände mit (Haken „Daten aus Erweiterungen“): den Spielstand-Ordner jedes Steam-Servers frisch gepackt, die neueste Sicherung jedes LinuxGSM-Servers. Docker-Server behalten ihre Spielstände im Volume.

## 1.5.0

- Steam Workshop for Steam server tools: items by id or link, downloaded and updated with SteamCMD. / Steam-Workshop für Steam-Server-Tools: Inhalte per ID oder Link, mit SteamCMD geladen und aktualisiert.
- Messages after a crash or an update (new game version) through Hostwerk's channels and optionally Discord. / Meldungen nach Absturz oder Update (neue Spielversion) über Hostwerks Kanäle und optional Discord.
- Players of every running server for other extensions (`/api/games-players`, `ctx.games.allPlayers()`). / Spieler aller laufenden Server für andere Erweiterungen (`/api/games-players`, `ctx.games.allPlayers()`).
- Missing German texts (RCON, Steam list, password rule). / Fehlende deutsche Texte (RCON, Steam-Liste, Passwortregel).
- Game colours on the “Another game server” tile readable in light mode. / Spielfarben auf der Kachel „Weiterer Spiele-Server“ im hellen Design lesbar.
- Interface split into modules (setup, tabs, settings, common) instead of one 877-line file. / Oberfläche in Module aufgeteilt (Einrichtung, Reiter, Einstellungen, Gemeinsames) statt einer Datei mit 877 Zeilen.
- Error state with “Try again”; no polling while hidden; sidebar next to Minecraft (`page.nav`); other extensions may add tabs (`allowExtensions`). Release package contains everything except the repository tooling. / Fehlerzustand mit „Erneut versuchen“; keine Abfragen bei verstecktem Reiter; Seitenleiste neben Minecraft (`page.nav`); andere Erweiterungen dürfen Reiter ergänzen (`allowExtensions`). Release-Paket enthält alles außer dem Repo-Werkzeug.

## 1.4.0

- Docker servers (LinuxGSM) register with Hostwerk's security updates: when Docker Hub has a newer image (Ubuntu, libraries, LinuxGSM), it is pulled, the container is made again (data stays in the volume) and a running server has to keep running – otherwise the previous image comes back. / Docker-Server (LinuxGSM) melden sich bei Hostwerks Sicherheits-Updates an: Gibt es auf Docker Hub ein neueres Image (Ubuntu, Bibliotheken, LinuxGSM), wird es geladen, der Container neu angelegt (Daten bleiben im Volume) und ein laufender Server muss weiterlaufen – sonst kommt das vorige Image zurück.
- Windows: Steam servers start without their own console window. / Windows: Steam-Server starten ohne eigenes Konsolenfenster.

## 1.3.0

- One-step setup: with no server yet, pick a game and click "Set up" – Hostwerk sets up Docker if that way needs it (its own engine, no Docker Desktop), installs the server and starts it, as one job with numbered steps. / Einrichtung in einem Schritt: Ohne Server einfach ein Spiel wählen und „Einrichten“ klicken – Hostwerk richtet Docker ein, falls dieser Weg es braucht (eigene Engine, ohne Docker Desktop), installiert den Server und startet ihn, als eine Aufgabe mit nummerierten Schritten.
- Second way next to LinuxGSM: Steam server tools through SteamCMD – every Steam dedicated server, ready-made start lines for popular games (Valheim, Palworld, Satisfactory, ARK, 7 Days to Die, Project Zomboid, Rust, CS2, Garry's Mod, V Rising, Enshrouded, Conan Exiles, Space Engineers, Unturned …), a custom start line for the rest. Natively on Windows and Linux, Linux-only tools in Docker. Updates with SteamCMD on start. / Zweiter Weg neben LinuxGSM: Steam-Server-Tools über SteamCMD – jeder Steam-Dedicated-Server, fertige Startzeilen für beliebte Spiele, eine eigene Startzeile für den Rest. Direkt unter Windows und Linux, reine Linux-Tools in Docker. Updates mit SteamCMD beim Start.
- The Steam list stays small: built in for popular games; the complete list only on request, read once as a stream, filtered to server tools, saved gzipped for 7 days and searched page by page. / Die Steam-Liste bleibt klein: eingebaut für beliebte Spiele; die komplette Liste nur auf Wunsch, einmal als Datenstrom gelesen, auf Server-Tools gefiltert, 7 Tage gepackt gespeichert und seitenweise durchsucht.
- Clear tabs per server (Overview, Console, Players, Settings, Backups, Files) and more settings: name, ports, max players, password, start parameters, config files, update on start, restart after a crash, CPU/RAM limits for containers, scheduled restarts and backups through Hostwerk's tasks, restoring Steam backups, console input through RCON. / Klare Reiter je Server (Übersicht, Konsole, Spieler, Einstellungen, Backups, Dateien) und mehr Einstellungen: Name, Ports, Spielerzahl, Passwort, Startparameter, Konfigurationsdateien, Update beim Start, Neustart nach Absturz, CPU-/RAM-Grenzen für Container, geplante Neustarts und Backups über Hostwerks Aufgaben, Steam-Backups zurückspielen, Konsolen-Eingabe über RCON.
- Needs Hostwerk 2.11. / Braucht Hostwerk 2.11.

## 1.2.0

- Sidebar status: a dot per server (running/stopped); a dashed circle while no server is set up yet (with Hostwerk 2.11 or newer). / Status in der Seitenleiste: ein Punkt je Server (läuft/gestoppt), ein gestrichelter Kreis, solange noch keiner eingerichtet ist (ab Hostwerk 2.11).

## 1.1.0

- "Reachable from outside" per server: its ports join Hostwerk's port check and router forwarding (Live → Security). Needs Hostwerk 2.11 – older versions simply hide the switch. / „Von außen erreichbar“ je Server: die Ports kommen in Hostwerks Port-Prüfung und Router-Freigabe (Livebetrieb → Sicherheit). Braucht Hostwerk 2.11 – ältere Versionen blenden den Schalter aus.

## 1.0.0

- First release as its own extension (before: built into Hostwerk). Data stays where it was. / Erste Fassung als eigene Erweiterung (vorher fest in Hostwerk). Daten bleiben, wo sie waren.
