/**
 * core.js - Port von recommender_core.py (Engagement-Score, Jahresprofil,
 * Recommender).
 *
 * Gegenueber dem Original gibt es drei Feinheiten:
 *  - Die Spalten heissen anders als in pandas (artist statt
 *    master_metadata_album_artist_name), weil parse.js sie so anlegt.
 *  - `compute_engagement` liefert direkt Records statt eines Frames; das
 *    spart das Umbauen, das Python mit .reset_index() macht.
 *  - Gruppierung laeuft ueber lokale Helfer statt ueber frame.groupBy(),
 *    weil dort ueber Zeilenpositionen statt Zeilenindizes aggregiert wird -
 *    bei Frame-Ansichten (df.eq("year", ...)) waere das falsch.
 */

import { round1, roundHalfEven } from "../core/format.js";
import { dedupeBy, headRecords, sumCol } from "../core/pandas_helpers.js";

const round4 = (v) => roundHalfEven(v, 4);

// ── Gruppierung (pandas groupby(sort=True) auf einer Spalte) ─────────────────

/**
 * Gruppiert nach einer Spalte und liefert die Schluessel alphabetisch
 * (pandas sort=True). Ohne Sonderzeichen ausserhalb BMP ist der normale
 * JS-Vergleich identisch zu Pythons Code-Point-Reihenfolge.
 */
function groupBySingle(frame, colName) {
  const d = frame.col(colName).data;
  const rows = frame.rows();
  const lookup = new Map();
  const keys = [];
  const raw = new Int32Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    const v = d[rows[i]];
    let c = lookup.get(v);
    if (c === undefined) {
      c = keys.length;
      lookup.set(v, c);
      keys.push(v);
    }
    raw[i] = c;
  }
  const order = keys.map((_, i) => i).sort((a, b) => {
    const av = keys[a];
    const bv = keys[b];
    if (av < bv) return -1;
    if (av > bv) return 1;
    return 0;
  });
  const remap = new Int32Array(keys.length);
  order.forEach((oldCode, newCode) => { remap[oldCode] = newCode; });
  const codes = new Int32Array(rows.length);
  for (let i = 0; i < rows.length; i++) codes[i] = remap[raw[i]];
  return { codes, rows, keys: order.map((i) => keys[i]), n: keys.length };
}

/** pandas "first": erster Wert, der nicht NaN ist. */
function aggFirst(frame, grp, colName) {
  const d = frame.col(colName).data;
  const out = new Array(grp.n).fill(null);
  const filled = new Uint8Array(grp.n);
  for (let i = 0; i < grp.rows.length; i++) {
    const g = grp.codes[i];
    if (filled[g]) continue;
    const v = d[grp.rows[i]];
    // parse.js bildet fehlende Werte auf "" ab, pandas springt dort NaN ueber.
    if (v === null || v === undefined || v === "") continue;
    out[g] = v;
    filled[g] = 1;
  }
  return out;
}

/** pandas "count": Anzahl nicht-null-Werte. */
function aggCount(frame, grp, colName) {
  const d = frame.col(colName).data;
  const out = new Int32Array(grp.n);
  for (let i = 0; i < grp.rows.length; i++) {
    const v = d[grp.rows[i]];
    if (v === null || v === undefined || Number.isNaN(v)) continue;
    out[grp.codes[i]]++;
  }
  return out;
}

function aggSum(frame, grp, colName) {
  const d = frame.col(colName).data;
  const out = new Float64Array(grp.n);
  for (let i = 0; i < grp.rows.length; i++) {
    const v = d[grp.rows[i]];
    if (v === null || v === undefined || Number.isNaN(v)) continue;
    out[grp.codes[i]] += v;
  }
  return out;
}

/** pandas .agg(lambda x: (x == value).sum()) */
function aggCountEq(frame, grp, colName, value) {
  const d = frame.col(colName).data;
  const out = new Int32Array(grp.n);
  for (let i = 0; i < grp.rows.length; i++) {
    if (d[grp.rows[i]] === value) out[grp.codes[i]]++;
  }
  return out;
}

