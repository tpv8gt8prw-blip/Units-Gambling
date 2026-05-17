# untis.sync // sync-test

Test-Prototyp für die spätere Gambling-Stundenplan-App. Macht erstmal nur eins: bei WebUntis einloggen, deinen Stundenplan holen, sauber anzeigen — inkl. Markierung für **suppliert** und **entfällt**.

## Setup

**Brauchst:** Node.js (v18+). Falls nicht installiert: https://nodejs.org

```bash
cd untis-sync-test
npm install
npm start
```

Dann im Browser öffnen: **http://localhost:3000**

## Login

Du brauchst 4 Sachen:

| Feld | Was | Beispiel |
|------|-----|----------|
| **server** | WebUntis-Server deiner Schule | `mese.webuntis.com` |
| **schule** | Schul-Identifier | `grg10-laaerberg` |
| **username** | Dein normaler Untis-Login | — |
| **passwort** | Dein normales Untis-Passwort | — |

**Server + Schule rausfinden:** Geh auf [webuntis.com](https://webuntis.com), such deine Schule, logg dich ein. Die URL wird dann sowas wie:

```
https://mese.webuntis.com/WebUntis/?school=grg10-laaerberg#/basic/login
        └────── server ──────┘                └── schule ──┘
```

## Was die App macht

1. Frontend sendet deine Credentials an dein lokales Backend (`POST /api/timetable`)
2. Backend nutzt die `webuntis`-npm-Library um sich bei WebUntis einzuloggen
3. Holt den Stundenplan für das gewählte Datum
4. Schickt das Ergebnis als JSON zurück → Frontend rendert

**Credentials werden nirgends gespeichert** — nur einmal pro Request durchgereicht und sofort vergessen.

## Status-Codes (wichtig für später)

WebUntis liefert pro Stunde ein `code`-Feld:
- *kein code* → Stunde findet normal statt
- `irregular` → suppliert (anderer Lehrer/Raum) → **das ist was wir später vergamblen**
- `cancelled` → entfällt komplett

## Troubleshooting

**"Login fehlgeschlagen":** Server-URL oder Schul-Identifier falsch. Check die URL auf webuntis.com nochmal.

**"Bad credentials":** Username/Passwort stimmt nicht. Manchmal ist der Username nicht dein Vorname sondern ein Schul-Username (frag im Sekretariat oder bei nem Lehrer).

**Module nicht gefunden:** `npm install` nochmal ausführen.

**Port 3000 belegt:** `PORT=3001 npm start`

## Nächste Schritte

- [ ] Scratch-Ticket-Layer über jeder Stunde
- [ ] Coins / Streak-System
- [ ] LocalStorage für Server/Schule (Passwort nicht!)
- [ ] Wochen-View statt nur Tagen
- [ ] Push-Notifications wenn neue Supplierung reinkommt
