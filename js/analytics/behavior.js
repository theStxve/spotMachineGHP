/**
 * behavior.js - Port von recommender_core.py: Verhaltensanalyse
 * (get_deep_behavior_stats), letzter Stream, Last.fm-Sync, Fuzzy-Suche,
 * Song-/Album-Detail und Skip-Analytics.
 *
 * Wichtigste Paritaets-Fallen:
 *  - pandas sort_values() nutzt numpy-Introsort (instabil). Ueberall wo die
 *    Reihenfolge bei Gleichstaenden zaehlt, wird pandasArgsort() benutzt,
 *    nicht Array.sort(). Mehrspaltige sort_values() laeuft ueber
 *    lexsort_indexer(kind="stable") und ist damit stabil - dort genuegt ein
 *    stabiler JS-Sort in umgekehrter Spaltenreihenfolge.
 *  - GroupBy.first() ueberspringt NaN, frame.GroupTable.first() nicht.
 *  - value_counts() sortiert ueber sort_values(ascending=False), ist also
 *    quicksort-sortiert; der Quicksort entscheidet bei Gleichstaenden.
 */

import { createBuilder, finalizeFrame, ingestRecords } from "../core/parse.js";
import {
  fmtDate, fmtDateTimeSec, fmtISOStamp, fmtTime, fmtYearMonth,
  round1, roundHalfEven,
} from "../core/format.js";
import { sumCol, countDistinct } from "../core/pandas_helpers.js";
import { pandasArgsort, withColumn } from "./listening_helpers.js";

// ── interne Helfer ──────────────────────────────────────────────────────────

/**
 * pandas sort_values(col) auf einer Frame-Ansicht.
 * @returns {number[]} absolute Zeilenindizes in sortierter Reihenfolge
 */
function sortedRows(frame, colName, ascending) {
  const d = frame.col(colName).data;
  const rows = frame.rows();
  const vals = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) vals[i] = d[rows[i]];
  const order = pandasArgsort(vals, ascending);
  const out = new Array(order.length);
  for (let i = 0; i < order.length; i++) out[i] = rows[order[i]];
  return out;
}

/**
 * pandas Series.value_counts() - absteigend nach Haeufigkeit, optional
 * head(n). Reihenfolge bei Gleichstand: Quicksort ueber die Erstvorkommen-
 * Reihenfolge (pandas selbst haette die Hash-Tabellen-Reihenfolge).
 * @param {*} fillna  Wert, den pandas fillna() einsetzt (null = kein fillna)
 */
function valueCounts(frame, colName, headN = Infinity, fillna = null) {
  const d = frame.col(colName).data;
  const rows = frame.rows();
  const map = new Map();
  for (let i = 0; i < rows.length; i++) {
    let v = d[rows[i]];
    if (v === null || v === undefined || v === "") v = fillna;
    if (v === null || v === undefined) continue;
    map.set(v, (map.get(v) || 0) + 1);
  }
  const keys = Array.from(map.keys());
  const counts = keys.map((k) => map.get(k));
  const order = pandasArgsort(counts, false);
  const out = [];
  for (let i = 0; i < order.length && i < headN; i++) {
    out.push({ key: keys[order[i]], count: counts[order[i]] });
  }
  return out;
}

/**
 * pandas .agg(first=...) mit skipna=True: erster Wert der Gruppe, der nicht
 * NaN ist. Die Gruppierung kommt unveraendert aus frame.groupBy().
 */
function firstSkipna(frame, grp, colName) {
  const d = frame.col(colName).data;
  const out = new Array(grp.size).fill(null);
  const filled = new Uint8Array(grp.size);
  const rows = frame.rows();
  const codes = grp.codes;
  for (let i = 0; i < rows.length; i++) {
    const g = codes[i];
    if (g < 0 || filled[g]) continue;
    const v = d[rows[i]];
    if (v === null || v === undefined || v === "") continue;
    out[g] = v;
    filled[g] = 1;
  }
  return out;
}

/** pandas head(n) auf einem Indize-Array. */
function headIdx(order, n) {
  return order.length > n ? order.slice(0, n) : order;
}

