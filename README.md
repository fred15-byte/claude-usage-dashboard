# claude-usage-dashboard

Zeigt auf einen Blick dein **5-Stunden-Limit** und **Wochenlimit** von Claude (Pro/Max): wie viel verbraucht ist, wann es zurückgesetzt wird, ob du im Tempo liegst – plus einen **Token-Zähler** (5h-Fenster / Woche / Heute, nach Modell aufgeschlüsselt).

## Verbraucht es mein Limit? Nein – 0 Tokens.

- **Limits & Reset-Zeiten** kommen vom selben Endpoint, den Claude Code für `/usage` nutzt (`api.anthropic.com/api/oauth/usage`). Das ist eine reine Statusabfrage, kein Modellaufruf. Ergebnis wird 60 s zwischengespeichert (geteilt zwischen Dashboard, CLI und Statuszeile).
- **Token-Zähler** liest nur die lokalen Logs in `~/.claude/projects/**/*.jsonl` – inkrementell (nur neue Bytes), Dateien älter als 7 Tage werden übersprungen.
- Das Browser-Tab fragt 1×/Minute ab und **pausiert im Hintergrund**; Countdowns laufen lokal.
- Keine Abhängigkeiten, kein Build. Nur Node ≥ 18.

## Start

```bash
git clone <dieses-repo> && cd claude-usage-dashboard
npm start               # öffnet http://localhost:4747
```

Voraussetzung: Du warst auf dem Rechner einmal mit `claude` eingeloggt (Abo-Login). Der Token wird aus `~/.claude/.credentials.json` bzw. auf macOS aus dem Schlüsselbund gelesen und nur an `api.anthropic.com` geschickt. Läuft der Token ab, einmal `claude` öffnen – das erneuert ihn.

### Weitere Modi

```bash
node bin/claude-usage.mjs cli          # einmalige Ausgabe im Terminal
node bin/claude-usage.mjs serve --port 8080
```

### Als Claude-Code-Statuszeile (immer sichtbar, ebenfalls 0 Tokens)

In `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node /PFAD/ZU/claude-usage-dashboard/bin/claude-usage.mjs statusline"
  }
}
```

Ausgabe z. B.: `5h 62% ↻1h 23m │ Wo 31% ↻3T 9h │ 583.8k tok`

## Hinweise

- Der senkrechte Strich im Balken markiert, wie viel Zeit im Fenster schon vergangen ist. Liegt der Verbrauch deutlich darüber, warnt das Dashboard, dass du das Limit vor dem Reset erreichen könntest.
- Die Token-Fenster richten sich nach den offiziellen Reset-Zeiten. Ohne Limit-Daten werden rollierende 5 h / 7 Tage verwendet.
- Der Token-Zähler kennt nur Nutzung über **Claude Code auf diesem Rechner**. Die Prozentwerte der Limits enthalten dagegen alles (auch claude.ai, App, andere Geräte).
- Der Usage-Endpoint ist nicht offiziell dokumentiert und kann sich ändern.
- Optional: `CLAUDE_CONFIG_DIR` (abweichendes Claude-Verzeichnis), `CLAUDE_USAGE_TTL` (Cache in Sekunden, Standard 60), `PORT`.
