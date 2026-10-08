# Spotify Time Machine — Browser-Version

Läuft komplett **statisch auf GitHub Pages**:
**https://thestxve.github.io/spotMachineGHP/**

Die Spotify-Dateien werden **nicht hochgeladen**. Sie werden im Browser
gelesen und ausgewertet — zu keinem Zeitpunkt verlässt ein Byte das Gerät.
Es gibt kein Backend, keine Sessions, keine fremden Besucher, deren Daten man
erben könnte.

## Was der Nutzer tut

1. Seite öffnen
2. Dateien auswählen oder den entpackten Ordner in das Feld ziehen
   - `Streaming_History_Audio_2024.json` und Geschwister, oder
   - ein ZIP davon, oder
   - den ganzen Ordner `Spotify Extended Streaming History`
3. Auswerten. Nach einem Reload liegt der Datensatz im Browser-Cache
   (IndexedDB) und wird nicht erneut gelesen.

Last.fm-Sync funktioniert direkt aus dem Browser — die API erlaubt
Cross-Origin-Zugriffe. Der API-Key wird ausschließlich im Arbeitsspeicher
gehalten und nirgends gespeichert oder übertragen.

## Aufbau

```
index.html            aus templates/index.html erzeugt (Jinja -> statisch)
js/shim.js            ersetzt window.fetch: /api/... und /upload laufen lokal
js/api.js             bildet alle Flask-Routen aus app.py nach, gleiches JSON
js/lastfm.js          Last.fm-Client (CORS)
js/core/frame.js      columnares Frame als pandas-Ersatz (Typed Arrays)
js/core/parse.js      JSON/ZIP einlesen -> Spalten
js/core/store.js      Zustand + IndexedDB-Cache
js/core/format.js     Datumsformate, Python-Rundung (half to even)
js/core/pandas_helpers.js  groupby/agg/sort-Helfer
js/analytics/*.js     die 33 Analysefunktionen, portiert aus recommender_core.py
static/app.js         Frontend - identisch zur Flask-Version
```

`static/app.js` ist **dasselbe** wie in der EXE. Der Shim sorgt dafür, dass
beide Varianten ohne Änderung am Frontend auskommen.

## Warum Spalten und keine Objekte

Eine Spotify-Historie hat leicht 1.000.000 Streams. Als JS-Objekte wären das
rund 1 GB RAM und sekundenlange Garbage-Collection. Hier liegt jede Spalte in
einem Typed Array — die 16 080 Streams der Testdatei brauchen 0,7 MB
numerisch, der Import dauert ~200 ms.

## Parität zum Original

Der Port ist gegen pandas geprüft, nicht nur nach Augenschein:

| Prüfung | Umfang | Ergebnis |
|---|---|---|
| Analytics, 1 Jahr | 16 080 Zeilen, 35 Funktionsaufrufe | 35/35 identisch |
| Analytics, 3 Jahre | 37 752 Zeilen inkl. Video, 35 Aufrufe | 35/35 identisch |
| API-Routen gegen Flask | 41 Endpunkte inkl. Fehlerfälle | 41/41 identisch |
| Shim im Browsersimulator | Upload, Routen, Clear | bestanden |

Nachgebaut wurde dabei unter anderem: Pythons `round()` (half to even, nicht
`Math.round`), Monatsnamen im C-Locale, `pandas.sort_values` mit
numpy-Introsort (instabil — bei Gleichständen zählt die Reihenfolge) und
UTC-Zeitstempel.

## Tests

```bash
node ghp/tools/test_frame.mjs      # Regressionen der Gruppenbildung
node ghp/tools/verify.mjs    --ref ghp/tools/ref_2024.json  --file <json>
node ghp/tools/verify_api.mjs --ref ghp/tools/ref_api.json  --file <json>
node ghp/tools/test_shim.mjs --file <json>
```

Die Referenzwerte erzeugt der Python-Originalcode:

```bash
python ghp/tools/reference.py     ghp/tools/ref_multi.json <mehrere .json>
python ghp/tools/reference_api.py ghp/tools/ref_api.json   <eine .json>
```

Diese Referenzdateien enthalten echte Auswertungen eines Datensatzes und
werden **nicht** veröffentlicht — `deploy_ghp.py` arbeitet mit einer Allowlist.

## Neu veröffentlichen

```bash
python ghp/tools/build_site.py     # templates/index.html -> index.html, Assets kopieren
python ghp/tools/deploy_ghp.py     # bauen und nach spotMachineGHP pushen
```

`build_site.py` ist die einzige Stelle, an der die Flask-Vorlage in eine
statische Seite übersetzt wird. Frontend-Änderungen kommen also in
`static/app.js` und `templates/index.html` und gelten danach für EXE, Render
und GitHub Pages gleichermaßen.