/** Zaehlt die Streams je Tageszeit-Fenster (pandas ((hours>=a)&(hours<b)).sum()). */
function countHourWindow(frame, lo, hi) {
  const d = frame.col("hour").data;
  const rows = frame.rows();
  let n = 0;
  for (let i = 0; i < rows.length; i++) {
    const h = d[rows[i]];
    if (h >= lo && h < hi) n++;
  }
  return n;
}

/** Pandas-vergleichbarer Gleichheits-Test (NaN == NaN ist in pandas False). */
function sameNonNull(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  return a === b;
}

/** pandas Series.str.lower().str.strip() - NaN bleibt NaN. */
function lowerTrim(v) {
  return (v === null || v === undefined) ? null : String(v).toLowerCase().trim();
}

function trackUrl(uri) {
  if (uri === null || uri === undefined) return null;
  const s = String(uri);
  if (!s.startsWith("spotify:track:")) return null;
  return "https://open.spotify.com/track/" + s.split(":").pop();
}

// ── get_deep_behavior_stats ─────────────────────────────────────────────────

const REASON_END_MAP = {
  trackdone: "Komplett durchgehört",
  fwdbtn: "Weiter-Button (Skipped)",
  endplay: "App / Wiedergabe gestoppt",
  backbtn: "Zurück-Button",
  logout: "Spotify geschlossen / Logout",
  "unexpected-exit": "App abgestürzt / Beendet",
  unknown: "Sonstiges",
};

const REASON_START_MAP = {
  trackdone: "Automatisch nächster Song",
  clickrow: "Manuell in Playlist geklickt",
  fwdbtn: "Weiter geklickt",
  backbtn: "Zurück geklickt",
  playbtn: "Play gedrückt",
  appload: "Beim App-Start fortgesetzt",
  unknown: "Sonstiges",
};

export function get_deep_behavior_stats(df, year = null) {
  let view = df;
  if (year) view = df.eq("year", Number(year));
  if (view.n === 0) return {};

  const total_streams = view.n;
  const total_minutes = round1(sumCol(view, "minutes_played"));
  const total_hours = round1(total_minutes / 60.0);

  // 1. Shuffle vs Linear
  const shuffle_on = view.has("shuffle") ? sumCol(view, "shuffle") : 0;
  const shuffle_off = total_streams - shuffle_on;
  const shuffle_pct = total_streams ? round1((shuffle_on / total_streams) * 100) : 0.0;

  // 2. Offline vs Online
  const offline_plays = view.has("offline") ? sumCol(view, "offline") : 0;
  const offline_pct = total_streams ? round1((offline_plays / total_streams) * 100) : 0.0;

  // 3./4. Reason-Breakdowns
  const end_breakdown = view.has("reason_end")
    ? valueCounts(view, "reason_end", 6, "unknown").map((e) => ({
      label: REASON_END_MAP[e.key] !== undefined ? REASON_END_MAP[e.key] : e.key,
      count: e.count,
      pct: round1((e.count / total_streams) * 100),
    }))
    : [];

  const start_breakdown = view.has("reason_start")
    ? valueCounts(view, "reason_start", 6, "unknown").map((e) => ({
      label: REASON_START_MAP[e.key] !== undefined ? REASON_START_MAP[e.key] : e.key,
      count: e.count,
      pct: round1((e.count / total_streams) * 100),
    }))
    : [];

  // 5. Loop / Obsession Finder (direkt hintereinander wiederholte Streams)
  const sorted = view.take(sortedRows(view, "ts", true));
  const sRows = sorted.rows();
  const sTrack = sorted.col("track").data;
  const sArtist = sorted.col("artist").data;
  const repeatRows = [];
  for (let i = 1; i < sRows.length; i++) {
    const r = sRows[i];
    const p = sRows[i - 1];
    if (sameNonNull(sTrack[r], sTrack[p]) && sameNonNull(sArtist[r], sArtist[p])) repeatRows.push(r);
  }
  const top_loops = [];
  if (repeatRows.length) {
    const repeats = view.take(repeatRows);
    const grp = repeats.groupBy(["track", "artist"]);
    const loopCount = grp.count("ts");
    const loopMin = grp.sum("minutes_played");
    const keys = grp.keyArrays;
    const order = headIdx(pandasArgsort(loopCount, false), 10);
    for (const i of order) {
      top_loops.push({
        track: keys[i][0],
        artist: keys[i][1],
        loop_count: loopCount[i],
        loop_min: round1(loopMin[i]),
      });
    }
  }

  // 6. Night Owls vs Day Walkers
  const night = countHourWindow(view, 0, 6);
  const morning = countHourWindow(view, 6, 12);
  const day = countHourWindow(view, 12, 18);
  const evening = countHourWindow(view, 18, 24);
  const dayparts = [
    { name: "Nacht (00:00 - 06:00)", count: night, pct: round1((night / total_streams) * 100) },
    { name: "Morgen (06:00 - 12:00)", count: morning, pct: round1((morning / total_streams) * 100) },
    { name: "Nachmittag (12:00 - 18:00)", count: day, pct: round1((day / total_streams) * 100) },
    { name: "Abend (18:00 - 24:00)", count: evening, pct: round1((evening / total_streams) * 100) },
  ];

  return {
    total_streams,
    total_hours,
    shuffle: { on: shuffle_on, off: shuffle_off, pct: shuffle_pct },
    offline: { plays: offline_plays, pct: offline_pct },
    end_breakdown,
    start_breakdown,
    top_loops,
    dayparts,
  };
}

