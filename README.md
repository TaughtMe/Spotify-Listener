# Hörbuch-Merker für Spotify

Kleine PWA, die sich merkt, wo du in Hörbüchern auf Spotify aufgehört hast (Kapitel + Minute), auch wenn die Hörbücher als normale Musik-Alben gespeichert sind. Ein Tipp auf ▶ öffnet Spotify und setzt das Hörbuch an der gemerkten Stelle fort.

## Einrichtung

1. **Spotify-App anlegen:** <https://developer.spotify.com/dashboard> → *Create app*.
   - *Redirect URI:* die URL, unter der die PWA läuft, mit abschließendem `/`, z. B. `https://taughtme.github.io/Spotify-Listener/` (die App zeigt sie dir unter ⚙ an).
   - *APIs used:* **Web API**.
2. **Client-ID kopieren** (Settings der Spotify-App). Ein Client-Secret wird nicht gebraucht.
3. **Auf GitHub Pages veröffentlichen:** Repo → *Settings → Pages → Deploy from branch → main / root*.
4. **Auf dem Handy** die Seite in Chrome öffnen → Menü → *App installieren*.
5. In der App ⚙ öffnen, Client-ID eintragen, *Speichern & anmelden*.

## Benutzung

- Spiele ein Hörbuch in Spotify ab und lass die PWA offen. Passt Titel/Album-Name zu einem Schlagwort (Standard: kapitel, chapter, hörbuch, audiobook, prolog, epilog), fragt sie einmal: **Als Hörbuch merken**.
- Danach wird Kapitel und Minute alle 5 s aktualisiert, solange die App im Vordergrund ist.
- Wenn du die App später öffnest, trägt sie Kapitel nach, die du in der Zwischenzeit gehört hast (dann ohne Minute, mit Kapitelanfang).
- ▶ in der Liste setzt das Hörbuch an der gemerkten Stelle fort (2 s Rücklauf).

## Grenzen

- Android pausiert Web-Apps im Hintergrund. Die Minutengenauigkeit gibt es nur, solange die PWA sichtbar ist.
- Fortsetzen per Web API erfordert **Spotify Premium**.
- Gespeichert wird lokal im Browser (`localStorage`), nichts verlässt dein Gerät außer den Spotify-Aufrufen.
- Spotify-Apps im Development Mode erlauben nur explizit eingetragene Nutzer (Dashboard → *User Management*, deine eigene E-Mail eintragen).