/** numpy/pandas _norm(): Min-Max auf [0,1]. */
function norm(values) {
  let mn = Infinity;
  let mx = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  const n = values.length;
  const out = new Float64Array(n);
  if (mx === mn) {
    out.fill(0.5);
    return out;
  }
  const span = mx - mn;
  for (let i = 0; i < n; i++) out[i] = (values[i] - mn) / span;
  return out;
}

/** Division wie pandas: 0/0 -> NaN (JSON: null), nie Infinity. */
function div(a, b) {
  return b ? a / b : NaN;
}

// ── Engagement-Score ────────────────────────────────────────────────────────

/**
 * compute_engagement(df) aus recommender_core.py, direkt als Records.
 * Sortiert wie das Original: engagement_score absteigend, NaN ans Ende.
 */
export function computeEngagement(df) {
  const grp = groupBySingle(df, "song_id");
  const artist = aggFirst(df, grp, "artist");
  const track = aggFirst(df, grp, "track");
  const album = aggFirst(df, grp, "album");
  const uri = aggFirst(df, grp, "uri");
  const playCount = aggCount(df, grp, "ts");
  const minCount = aggCount(df, grp, "minutes_played");
  const totalMin = aggSum(df, grp, "minutes_played");
  const skipCount = aggSum(df, grp, "skipped");
  const trackdone = aggCountEq(df, grp, "reason_end", "trackdone");

  const n = grp.n;
  const skipRate = new Float64Array(n);
  const completion = new Float64Array(n);
  const logPlays = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    skipRate[i] = div(skipCount[i], playCount[i]);
    completion[i] = div(trackdone[i], playCount[i]);
    logPlays[i] = Math.log1p(playCount[i]);
  }

  const sPlays = norm(logPlays);
  const sMinutes = norm(totalMin);

  const recs = new Array(n);
  for (let i = 0; i < n; i++) {
    const score = 0.35 * sPlays[i] + 0.25 * sMinutes[i] +
      0.25 * completion[i] + 0.15 * (1 - skipRate[i]);
    recs[i] = {
      song_id: grp.keys[i],
      artist: artist[i],
      track: track[i],
      album: album[i],
      uri: uri[i],
      play_count: playCount[i],
      total_min: totalMin[i],
      avg_min: minCount[i] ? totalMin[i] / minCount[i] : NaN,
      skip_count: skipCount[i],
      trackdone: trackdone[i],
      skip_rate: skipRate[i],
      completion_rate: completion[i],
      s_plays: sPlays[i],
      s_minutes: sMinutes[i],
      s_completion: completion[i],
      s_skip: 1 - skipRate[i],
      engagement_score: round4(score),
    };
  }

  recs.sort((a, b) => {
    const av = a.engagement_score;
    const bv = b.engagement_score;
    const aNan = Number.isNaN(av);
    const bNan = Number.isNaN(bv);
    if (aNan || bNan) return aNan === bNan ? 0 : aNan ? 1 : -1;
    if (av === bv) return 0;
    return av > bv ? -1 : 1;
  });
  return recs;
}

/** compute_engagement(df).head(n).to_dict("records") */
export function compute_engagementHead(df, n) {
  return headRecords(computeEngagement(df), n);
}

// ── Jahresprofil ────────────────────────────────────────────────────────────