// ── get_latest_stream_info ───────────────────────────────────────────────────

export function get_latest_stream_info(df) {
  if (df.n === 0) {
    return { timestamp: null, epoch_sec: 0, track: null, artist: null };
  }
  const ts = df.col("ts").data;
  const order = sortedRows(df, "ts", true);
  const row = order[order.length - 1];
  const ms = ts[row];
  return {
    timestamp_iso: fmtISOStamp(ms),
    timestamp_formatted: fmtDateTimeSec(ms),
    epoch_sec: Math.floor(ms / 1000),
    track: String(df.at("track", row)),
    artist: String(df.at("artist", row)),
  };
}

// ── append_and_deduplicate_streams ──────────────────────────────────────────

/** Unix-Sekunden (Last.fm) -> ISO-Stempel; ISO-Eingaben bleiben unberuehrt. */
function normalizeTs(value) {
  let n;
  if (typeof value === "number") n = value;
  else if (typeof value === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(value)) n = Number(value);
  else return value;
  if (!Number.isFinite(n)) return value;
  const ms = Math.abs(n) < 1e11 ? Math.round(n * 1000) : Math.round(n);
  return fmtISOStamp(ms);
}

/** Frame -> Spotify-Rohdatensatz, damit parse.js das Frame neu bauen kann. */
function frameToRawRecords(frame, rows) {
  const c = (name) => frame.col(name).data;
  const ts = c("ts"), ms = c("ms_played"), track = c("track"), artist = c("artist");
  const album = c("album"), uri = c("uri"), skipped = c("skipped"), shuffle = c("shuffle");
  const offline = c("offline"), platform = c("platform"), rEnd = c("reason_end"), rStart = c("reason_start");
  const out = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    out[i] = {
      ts: fmtISOStamp(ts[r]),
      platform: platform[r],
      ms_played: ms[r],
      master_metadata_track_name: track[r],
      master_metadata_album_artist_name: artist[r],
      master_metadata_album_album_name: album[r],
      spotify_track_uri: uri[r],
      reason_start: rStart[r],
      reason_end: rEnd[r],
      shuffle: !!shuffle[r],
      skipped: !!skipped[r],
      offline: !!offline[r],
    };
  }
  return out;
}

function buildFrame(rawRecords) {
  const builder = createBuilder();
  ingestRecords(builder, rawRecords);
  return finalizeFrame(builder);
}

/**
 * Haengt Last.fm-Records an und garantiert:
 *  1. nur Tracks strikt nach dem bisherigen max(ts)
 *  2. keine Duplikate ueber (ts, song_id)
 * @returns {{df: Frame, addedCount: number}}
 */
