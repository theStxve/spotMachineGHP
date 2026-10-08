/**
 * playlist.js - Port von recommender_core.py (Zeilen 1246-1523).
 *
 * Der Python-Code holt Kandidaten von Last.fm. Die Referenz laeuft ohne Key
 * (lastfmKey === null), d.h. das Ergebnis entsteht rein aus der Bibliothek -
 * der Last.fm-Zweig ist damit nicht pruefbar. Er ist hier als TODO-Stub
 * vorhanden: sobald ein Key gesetzt ist, liefern die Funktionen leere Listen,
 * es wird bewusst KEIN Netzwerkzugriff gemacht (kein Import von lastfm.js,
 * damit das Modul offline testbar bleibt).
 *
 * Sortierungen: Python list.sort() ist stabil, und Array.prototype.sort ist es
 * seit ES2019 ebenfalls - gleiche Sortierschluessel behalten ihre
 * Einfuegereihenfolge. Die Reihenfolge von lib_lookup (groupby sortiert nach
 * Track, dann Artist) entscheidet deshalb sichtbar ueber die Ausgabe.
 */

import { round1 } from "../core/format.js";

const SEP = "\u0000";

const asInt = (v) => Math.trunc(Number(v));

/** Python str(x or "") - None/NaN/leerer String werden zu "". */
function strOr(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "number" && Number.isNaN(v)) return "";
  if (v === "") return "";
  return String(v);
}

/** Python str(x).strip() */
const strTrim = (v) => strOr(v).trim();

/** Python pd.notna() */
function notna(v) {
  return v !== null && v !== undefined && !(typeof v === "number" && Number.isNaN(v));
}

/**
 * urllib.parse.quote(s) mit Default safe="/".
 * Weicht bewusst von encodeURIComponent ab: Python laesst "/" unangetastet
 * und encoded auch !*'(), JavaScript nicht.
 */
function pyQuote(s) {
  return encodeURIComponent(s)
    .replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())
    .replace(/%2F/g, "/");
}

const searchUrl = (artist, track) =>
  "https://open.spotify.com/search/" + pyQuote(artist + " " + track);

/**
 * Bibliotheks-Aggregate als Map (Schluessel: track.lower() + SEP + artist.lower())
 * plus die Werte in Einfuegereihenfolge. Ein doppelter Schluessel ueberschreibt
 * den Wert, BEHAEALT aber seine Position - so wie ein Python-dict.
 */
function buildLibrary(df) {
  const byKey = new Map();
  const values = [];
  if (!df || df.n === 0) return { byKey, values };

  const g = df.groupBy(["track", "artist"]);
  const playCount = g.count("ts");
  const skipCount = g.sum("skipped");
  const totalMin = g.sum("minutes_played");
  const spotifyUri = g.first("uri");
  const albumOf = g.first("album");
  const keys = g.keyArrays;

  const slotOf = new Map();
  for (let i = 0; i < g.size; i++) {
    const tName = strTrim(keys[i][0]);
    const aName = strTrim(keys[i][1]);
    if (!tName || !aName) continue;
    const pCnt = playCount[i];
    const sCnt = skipCount[i];
    const uri = spotifyUri[i];
    const value = {
      track: tName,
      artist: aName,
      album: strOr(albumOf[i]),
      play_count: pCnt,
      skip_rate: pCnt > 0 ? round1((sCnt / pCnt) * 100) : 0.0,
      total_min: round1(totalMin[i]),
      spotify_uri: notna(uri) ? String(uri) : null,
    };
    const key = tName.toLowerCase() + SEP + aName.toLowerCase();
    byKey.set(key, value);
    const slot = slotOf.get(key);
    if (slot === undefined) {
      slotOf.set(key, values.length);
      values.push(value);
    } else {
      values[slot] = value;
    }
  }
  return { byKey, values };
}