export function build_year_profile(df, year) {
  const y = Number(year);
  const ydf = df.eq("year", y);
  if (ydf.n === 0) throw new Error(`Keine Daten für Jahr ${y}.`);

  // top_artists: nach ms_played absteigend, bei Gleichstand in
  // Alphabet-Reihenfolge der Gruppen (= pandas nlargest auf sortierter GroupBy)
  const artGrp = groupBySingle(ydf, "artist");
  const artSum = aggSum(ydf, artGrp, "ms_played");
  const artistOrder = artGrp.keys.map((_, i) => i).sort((a, b) => {
    const av = artSum[a];
    const bv = artSum[b];
    if (av === bv) return a - b;
    if (Number.isNaN(av)) return 1;
    if (Number.isNaN(bv)) return -1;
    return av > bv ? -1 : 1;
  });
  const top_artists = artistOrder.slice(0, 30).map((i) => artGrp.keys[i]);

  // hour_distribution: auf 24 Stunden aufnormalisiert, fehlende = 0
  const hourGrp = groupBySingle(ydf, "hour");
  const hourSum = aggSum(ydf, hourGrp, "ms_played");
  const hourTotals = new Float64Array(24);
  let hourTotal = 0;
  for (let i = 0; i < hourGrp.n; i++) {
    const h = hourGrp.keys[i];
    hourTotals[h] = hourSum[i];
    hourTotal += hourSum[i];
  }
  const hour_distribution = {};
  for (let h = 0; h < 24; h++) hour_distribution[h] = div(hourTotals[h], hourTotal);

  const songGrp = groupBySingle(ydf, "song_id");

  return {
    year: y,
    top_artists,
    hour_distribution,
    total_songs: ydf.n,
    unique_tracks: songGrp.n,
    total_hours: round1(sumCol(ydf, "minutes_played") / 60),
  };
}

// ── Recommender ─────────────────────────────────────────────────────────────

const DIRECT_RATIO = 0.6;

export function recommend(df, year, topN = 20, minMinutes = 0.5, directRatio = DIRECT_RATIO) {
  const target = Number(year);
  const availableYears = get_available_years(df);
  if (!availableYears.includes(target)) {
    throw new Error(`Jahr ${target} nicht in den Daten. Verfügbar: [${availableYears.join(", ")}]`);
  }

  const profile = build_year_profile(df, target);

  // Direkte Treffer aus dem Zieljahr
  const direct = computeEngagement(df.eq("year", target))
    .filter((r) => r.total_min >= minMinutes);

  // Artist-Match aus den anderen Jahren
  const other = df.ne("year", target);
  let similar = [];
  if (other.n > 0 && profile.top_artists.length > 0) {
    const wanted = new Set(profile.top_artists);
    const artistDf = other.inSet("artist", wanted);
    if (artistDf.n > 0) {
      const taken = new Set(direct.map((r) => r.song_id));
      similar = computeEngagement(artistDf)
        .filter((r) => r.total_min >= minMinutes && !taken.has(r.song_id));
    }
  }

  const nDirect = Math.trunc(topN * directRatio);
  const nSimilar = topN - nDirect;
  const directPart = direct.slice(0, nDirect);
  const merged = dedupeBy(
    directPart.concat(similar.slice(0, nSimilar)),
    "song_id"
  );
  const result = headRecords(merged, topN);

  // Quelle folgt der Herkunft im concat, nicht der Position im Ergebnis.
  const recommendations = result.map((row, i) => ({
    rank: i + 1,
    track: row.track,
    artist: row.artist,
    album: row.album === null || row.album === undefined ? "" : row.album,
    play_count: row.play_count,
    total_minutes: round1(row.total_min),
    engagement_score: row.engagement_score,
    source: i < directPart.length ? "direct" : "artist_match",
    match_reason: i < directPart.length ? `In ${target} gehört` : "Selber Artist – anderes Jahr",
    spotify_url: trackUrl(row.uri),
  }));

  return { recommendations, profile };
}

function trackUrl(uri) {
  if (uri === null || uri === undefined) return null;
  const s = String(uri);
  if (!s.startsWith("spotify:track:")) return null;
  return "https://open.spotify.com/track/" + s.split(":").pop();
}

// ── kleine Auskunftshelfer ──────────────────────────────────────────────────

export function get_available_years(df) {
  const d = df.col("year").data;
  const r = df.rows();
  const seen = new Set();
  for (let i = 0; i < r.length; i++) {
    const v = d[r[i]];
    if (v === null || v === undefined || Number.isNaN(v)) continue;
    seen.add(Math.trunc(Number(v)));
  }
  return Array.from(seen).sort((a, b) => a - b);
}

export function get_all_artists(df) {
  const d = df.col("artist").data;
  const r = df.rows();
  const seen = new Set();
  for (let i = 0; i < r.length; i++) {
    const v = d[r[i]];
    if (v === null || v === undefined || v === "") continue;
    seen.add(v);
  }
  return Array.from(seen).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}