export function appendAndDeduplicateStreams(df, records) {
  if (!records || records.length === 0) return { df, addedCount: 0 };

  const prepared = records.map((r) => {
    const copy = { ...r, ts: normalizeTs(r && r.ts) };
    return copy;
  });
  const newFrame = buildFrame(prepared);
  if (newFrame.n === 0) return { df, addedCount: 0 };

  // pandas: base_df["ts"].max() ist bei leerer Basis NaT -> Vergleich faellt
  // durch, es wird nichts angehaengt.
  if (df.n === 0) return { df, addedCount: 0 };

  const baseRows = df.rows();
  const baseTs = df.col("ts").data;
  const baseSid = df.col("song_id").data;
  const newTs = newFrame.col("ts").data;
  const newSid = newFrame.col("song_id").data;

  // drop_duplicates(["ts","song_id"], keep="first") laeuft ueber das GANZE
  // concat-Ergebnis - also fallen auch Duplikate innerhalb der Basis weg.
  let maxTs = -Infinity;
  const seen = new Set();
  const baseKeep = [];
  for (let i = 0; i < baseRows.length; i++) {
    const r = baseRows[i];
    if (baseTs[r] > maxTs) maxTs = baseTs[r];
    const k = baseTs[r] + " " + baseSid[r];
    if (seen.has(k)) continue;
    seen.add(k);
    baseKeep.push(r);
  }

  const keep = [];
  for (let i = 0; i < newFrame.n; i++) {
    if (!(newTs[i] > maxTs)) continue;
    const k = newTs[i] + " " + newSid[i];
    if (seen.has(k)) continue;
    seen.add(k);
    keep.push(i);
  }
  if (keep.length === 0) return { df, addedCount: 0 };

  // concat + sort_values("ts").reset_index(drop=True)
  const all = frameToRawRecords(df, baseKeep).concat(frameToRawRecords(newFrame, keep));
  const tsAll = new Float64Array(all.length);
  for (let i = 0; i < all.length; i++) tsAll[i] = Date.parse(all[i].ts);
  const order = pandasArgsort(tsAll, true);
  const merged = new Array(order.length);
  for (let i = 0; i < order.length; i++) merged[i] = all[order[i]];

  const combined = buildFrame(merged);
  return { df: combined, addedCount: combined.n - df.n };
}

// ── get_fuzzy_search ────────────────────────────────────────────────────────

/** Python str.split() auf Whitespace-Runs. */
function splitWords(s) {
  return s.split(/\s+/).filter((w) => w.length > 0);
}

export function get_fuzzy_search(df, query, topN = 25) {
  if (df.n === 0 || !query) return [];
  const q = String(query).toLowerCase().trim();

  const grp = df.groupBy(["song_id"]);
  const n = grp.size;
  const track = firstSkipna(df, grp, "track");
  const artist = firstSkipna(df, grp, "artist");
  const album = firstSkipna(df, grp, "album");
  const uri = firstSkipna(df, grp, "uri");
  const playCount = grp.count("ts");
  const totalMin = grp.sum("minutes_played");
  const skipCount = grp.sum("skipped");
  const firstPlayed = grp.min("ts");
  const lastPlayed = grp.max("ts");
  const songIds = grp.keyValues;

  const trackLower = new Array(n);
  const artistLower = new Array(n);
  for (let i = 0; i < n; i++) {
    trackLower[i] = lowerTrim(track[i]);
    artistLower[i] = lowerTrim(artist[i]);
  }

  const words = splitWords(q);
  const score = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = trackLower[i];
    const a = artistLower[i];
    let s = 0;
    if (t !== null) {
      if (q === t) s += 100;
      else if (t.startsWith(q)) s += 80;
      else if (t.includes(q)) s += 50;
    }
    if (a !== null) {
      if (q === a) s += 40;
      else if (a.startsWith(q)) s += 25;
      else if (a.includes(q)) s += 15;
    }
    for (const w of words) {
      if (w.length >= 3) {
        if (t !== null && t.includes(w)) s += 10;
        if (a !== null && a.includes(w)) s += 5;
      }
    }
    score[i] = s;
  }

  // stats[_score > 0].sort_values(["_score","play_count"], ascending=False)
  // -> lexsort_indexer(kind="stable"): play_count absteigend, dann _score
  //    absteigend, jeweils stabil.
  let order = [];
  for (let i = 0; i < n; i++) if (score[i] > 0) order.push(i);
  order.sort((a, b) => {
    const av = playCount[a], bv = playCount[b];
    return av === bv ? 0 : (av > bv ? -1 : 1);
  });
  order.sort((a, b) => {
    const av = score[a], bv = score[b];
    return av === bv ? 0 : (av > bv ? -1 : 1);
  });
  order = headIdx(order, topN);

  const out = [];
  for (const i of order) {
    const pc = playCount[i];
    const sc = skipCount[i];
    out.push({
      song_id: songIds[i],
      track: track[i],
      artist: artist[i],
      album: album[i],
      play_count: pc,
      total_min: round1(totalMin[i]),
      skip_count: sc,
      skip_rate: pc ? round1((sc / pc) * 100) : 0.0,
      first_played: fmtDate(firstPlayed[i]),
      last_played: fmtDate(lastPlayed[i]),
      spotify_url: trackUrl(uri[i]),
      match_score: score[i],
    });
  }
  return out;
}

