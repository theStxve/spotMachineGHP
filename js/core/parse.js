/**
 * parse.js - Dateien einlesen und in ein columnares Frame verwandeln.
 *
 * Ablauf pro Datei: JSON parsen -> in Spalten giessen -> Objekte freigeben.
 * Es wird bewusst NIE ein Array aus 1 Mio. JS-Objekten gebaut, das bleibt der
 * teuerste Teil. Am Ende bleibt nur RAM pro Spalte.
 *
 * Datenschutz: Felder wie ip_addr werden bewusst nicht uebernommen.
 */

import { Frame } from "./frame.js";
import { weekdayUTC } from "./format.js";
import { unzipSync } from "../vendor/fflate.js";

/** Parst ein Spotify-JSON und haengt die Zeilen an den Builder an. */
export function ingestRecords(builder, records) {
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    const track = r.master_metadata_track_name;
    const artist = r.master_metadata_album_artist_name;
    if (track === null || track === undefined || track === "") continue;
    if (artist === null || artist === undefined || artist === "") continue;

    const ts = Date.parse(r.ts);
    if (!Number.isFinite(ts)) continue;          // pandas: errors="coerce" + dropna

    const msPlayed = Number(r.ms_played);
    const safeMs = Number.isFinite(msPlayed) ? msPlayed : 0;

    const d = new Date(ts);
    // UTC-Felder (wie pandas mit utc=True) und lokale Felder parallel. Die
    // lokale Variante braucht der Nutzer fuer die Tagesverlaeufe: ein Stream
    // um 23:30 Berlin ist 21:30 UTC und gehoert lokal zum neuen Tag.
    const local = new Date(ts + tzOffsetMinutes(ts) * 60000);
    builder.ts.push(ts);
    builder.ms_played.push(safeMs);
    builder.minutes_played.push(safeMs / 60000);
    builder.track.push(track);
    builder.artist.push(artist);
    builder.album.push(r.master_metadata_album_album_name == null ? "" : r.master_metadata_album_album_name);
    builder.uri.push(r.spotify_track_uri == null ? null : r.spotify_track_uri);
    builder.skipped.push(r.skipped ? 1 : 0);
    builder.shuffle.push(r.shuffle ? 1 : 0);
    builder.offline.push(r.offline ? 1 : 0);
    builder.platform.push(r.platform == null ? "" : String(r.platform));
    builder.reason_end.push(r.reason_end == null ? "" : String(r.reason_end));
    builder.reason_start.push(r.reason_start == null ? "" : String(r.reason_start));
    builder.year.push(d.getUTCFullYear());
    builder.hour.push(d.getUTCHours());
    builder.weekday.push(weekdayUTC(ts));
    builder.month.push(d.getUTCMonth() + 1);
    builder.ym.push(d.getUTCFullYear() * 100 + d.getUTCMonth() + 1);
    builder.yearLocal.push(local.getUTCFullYear());
    builder.hourLocal.push(local.getUTCHours());
    builder.weekdayLocal.push(weekdayUTC(ts + tzOffsetMinutes(ts) * 60000));
    builder.monthLocal.push(local.getUTCMonth() + 1);
    builder.ymLocal.push(local.getUTCFullYear() * 100 + local.getUTCMonth() + 1);
    builder.dayLocal.push(Math.floor((ts + tzOffsetMinutes(ts) * 60000) / 86400000));
    builder.day.push(Math.floor(ts / 86400000));
  }
}

/**
 * Zeitzonenverschiebung in Minuten fuer einen Zeitpunkt (Ost +, West -).
 * Wird pro Zeitstempel einzeln bestimmt, weil die Regel ueber die
 * Sommerzeit hinweg springt.
 */
export function tzOffsetMinutes(ms) {
  return -new Date(ms).getTimezoneOffset();
}

export function createBuilder() {
  return {
    ts: [], ms_played: [], minutes_played: [],
    track: [], artist: [], album: [], uri: [],
    skipped: [], shuffle: [], offline: [],
    platform: [], reason_end: [], reason_start: [],
    year: [], hour: [], weekday: [], month: [], ym: [], day: [],
    yearLocal: [], hourLocal: [], weekdayLocal: [], monthLocal: [], ymLocal: [], dayLocal: [],
  };
}

/**
 * Baut aus dem Builder das finale Frame inkl. abgeleiteter Spalten
 * song_id, song_id_code, artist_code, album_code.
 */
