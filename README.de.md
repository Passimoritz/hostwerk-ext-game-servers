![Spiele-Server](banner.svg)

# Spiele-Server

Valheim, Palworld, Rust, Terraria, Satisfactory und über 100 weitere Spiele über LinuxGSM – nativ auf Linux, unter Windows als Docker-Container.

[English](README.md) · Offizielle [Hostwerk](https://github.com/Passimoritz/hostwerk-public)-Erweiterung (SDK 2.7, native Erweiterung)

![Bildschirmfoto](docs/screenshot.de.png)

## Was sie kann

- Alle Spiele aus der LinuxGSM-Liste, mit Logos zur Auswahl
- Konsole, Befehle senden, Spielerliste, Karte und Version per Steam-Abfrage (A2S)
- Alle LinuxGSM-Befehle – auch die spielspezifischen, die das Skript anbietet (z. B. wipe bei Rust)
- Updates (automatisch, wenn niemand spielt), Backups, Überwachen mit Neustart nach Absturz
- Ports und Adressen, Freigabe über die Erweiterung „Router & Portfreigaben“
- Mit Hostwerk starten, Einstellungs-Editor (lgsm-Konfiguration) und Dateibrowser

## Installieren

In Hostwerk unter **Erweiterungen → Entdecken** auf „Installieren“ klicken. Wer die Funktion schon in Hostwerk 2.8 benutzt hat, bekommt die Erweiterung beim Update automatisch – mit allen Daten.

Native Erweiterungen laufen als Teil von Hostwerk (eigener Server- und Oberflächen-Teil). Darum installiert Hostwerk sie nur aus dem offiziellen Katalog (mit Prüfsumme) oder im Entwickler-Modus.

## Daten

`settings.games, <Hostwerk>/spiele/<server>, Docker volumes hw-game-<server>` – genau dort, wo Hostwerk sie schon immer abgelegt hat. Entfernen der Erweiterung löscht nichts.

## Entwickeln

```bash
node --test tests/*.test.js          # Tests
node build-native.js .               # Oberfläche bauen (sdk/build-native.js aus hostwerk-public)
node check.js . --strict             # Prüfung wie im Katalog (sdk/check.js)
```

Quelltext der Oberfläche in `ui/src`, Server-Teil in `server/`. Texte im Code sind Englisch, Deutsch steht in `locales/de.json`.

## Lizenz

MIT