// ── get_song_stats ──────────────────────────────────────────────────────────

/** Leitet eine Text-Spalte aus ts ab (pandas df["_ym"] = df["ts"].dt.strftime(...)). */
function withYearMonth(frame) {
  const n = frame.col("ts").data.length;
  const ts = frame.col("ts").data;
  const arr = new Array(n).fill("");
  const rows = frame.rows();
  for (let i = 0; i < rows.length; i++) arr[rows[i]] = fmtYearMonth(ts[rows[i]]);
  return withColumn(frame, "_ym", arr, "s");
}

/**
 * pandas Series.value_counts().to_dict() als JS-Objekt (Schluessel sortiert).
 */
function countsToDict(g) {
  const out = {};
  for (let i = 0; i < g.n; i++) out[String(g.keys[i])] = g.counts[i];
  return out;
}

/**
 * pandas groupby(key).size() - Anzahl Streams je Schluessel.
 * groupAgg() aus pandas_helpers kann kein "count" (es ruft
 * GroupTable.count() ohne Spaltennamen auf), deshalb direkt ueber die
 * GroupTable. ts ist nach preprocess nie null, size() und count("ts") sind
 * hier identisch.
 */
function groupCounts(frame, keyCols) {
  const grp = frame.groupBy(keyCols);
  return { n: grp.size, keys: grp.keyValues, counts: grp.count("ts") };
}