export function finalizeFrame(builder) {
  const n = builder.ts.length;
  const song_id = new Array(n);
  const song_code = new Int32Array(n);
  const artist_code = new Int32Array(n);
  const album_code = new Int32Array(n);
  const artist_of = [];
  const album_of = [];
  const artistMap = new Map();
  const albumMap = new Map();

  const songMap = new Map();
  const songKeys = [];

  for (let i = 0; i < n; i++) {
    const artistName = builder.artist[i] == null ? "" : builder.artist[i];
    const trackName = builder.track[i] == null ? "" : builder.track[i];
    const albumName = builder.album[i] == null ? "" : builder.album[i];
    const key = artistName.toLowerCase().trim() + " — " + trackName.toLowerCase().trim();
    song_id[i] = key;
    let sc = songMap.get(key);
    if (sc === undefined) {
      sc = songKeys.length;
      songMap.set(key, sc);
      songKeys.push(key);
    }
    song_code[i] = sc;

    const aKey = artistName;
    let ac = artistMap.get(aKey);
    if (ac === undefined) {
      ac = artist_of.length;
      artistMap.set(aKey, ac);
      artist_of.push(aKey);
    }
    artist_code[i] = ac;

    const alc = albumMap.get(albumName);
    if (alc === undefined) {
      album_of.push(albumName);
      albumMap.set(albumName, album_of.length - 1);
    }
    album_code[i] = albumMap.get(albumName);
  }

  const cols = {
    ts: [Float64Array.from(builder.ts), "f"],
    ms_played: [Int32Array.from(builder.ms_played), "i"],
    minutes_played: [Float64Array.from(builder.minutes_played), "f"],
    track: [builder.track, "s"],
    artist: [builder.artist, "s"],
    album: [builder.album, "s"],
    uri: [builder.uri, "s"],
    skipped: [Uint8Array.from(builder.skipped), "b"],
    shuffle: [Uint8Array.from(builder.shuffle), "b"],
    offline: [Uint8Array.from(builder.offline), "b"],
    platform: [builder.platform, "s"],
    reason_end: [builder.reason_end, "s"],
    reason_start: [builder.reason_start, "s"],
    year: [Int16Array.from(builder.year), "i"],
    hour: [Uint8Array.from(builder.hour), "i"],
    weekday: [Uint8Array.from(builder.weekday), "i"],
    month: [Uint8Array.from(builder.month), "i"],
    ym: [Int32Array.from(builder.ym), "i"],
    day: [Int32Array.from(builder.day), "i"],
    // Lokale Zeitvariante. Nicht in den Auswertungen enthalten, solange der
    // Nutzer auf UTC steht - siehe Frame.withAliases().
    year_local: [Int16Array.from(builder.yearLocal), "i"],
    hour_local: [Uint8Array.from(builder.hourLocal), "i"],
    weekday_local: [Uint8Array.from(builder.weekdayLocal), "i"],
    month_local: [Uint8Array.from(builder.monthLocal), "i"],
    ym_local: [Int32Array.from(builder.ymLocal), "i"],
    day_local: [Int32Array.from(builder.dayLocal), "i"],
    song_id: [song_id, "s"],
    song_id_code: [song_code, "i"],
    artist_code: [artist_code, "i"],
    album_code: [album_code, "i"],
  };
  const frame = Frame.build(cols, n);
  frame.meta = { nSongs: songKeys.length, nArtists: artist_of.length, nAlbums: album_of.length };
  return frame;
}

/** Parst ein JSON-Array aus Text. Wirft bei kaputtem JSON. */
export function parseJsonArray(text) {
  const data = JSON.parse(text);
  return Array.isArray(data) ? data : [data];
}

/**
 * Zerlegt ein ZIP im Browser und liefert die Streaming-History-Dateien.
 * Nutzt unzipSync: die Callback-Variante ist in Web-Workern nicht nutzbar und
 * wuerde den Import blockieren.
 */
export async function extractZip(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const entries = unzipSync(buf);
  const out = [];
  for (const [name, data] of Object.entries(entries)) {
    if (name.endsWith("/")) continue;
    if (!/\.json$/i.test(name)) continue;
    if (!/Streaming_History/i.test(name)) continue;
    out.push({ name, bytes: data });
  }
  return out;
}

/** Dateinamen, die als Spotify-History durchgehen. */
export function isHistoryName(name) {
  return /Streaming_History_.*\.json$/i.test(name);
}