/** format_entry() aus dem Python-Code. */
function formatEntry(byKey, tName, aName, alb, defaultSource) {
  const tClean = strTrim(tName);
  const aClean = strTrim(aName);
  if (!tClean || !aClean) return null;
  const albumArg = alb || "";
  const lib = byKey.get(tClean.toLowerCase() + SEP + aClean.toLowerCase());
  if (!lib) {
    return {
      track: tClean,
      artist: aClean,
      album: albumArg || "",
      in_library: false,
      play_count: 0,
      skip_rate: null,
      source_label: defaultSource,
      spotify_url: searchUrl(aClean, tClean),
    };
  }
  const plays = lib.play_count;
  const spUri = lib.spotify_uri;
  return {
    track: lib.track,
    artist: lib.artist,
    album: albumArg || lib.album,
    in_library: true,
    play_count: plays,
    skip_rate: lib.skip_rate,
    source_label: defaultSource === "library"
      ? `Aus deiner Bibliothek (${plays}x gehört)`
      : `${defaultSource} · In Bibliothek (${plays}x)`,
    spotify_url: spUri && spUri.indexOf("spotify:track:") >= 0
      ? "https://open.spotify.com/track/" + spUri.split(":").pop()
      : searchUrl(aClean, tClean),
  };
}

// ── Last.fm-Stubs ───────────────────────────────────────────────────────────
// TODO: gegen lastfm.js verdrahten. Ohne echten HTTP-Aufruf; mit gesetztem
// lastfmKey liefern sie leere Listen und fuellen den Kandidaten-Pool nicht.

const lastfmGetSimilarTracks = () => [];
const lastfmGetArtistTopTracks = () => [];
const lastfmGetSimilarArtists = () => [];
const lastfmGetTagTopTracks = () => [];
const lastfmGetAlbumTopTracks = () => [];

// ── Sortierhilfen ───────────────────────────────────────────────────────────
// Python list.sort ist stabil, Array.prototype.sort seit ES2019 ebenfalls.

/** sort(key=(play_count, -skip_rate), reverse=True) */
const sortByPlaysThenSkipAsc = (xs) =>
  xs.sort((x, y) => (y.play_count - x.play_count) || (x.skip_rate - y.skip_rate));

/** sort(key=play_count, reverse=True) */
const sortByPlaysDesc = (xs) => xs.sort((x, y) => y.play_count - x.play_count);

/** Stabile Sortierung eines Index-Arrays nach einem Schluessel. */
function stableSortIdx(idx, records, keyFn, dir) {
  return idx
    .map((i, pos) => [i, pos])
    .sort((a, b) => {
      const d = dir * (keyFn(records[a[0]]) - keyFn(records[b[0]]));
      return d !== 0 ? d : a[1] - b[1];
    })
    .map((p) => p[0]);
}

/**
 * sort_values(by=["play_count","skip_rate"], ascending=[False, True]).
 * pandas nutzt np.lexsort: stabile Mehrfachsortierung, play_count ist der
 * Primaerschluessel, skip_rate der Sekundaerschluessel.
 */
function lexsortPlaySkip(records) {
  let idx = records.map((_, i) => i);
  idx = stableSortIdx(idx, records, (r) => r.skip_rate, 1);      // sekundaer zuerst
  idx = stableSortIdx(idx, records, (r) => r.play_count, -1);     // dann primaer
  return idx.map((i) => records[i]);
}