export function get_song_stats(df, trackName, artistName) {
  const qTrack = lowerTrim(trackName);
  const qArtist = lowerTrim(artistName);
  const tCol = df.col("track").data;
  const aCol = df.col("artist").data;
  const rows = df.rows();
  const hit = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (lowerTrim(tCol[r]) === qTrack && lowerTrim(aCol[r]) === qArtist) hit.push(r);
  }
  if (hit.length === 0) return {};
  const sdf = df.take(hit);

  const real_track = tCol[hit[0]];
  const real_artist = aCol[hit[0]];
  const real_album = sdf.has("album") ? sdf.col("album").data[hit[0]] : "";

  const byTs = sortedRows(sdf, "ts", true);
  const first_ts = sdf.col("ts").data[byTs[0]];
  const last_ts = sdf.col("ts").data[byTs[byTs.length - 1]];

  // pandas: sdf["spotify_track_uri"].dropna().iloc[0]
  let uri = null;
  if (sdf.has("uri")) {
    const uCol = sdf.col("uri").data;
    for (const r of hit) {
      if (uCol[r] !== null && uCol[r] !== undefined) { uri = uCol[r]; break; }
    }
  }

  const play_count = sdf.n;
  const total_min = round1(sumCol(sdf, "minutes_played"));
  const skip_count = Math.trunc(sumCol(sdf, "skipped"));
  const skip_rate = play_count ? round1((skip_count / play_count) * 100) : 0.0;

  let completion_rate = 0.0;
  if (sdf.has("reason_end")) {
    const rCol = sdf.col("reason_end").data;
    let done = 0;
    for (const r of hit) if (rCol[r] === "trackdone") done++;
    completion_rate = round1((done / play_count) * 100);
  }

  const yearG = groupCounts(sdf, ["year"]);
  const plays_by_year = countsToDict(yearG);
  const plays_by_month = countsToDict(groupCounts(withYearMonth(sdf), ["_ym"]));

  const platforms = {};
  if (sdf.has("platform")) {
    for (const e of valueCounts(sdf, "platform", 5)) platforms[String(e.key)] = e.count;
  }

  const dayparts = {
    "Nacht (00-06)": countHourWindow(sdf, 0, 6),
    "Morgen (06-12)": countHourWindow(sdf, 6, 12),
    "Nachmittag (12-18)": countHourWindow(sdf, 12, 18),
    "Abend (18-24)": countHourWindow(sdf, 18, 24),
  };

  // Consecutive repeat count ueber die ganze Historie
  const song_id_val = sdf.col("song_id").data[hit[0]];
  const sidCol = df.col("song_id").data;
  const order = sortedRows(df, "ts", true);
  let consecutive_repeats = 0;
  for (let i = 1; i < order.length; i++) {
    if (sameNonNull(sidCol[order[i]], song_id_val) && sameNonNull(sidCol[order[i - 1]], song_id_val)) {
      consecutive_repeats++;
    }
  }

  return {
    track: real_track,
    artist: real_artist,
    album: real_album,
    spotify_url: trackUrl(uri),
    play_count,
    total_min,
    total_hours: roundHalfEven(total_min / 60, 2),
    skip_count,
    skip_rate,
    completion_rate,
    consecutive_repeats,
    first_played: fmtDate(first_ts) + " " + fmtTime(first_ts),
    last_played: fmtDate(last_ts) + " " + fmtTime(last_ts),
    plays_by_year,
    plays_by_month,
    dayparts,
    platforms,
  };
}

// ── get_album_detail ────────────────────────────────────────────────────────

export function get_album_detail(df, albumName, artistName) {
  const qAlbum = lowerTrim(albumName);
  const qArtist = lowerTrim(artistName);
  const alCol = df.col("album").data;
  const aCol = df.col("artist").data;
  const rows = df.rows();
  const hit = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (lowerTrim(alCol[r]) === qAlbum && lowerTrim(aCol[r]) === qArtist) hit.push(r);
  }
  if (hit.length === 0) return {};
  const adf = df.take(hit);

  const byTs = sortedRows(adf, "ts", true);
  const first_dt = adf.col("ts").data[byTs[0]];
  const last_dt = adf.col("ts").data[byTs[byTs.length - 1]];

  const play_count = adf.n;
  const total_min = round1(sumCol(adf, "minutes_played"));
  const unique_tracks = countDistinct(adf, "track");
  const skip_count = Math.trunc(sumCol(adf, "skipped"));
  const skip_rate = play_count ? round1((skip_count / play_count) * 100) : 0.0;

  const tGrp = adf.groupBy(["track"]);
  const tCount = tGrp.count("ts");
  const tMin = tGrp.sum("minutes_played");
  const tSkip = tGrp.sum("skipped");
  const order = pandasArgsort(tCount, false);
  const tracks = order.map((i) => ({
    track: tGrp.keyValues[i],
    play_count: tCount[i],
    total_min: round1(tMin[i]),
    skip_count: tSkip[i],
    skip_rate: round1((tSkip[i] / tCount[i]) * 100),
  }));

  const plays_by_year = countsToDict(groupCounts(adf, ["year"]));
  const plays_by_month = countsToDict(groupCounts(withYearMonth(adf), ["_ym"]));

  return {
    album: alCol[hit[0]],
    artist: aCol[hit[0]],
    play_count,
    total_min,
    unique_tracks,
    skip_count,
    skip_rate,
    first_played: fmtDate(first_dt),
    last_played: fmtDate(last_dt),
    plays_by_year,
    plays_by_month,
    tracks,
  };
}

