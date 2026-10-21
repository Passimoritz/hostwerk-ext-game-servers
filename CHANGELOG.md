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