export function generate_playlist(df, options = {}) {
  const mode = options.mode;
  const query = options.query || "";
  const artistArg = options.artist || "";
  const albumArg = options.album || "";
  const yearArg = options.year || "";
  const genreArg = options.genre || "";
  const sourceMix = options.sourceMix || "both";
  const lastfmKey = options.lastfmKey || null;
  const limit = Math.max(5, Math.min(asInt(options.limit), 100));

  const { byKey, values: libValues } = buildLibrary(df);

  const rawCandidates = [];
  let title = "Deine Playlist";
  let desc = "Zusammengestellt nach deinen Kriterien";

  const tracksOfArtist = (artistName) => {
    const wanted = artistName.toLowerCase();
    return sortByPlaysThenSkipAsc(libValues.filter((v) => v.artist.toLowerCase() === wanted));
  };

  // ── MODE 1: SONG ──
  if (mode === "song") {
    const songName = strTrim(query);
    const artistName = strTrim(artistArg);
    title = `Mix basierend auf »${songName}«`;
    desc = `Ähnliche Songs & passende Favoriten zu ${songName} von ${artistName}`;

    const seed = formatEntry(byKey, songName, artistName, "", "Start-Song");
    if (seed) rawCandidates.push(seed);

    if (lastfmKey && artistName && songName) {
      for (const st of lastfmGetSimilarTracks(artistName, songName, lastfmKey, 35)) {
        const e = formatEntry(byKey, st.name, st.artist, "", "✨ Last.fm Ähnlich");
        if (e) rawCandidates.push(e);
      }
      for (const tt of lastfmGetArtistTopTracks(artistName, lastfmKey, 8)) {
        const e = formatEntry(byKey, tt.name, tt.artist, "", `🎤 Mehr von ${artistName}`);
        if (e) rawCandidates.push(e);
      }
    }

    if (artistName) {
      for (const sa of tracksOfArtist(artistName).slice(0, 10)) {
        const e = formatEntry(byKey, sa.track, sa.artist, sa.album, "library");
        if (e) rawCandidates.push(e);
      }
    }
  }

  // ── MODE 2: ARTIST ──
  else if (mode === "artist") {
    const artistName = strTrim(artistArg || query);
    title = `Artist-Radio: ${artistName}`;
    desc = `Die besten Songs von ${artistName} + handverlesene Entdeckungen aus derselben Szene`;

    if (artistName) {
      for (const sa of tracksOfArtist(artistName)) {
        const e = formatEntry(byKey, sa.track, sa.artist, sa.album, "library");
        if (e) rawCandidates.push(e);
      }
    }

    if (lastfmKey && artistName) {
      for (const tt of lastfmGetArtistTopTracks(artistName, lastfmKey, 20)) {
        const e = formatEntry(byKey, tt.name, tt.artist, "", `🎤 Top ${artistName}`);
        if (e) rawCandidates.push(e);
      }
      for (const sa of lastfmGetSimilarArtists(artistName, lastfmKey, 6)) {
        const saName = sa.name;
        for (const sat of lastfmGetArtistTopTracks(saName, lastfmKey, 3)) {
          const e = formatEntry(byKey, sat.name, sat.artist, "", `👥 Ähnlicher Artist (${saName})`);
          if (e) rawCandidates.push(e);
        }
      }
    }
  }

  // ── MODE 3: ALBUM ──
  else if (mode === "album") {
    const albumName = strTrim(albumArg || query);
    const artistName = strTrim(artistArg);
    title = `Album-Vibe: ${albumName}`;
    desc = `Tracks aus ${albumName} + thematisch passende Erweiterungen`;

    if (albumName) {
      const wanted = albumName.toLowerCase();
      const albMatches = sortByPlaysDesc(
        libValues.filter((v) => v.album.toLowerCase() === wanted)
      );
      for (const am of albMatches) {
        const e = formatEntry(byKey, am.track, am.artist, am.album, "💿 Aus dem Album");
        if (e) rawCandidates.push(e);
      }
    }

    if (lastfmKey && artistName && albumName) {
      const albT = lastfmGetAlbumTopTracks(artistName, albumName, lastfmKey, 25);
      for (const at of albT) {
        const e = formatEntry(byKey, at.name, at.artist, albumName, "💿 Album-Track");
        if (e) rawCandidates.push(e);
      }
      if (albT.length > 0) {
        for (const st of lastfmGetSimilarTracks(artistName, albT[0].name, lastfmKey, 15)) {
          const e = formatEntry(byKey, st.name, st.artist, "", "✨ Ähnlicher Vibe");
          if (e) rawCandidates.push(e);
        }
      }
    }
  }

  // ── MODE 4: YEAR ──
  else if (mode === "year") {
    const yVal = strTrim(strOr(yearArg || query || "2024"));
    title = `Zeitreise: Best of ${yVal}`;
    desc = `Deine meistgehörten Meilensteine und Entdeckungen aus dem Jahr ${yVal}`;

    const digits = /^[0-9]+$/.test(yVal);
    const ydf = df && df.n > 0 ? (digits ? df.eq("year", Number(yVal)) : df) : null;
    if (ydf && ydf.n > 0) {
      const yg = ydf.groupBy(["track", "artist"]);
      const yPlayCount = yg.count("ts");
      const ySkipCount = yg.sum("skipped");
      const yAlbum = yg.first("album");
      const yKeys = yg.keyArrays;
      const rows = [];
      for (let i = 0; i < yg.size; i++) {
        const pc = yPlayCount[i];
        rows.push({
          track: yKeys[i][0],
          artist: yKeys[i][1],
          play_count: pc,
          skip_rate: ySkipCount[i] / pc,
          album: yAlbum[i],
        });
      }
      for (const r of lexsortPlaySkip(rows).slice(0, 35)) {
        const e = formatEntry(byKey, r.track, r.artist, strOr(r.album), `📅 Dein Highlight ${yVal}`);
        if (e) rawCandidates.push(e);
      }

      // value_counts().head(3)
      const counts = new Map();
      for (const r of rows) counts.set(r.artist, (counts.get(r.artist) || 0) + 1);
      const topArts = Array.from(counts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([a]) => a);
      if (lastfmKey) {
        for (const ta of topArts) {
          for (const mt of lastfmGetArtistTopTracks(ta, lastfmKey, 4)) {
            const e = formatEntry(byKey, mt.name, mt.artist, "", `✨ ${ta} Highlight`);
            if (e) rawCandidates.push(e);
          }
        }
      }
    }
  }

  // ── MODE 5: GENRE / TAG ──
  else if (mode === "genre") {
    const tagName = strTrim(genreArg || query);
    title = `Genre-Mix: #${tagName}`;
    desc = `Frische Hits und vertraute Tracks im Style von ${tagName}`;

    if (lastfmKey && tagName) {
      for (const tt of lastfmGetTagTopTracks(tagName, lastfmKey, 40)) {
        const e = formatEntry(byKey, tt.name, tt.artist, "", `🏷️ #${tagName} Hit`);
        if (e) rawCandidates.push(e);
      }
    }

    const matchingArtists = new Set(rawCandidates.map((c) => c.artist.toLowerCase()));
    const libMatches = sortByPlaysDesc(
      libValues.filter((v) => matchingArtists.has(v.artist.toLowerCase()))
    );
    for (const lm of libMatches.slice(0, 15)) {
      const e = formatEntry(byKey, lm.track, lm.artist, lm.album, "library");
      if (e) rawCandidates.push(e);
    }
  }

  // Deduplizieren, Reihenfolge bleibt erhalten.
  const seen = new Set();
  const uniqueCandidates = [];
  for (const c of rawCandidates) {
    const key = c.track.toLowerCase().trim() + SEP + c.artist.toLowerCase().trim();
    if (!seen.has(key)) {
      seen.add(key);
      uniqueCandidates.push(c);
    }
  }

  const libPool = uniqueCandidates.filter((c) => c.in_library);
  const discPool = uniqueCandidates.filter((c) => !c.in_library);

  let finalTracks = [];
  if (sourceMix === "library") {
    finalTracks = libPool.slice(0, limit);
  } else if (sourceMix === "discover") {
    finalTracks = discPool.slice(0, limit);
  } else {
    let iLib = 0;
    let iDisc = 0;
    while (finalTracks.length < limit && (iLib < libPool.length || iDisc < discPool.length)) {
      if (iLib < libPool.length) finalTracks.push(libPool[iLib++]);
      if (finalTracks.length >= limit) break;
      if (iDisc < discPool.length) finalTracks.push(discPool[iDisc++]);
    }
  }

  if (finalTracks.length < limit) {
    // Python prueft `c not in final_tracks` per ==. Die Kandidaten stammen alle
    // aus unique_candidates, sind also dieselben Objekte - es entscheidet die
    // Identitaet, nicht der Feldvergleich.
    const used = new Set(finalTracks);
    const remaining = uniqueCandidates.filter((c) => !used.has(c));
    finalTracks = finalTracks.concat(remaining.slice(0, limit - finalTracks.length));
  }

  return {
    title,
    description: desc,
    mode,
    source_mix: sourceMix,
    total_tracks: finalTracks.length,
    tracks: finalTracks,
  };
}