// ── get_skip_analytics ──────────────────────────────────────────────────────

export function get_skip_analytics(df, year = "all", minPlays = 3) {
  if (df.n === 0) return {};
  let fdf = df;
  if (year && year !== "all") fdf = fdf.eq("year", Number(year));
  if (fdf.n === 0) return {};

  const total_streams = fdf.n;
  const total_skips = Math.trunc(sumCol(fdf, "skipped"));
  const overall_skip_rate = total_streams ? round1((total_skips / total_streams) * 100) : 0;

  // Per-song stats
  const songGrp = fdf.groupBy(["song_id"]);
  const sg_n = songGrp.size;
  const sTrack = firstSkipna(fdf, songGrp, "track");
  const sArtist = firstSkipna(fdf, songGrp, "artist");
  const sPlay = songGrp.count("ts");
  const sSkip = songGrp.sum("skipped");

  const kept = [];
  const rate = [];
  for (let i = 0; i < sg_n; i++) {
    if (sPlay[i] < minPlays) continue;
    kept.push(i);
    rate.push(sSkip[i] / sPlay[i]);
  }

  let worst_song = null;
  let best_song = null;
  if (kept.length) {
    const desc = pandasArgsort(rate, false)[0];
    const asc = pandasArgsort(rate, true)[0];
    worst_song = {
      track: sTrack[kept[desc]],
      artist: sArtist[kept[desc]],
      skip_rate: round1(rate[desc] * 100),
    };
    best_song = {
      track: sTrack[kept[asc]],
      artist: sArtist[kept[asc]],
      skip_rate: round1(rate[asc] * 100),
    };
  }

  // Skip-Rate-Verteilung (Buckets 0-10%, ... 90-100%)
  const buckets = new Array(10).fill(0);
  for (const r of rate) {
    const idx = Math.min(Math.floor(r * 10), 9);
    buckets[idx] += 1;
  }
  const dist_labels = [];
  for (let i = 0; i < 10; i++) dist_labels.push(`${i * 10}–${(i + 1) * 10}%`);

  // Skip-Rate je Stunde
  const hourGrp = fdf.groupBy(["hour"]);
  const hTotal = hourGrp.count("ts");
  const hSkips = hourGrp.sum("skipped");
  const skip_by_hour = new Array(24).fill(0.0);
  for (let i = 0; i < hourGrp.size; i++) {
    skip_by_hour[Number(hourGrp.keyValues[i])] = round1((hSkips[i] / hTotal[i]) * 100);
  }

  // Top-Skip-Artists (mind. 10 Streams)
  const artistGrp = fdf.groupBy(["artist"]);
  const aPlays = artistGrp.count("ts");
  const aSkips = artistGrp.sum("skipped");
  const aIdx = [];
  const aRate = [];
  for (let i = 0; i < artistGrp.size; i++) {
    if (aPlays[i] < 10) continue;
    aIdx.push(i);
    aRate.push(aSkips[i] / aPlays[i]);
  }
  const top_skip_artists = headIdx(pandasArgsort(aRate, false), 8).map((k) => ({
    artist: artistGrp.keyValues[aIdx[k]],
    skip_rate: round1(aRate[k] * 100),
    plays: aPlays[aIdx[k]],
  }));

  // Skip-Rate je Jahr (Trend)
  const yearGrp = fdf.groupBy(["year"]);
  const yPlays = yearGrp.count("ts");
  const ySkips = yearGrp.sum("skipped");
  const skip_by_year_labels = [];
  const skip_by_year_values = [];
  for (let i = 0; i < yearGrp.size; i++) {
    skip_by_year_labels.push(yearGrp.keyValues[i]);
    skip_by_year_values.push(round1((ySkips[i] / yPlays[i]) * 100));
  }

  return {
    total_streams,
    total_skips,
    overall_skip_rate,
    worst_song,
    best_song,
    skip_dist_labels: dist_labels,
    skip_dist_values: buckets,
    skip_by_hour,
    top_skip_artists,
    skip_by_year_labels,
    skip_by_year_values,
  };
}
