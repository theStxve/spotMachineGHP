/**
 * listening.js - Port von recommender_core.py (Zeilen 238-680).
 *
 * Alle Zeitstempel sind UTC (parse.js liefert ts als Epoch-ms). Wo pandas
 * `sort_values(...)` schreibt, wird ueber pandasArgsort()/sortRecordsLexDesc()
 * sortiert - siehe listening_helpers.js, warum das nicht Array.sort() sein darf.
 */

import { build_year_profile, compute_engagementHead, computeEngagement } from "./core.js";
import {
  pandasArgsort, sortRecordsUnstableDesc, sortRecordsStableDesc, sortRecordsLexDesc,
  groupByCols, totalOf, nuniqueOf, modeSmallest, withColumn, colValues, compareStrings,
} from "./listening_helpers.js";
import {
  round1, fmtDate, fmtTime, fmtYearMonth, fmtISODate, dayNumber,
  MONTH_SHORT, MONTH_LONG,
} from "../core/format.js";

const DAYS_FULL = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"];

const asInt = (v) => Math.trunc(Number(v));

const pad2 = (n) => (n < 10 ? "0" + n : String(n));

// ── 238-299 ────────────────────────────────────────────────────────────────

export function get_heatmap_data(df, year) {
  if (year) df = df.eq("year", asInt(year));

  const g = groupByCols(df, ["weekday", "hour"]);
  const minutes = g.sum("minutes_played");
  const streams = g.count("ts");

  const matrix = [];
  const streamsMatrix = [];
  for (let i = 0; i < 7; i++) {
    matrix.push(new Array(24).fill(0));
    streamsMatrix.push(new Array(24).fill(0));
  }
  let maxVal = 0.0;
  let peakWeekday = 0;
  let peakHour = 0;

  for (let i = 0; i < g.size; i++) {
    const wd = asInt(g.keyArrays[i][0]);
    const hr = asInt(g.keyArrays[i][1]);
    const val = round1(minutes[i]);
    matrix[wd][hr] = val;
    streamsMatrix[wd][hr] = streams[i];
    if (val > maxVal) {
      maxVal = val;
      peakWeekday = wd;
      peakHour = hr;
    }
  }

  // reindex(range(24), fill_value=0)
  const hourlyMinutes = new Array(24).fill(0);
  const hourlyStreams = new Array(24).fill(0);
  const hg = groupByCols(df, "hour");
  const hSum = hg.sum("minutes_played");
  const hCount = hg.count("ts");
  for (let i = 0; i < hg.size; i++) {
    const h = asInt(hg.keyValues[i]);
    if (h >= 0 && h < 24) {
      hourlyMinutes[h] = round1(hSum[i]);
      hourlyStreams[h] = hCount[i];
    }
  }

  const dailyMinutes = new Array(7).fill(0);
  const dailyStreams = new Array(7).fill(0);
  const dg = groupByCols(df, "weekday");
  const dSum = dg.sum("minutes_played");
  const dCount = dg.count("ts");
  for (let i = 0; i < dg.size; i++) {
    const d = asInt(dg.keyValues[i]);
    if (d >= 0 && d < 7) {
      dailyMinutes[d] = round1(dSum[i]);
      dailyStreams[d] = dCount[i];
    }
  }

  const peakDayName = peakWeekday >= 0 && peakWeekday < 7 ? DAYS_FULL[peakWeekday] : "";
  const nextHour = (peakHour + 1) % 24;
  const totalHours = round1(totalOf(df, "minutes_played") / 60.0);

  return {
    matrix,
    streams_matrix: streamsMatrix,
    max_value: maxVal,
    days: ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"],
    days_full: DAYS_FULL,
    hourly_labels: Array.from({ length: 24 }, (_, h) => pad2(h) + ":00"),
    hourly_minutes: hourlyMinutes,
    hourly_streams: hourlyStreams,
    daily_minutes: dailyMinutes,
    daily_streams: dailyStreams,
    total_hours: totalHours,
    total_streams: df.n,
    peak_slot: {
      day: peakDayName,
      weekday: peakWeekday,
      hour: peakHour,
      time_label: pad2(peakHour) + ":00 - " + pad2(nextHour) + ":00 Uhr",
      minutes: round1(maxVal),
    },
  };
}

// ── 301-314 ────────────────────────────────────────────────────────────────

export function get_skip_analysis(df, year, minPlays, topN) {
  if (year) df = df.eq("year", asInt(year));

  const g = groupByCols(df, "song_id");
  const track = g.first("track");
  const artist = g.first("artist");
  const playCount = g.count("ts");
  const skipCount = g.sum("skipped");
  const totalMin = g.sum("minutes_played");

  const recs = [];
  for (let i = 0; i < g.size; i++) {
    if (playCount[i] < minPlays) continue;
    const pc = playCount[i];
    const tm = totalMin[i];
    recs.push({
      song_id: g.keyValues[i],
      track: track[i],
      artist: artist[i],
      play_count: pc,
      skip_count: skipCount[i],
      total_min: tm,
      skip_rate: skipCount[i] / pc,
      avg_ms_played: (tm * 60000) / pc,
    });
  }
  return sortRecordsUnstableDesc(recs, "skip_rate", topN);
}

// ── 316-366 ────────────────────────────────────────────────────────────────

/** ydf.groupby("artist")["ms_played"].sum().nlargest(n).index.tolist() */
function topArtistsByMs(ydf, n) {
  const g = groupByCols(ydf, "artist");
  const ms = g.sum("ms_played");
  const idx = new Array(g.size);
  for (let i = 0; i < idx.length; i++) idx[i] = i;
  // pandas nlargest ist eine stabile Sortierung absteigend
  idx.sort((a, b) => (ms[a] < ms[b] ? 1 : ms[a] > ms[b] ? -1 : a - b));
  const out = [];
  for (let i = 0; i < Math.min(n, idx.length); i++) out.push(g.keyValues[idx[i]]);
  return out;
}

export function get_discover_tracks(df, year, topN) {
  // year === null/"": Gesamtansicht ueber alle Jahre (Spiegel von
  // recommender_core._discover_all_years).
  if (year === null || year === undefined || year === "") return discoverAllYears(df, topN);
  const y = asInt(year);
  const ydf = df.eq("year", y);

  const prior = df.lt("year", y);
  const priorArtists = new Set(colValues(prior, "artist").filter((v) => v !== null && v !== undefined));

  // 1. Neue Artists, die es vor diesem Jahr nie gab
  const yg = groupByCols(ydf, "artist");
  const yPlay = yg.count("ts");
  const yMin = yg.sum("minutes_played");
  const fresh = [];
  for (let i = 0; i < yg.size; i++) {
    const name = yg.keyValues[i];
    if (priorArtists.has(name)) continue;
    fresh.push({ artist: name, play_count: yPlay[i], total_min: round1(yMin[i]) });
  }
  const newArtists = sortRecordsUnstableDesc(fresh, "play_count", 15);

  // 2. Tracks der Top-Artists, die im Jahr fehlen
  const topArtists = topArtistsByMs(ydf, 30);
  const topSet = new Set(topArtists);
  let odf = df.ne("year", y);
  odf = odf.inSet("artist", topSet);
  const yearSongs = new Set(colValues(ydf, "song_id"));
  odf = odf.notInSet("song_id", yearSongs);
  const missedTracks = odf.n === 0 ? [] : compute_engagementHead(odf, topN);

  // 3. Forgotten Gems
  const subsequent = df.gt("year", y);
  const subsequentSongs = new Set(colValues(subsequent, "song_id"));
  const past = df.le("year", y);
  const pg = groupByCols(past, "song_id");
  const pTrack = pg.first("track");
  const pArtist = pg.first("artist");
  const pPlay = pg.count("ts");
  const pMin = pg.sum("minutes_played");
  const pastRecs = [];
  for (let i = 0; i < pg.size; i++) {
    if (pPlay[i] < 10) continue;
    if (subsequentSongs.has(pg.keyValues[i])) continue;
    pastRecs.push({
      song_id: pg.keyValues[i],
      track: pTrack[i],
      artist: pArtist[i],
      play_count: pPlay[i],
      total_min: round1(pMin[i]),
    });
  }
  const forgottenGems = sortRecordsUnstableDesc(pastRecs, "play_count", 15);

  return {
    year: y,
    total_artists: nuniqueOf(ydf, "artist"),
    new_artists_count: newArtists.length,
    missed_tracks: missedTracks,
    new_discovered_artists: newArtists,
    forgotten_gems: forgottenGems,
  };
}

// ── year=all: Gesamtansicht ueber alle Jahre ─────────────────────────────────

/** Sortiert Engagement-Score absteigend (NaN ans Ende), Gleichstand nach song_id. */
function compareDiscoverEngagement(a, b) {
  const aNan = Number.isNaN(a.engagement_score);
  const bNan = Number.isNaN(b.engagement_score);
  if (aNan || bNan) {
    if (aNan && bNan) return compareStrings(a.song_id, b.song_id);
    return aNan ? 1 : -1;
  }
  if (a.engagement_score !== b.engagement_score) return b.engagement_score - a.engagement_score;
  return compareStrings(a.song_id, b.song_id);
}

/**
 * year=null: Gesamtansicht ueber alle Jahre. Regeln wie
 * recommender_core._discover_all_years - Kommentare dort sind massgeblich.
 */
function discoverAllYears(df, topN) {
  const artistCol = df.col("artist").data;
  const yearCol = df.col("year").data;
  const songCol = df.col("song_id").data;
  const tsCol = df.col("ts").data;
  const minCol = df.col("minutes_played").data;

  const yg = df.groupBy("year");
  const years = [];
  for (let i = 0; i < yg.size; i++) {
    const y = Number(yg.keyValues[i]);
    if (Number.isFinite(y)) years.push(y);
  }
  years.sort((a, b) => a - b);
  if (!df.n || !years.length) {
    return {
      year: "all", total_artists: 0, new_artists_count: 0,
      missed_tracks: [], new_discovered_artists: [], forgotten_gems: [],
    };
  }
  const maxYear = years[years.length - 1];
  const rows = df.rows();

  // 1. Erst-Entdeckungen: Jahr der ersten Wiedergabe je Artist
  const firstYear = new Map();
  for (const r of rows) {
    const a = artistCol[r];
    if (a === null || a === undefined) continue;
    const y = yearCol[r];
    if (!Number.isFinite(y)) continue;
    const cur = firstYear.get(a);
    if (cur === undefined || y < cur) firstYear.set(a, y);
  }
  const agg = new Map();
  for (const r of rows) {
    const a = artistCol[r];
    const y = yearCol[r];
    if (!Number.isFinite(y) || firstYear.get(a) !== y) continue;
    let s = agg.get(a);
    if (!s) { s = { year: y, play_count: 0, total_min: 0 }; agg.set(a, s); }
    const t = tsCol[r];
    if (t !== null && t !== undefined && !Number.isNaN(t)) s.play_count++;
    const m = minCol[r];
    if (Number.isFinite(m)) s.total_min += m;
  }
  const fresh = [];
  for (const [name, s] of agg) {
    fresh.push({ artist: name, year: s.year, play_count: s.play_count, total_min: round1(s.total_min) });
  }
  fresh.sort((a, b) => (b.play_count - a.play_count) || compareStrings(a.artist, b.artist));
  const newArtists = fresh.slice(0, 15);

  // 2. Verpasste Perlen ueber alle Jahre: Vereinigung der Einzeljahre
  const candidates = new Set();
  for (const y of years) {
    const ydf = df.eq("year", y);
    if (ydf.n === 0) continue;
    const topSet = new Set(topArtistsByMs(ydf, 30));
    if (!topSet.size) continue;
    const yearSongs = new Set(colValues(ydf, "song_id"));
    const sub = df.inSet("artist", topSet).notInSet("song_id", yearSongs);
    for (const id of colValues(sub, "song_id")) {
      if (id !== null && id !== undefined) candidates.add(id);
    }
  }
  let missed = [];
  if (candidates.size) {
    const eng = computeEngagement(df.inSet("song_id", candidates));
    eng.sort(compareDiscoverEngagement);
    missed = eng.slice(0, topN);
  }

  // 3. Vergessene Perlen: >= 10 Plays und vor dem juesten Jahr gestoppt
  const lastYear = new Map();
  for (const r of rows) {
    const id = songCol[r];
    const y = yearCol[r];
    if (id === null || id === undefined || !Number.isFinite(y)) continue;
    const cur = lastYear.get(id);
    if (cur === undefined || y > cur) lastYear.set(id, y);
  }
  const g = groupByCols(df, "song_id");
  const gTrack = g.first("track");
  const gArtist = g.first("artist");
  const gPlay = g.count("ts");
  const gMin = g.sum("minutes_played");
  const gems = [];
  for (let i = 0; i < g.size; i++) {
    if (gPlay[i] < 10) continue;
    const last = lastYear.get(g.keyValues[i]);
    if (years.length > 1 && !(last < maxYear)) continue;
    gems.push({
      song_id: g.keyValues[i], track: gTrack[i], artist: gArtist[i],
      play_count: gPlay[i], total_min: round1(gMin[i]),
    });
  }
  gems.sort((a, b) => (b.play_count - a.play_count) || compareStrings(a.song_id, b.song_id));
  const forgotten = gems.slice(0, 15);

  return {
    year: "all",
    total_artists: nuniqueOf(df, "artist"),
    new_artists_count: newArtists.length,
    missed_tracks: missed,
    new_discovered_artists: newArtists,
    forgotten_gems: forgotten,
  };
}

// ── 368-405 ────────────────────────────────────────────────────────────────

export function get_compare_data(df, year1, year2) {
  const prof1 = build_year_profile(df, year1);
  const prof2 = build_year_profile(df, year2);
  const y1 = prof1.top_artists;
  const y2 = prof2.top_artists;

  const in2 = new Set(y2);
  const in1 = new Set(y1);
  const newArtists = y2.filter((a) => !in1.has(a));
  const droppedArtists = y1.filter((a) => !in2.has(a));

  const side = (yr, prof) => ({
    year: yr,
    top_songs: compute_engagementHead(df.eq("year", asInt(yr)), 10),
    top_artists: prof.top_artists.slice(0, 10),
    stats: {
      total_hours: prof.total_hours,
      unique_tracks: prof.unique_tracks,
      total_streams: prof.total_songs,
    },
  });

  const out = {};
  out[String(year1)] = side(year1, prof1);
  out[String(year2)] = side(year2, prof2);
  // Python liefert diese beiden Listen aus einem Set, dessen Reihenfolge sich
  // bei jedem Prozessstart aendert (String-Hash-Randomisierung). Fuer eine
  // stabile Anzeige im Browser sortieren wir sie.
  out.new_artists = Array.from(newArtists).sort(compareStrings);
  out.dropped_artists = Array.from(droppedArtists).sort(compareStrings);
  return out;
}

// ── 407-461 ────────────────────────────────────────────────────────────────

export function get_artist_data(df, artistName) {
  const wanted = String(artistName).toLowerCase();
  const artists = df.col("artist").data;
  const adf = df.filter((row) => String(artists[row]).toLowerCase() === wanted);
  if (adf.n === 0) return {};

  const tsData = adf.col("ts").data;
  const trackData = adf.col("track").data;
  const albumData = adf.col("album").data;

  const rows = Array.from(adf.rows());
  rows.sort((a, b) => tsData[a] - tsData[b]);
  const firstRow = rows[0];
  const lastRow = rows[rows.length - 1];

  const totalMinutes = round1(totalOf(adf, "minutes_played"));

  const yg = groupByCols(adf, "year");
  const yearCounts = yg.count("ts");
  const playsByYear = {};
  for (let i = 0; i < yg.size; i++) playsByYear[asInt(yg.keyValues[i])] = yearCounts[i];

  const ymCol = new Array(adf.cols.ts.data.length);
  for (const r of rows) ymCol[r] = fmtYearMonth(tsData[r]);
  const mgp = groupByCols(withColumn(adf, "year_month", ymCol, "s"), "year_month");
  const monthCounts = mgp.count("ts");
  const playsByMonth = {};
  for (let i = 0; i < mgp.size; i++) playsByMonth[mgp.keyValues[i]] = monthCounts[i];

  return {
    artist: artists[rows[0]],
    first_heard: fmtDate(tsData[firstRow]),
    first_heard_time: fmtTime(tsData[firstRow]),
    first_track: String(trackData[firstRow]),
    first_album: String(albumData[firstRow]),
    last_heard: fmtDate(tsData[lastRow]),
    last_heard_time: fmtTime(tsData[lastRow]),
    last_track: String(trackData[lastRow]),
    last_album: String(albumData[lastRow]),
    total_plays: adf.n,
    total_minutes: totalMinutes,
    total_hours: round1(totalMinutes / 60.0),
    plays_by_year: playsByYear,
    plays_by_month: playsByMonth,
    top_songs: compute_engagementHead(adf, 15),
    top_albums: topAlbums(adf),
  };
}

function topAlbums(adf) {
  const g = groupByCols(adf, "album");
  const playCount = g.count("ts");
  const minutes = g.sum("minutes_played");
  const recs = [];
  for (let i = 0; i < g.size; i++) {
    recs.push({ album: g.keyValues[i], play_count: playCount[i], minutes: round1(minutes[i]) });
  }
  return sortRecordsUnstableDesc(recs, "play_count", 5);
}

// ── 467-482 ────────────────────────────────────────────────────────────────

export function get_monthly_stats(df, year) {
  if (year) df = df.eq("year", asInt(year));
  if (df.n === 0) return {};

  const g = groupByCols(df, "month");
  const minutes = g.sum("minutes_played");
  const tracks = g.nunique("song_id");
  const streams = g.count("ts");

  const out = { months: [], minutes: [], tracks: [], streams: [] };
  for (let i = 0; i < g.size; i++) {
    out.months.push(MONTH_SHORT[asInt(g.keyValues[i]) - 1]);
    out.minutes.push(minutes[i]);
    out.tracks.push(tracks[i]);
    out.streams.push(streams[i]);
  }
  return out;
}

// ── 485-520 ────────────────────────────────────────────────────────────────

export function get_session_stats(df, year) {
  if (year) df = df.eq("year", asInt(year));
  if (df.n === 0) return {};

  const tsData = df.col("ts").data;
  const rows = Array.from(df.rows());
  // pandas sort_values("ts") - Introsort, damit Gleiche nicht umsortiert werden
  const order = pandasArgsort(Array.from(rows, (r) => tsData[r]), true);

  const minData = df.col("minutes_played").data;
  const hourData = df.col("hour").data;

  const durations = [];
  const trackCounts = [];
  const startHours = [];
  let prevTs = null;
  for (const k of order) {
    const row = rows[k];
    const ts = tsData[row];
    const isNew = prevTs === null || ts - prevTs > 30 * 60 * 1000;
    if (isNew) {
      durations.push(minData[row]);
      trackCounts.push(1);
      startHours.push(hourData[row]);
    } else {
      durations[durations.length - 1] += minData[row];
      trackCounts[trackCounts.length - 1] += 1;
    }
    prevTs = ts;
  }

  const n = durations.length;
  let sumDur = 0;
  for (let i = 0; i < n; i++) sumDur += durations[i];
  let maxDur = durations[0];
  for (let i = 1; i < n; i++) if (durations[i] > maxDur) maxDur = durations[i];
  const avgTracks = trackCounts.reduce((a, b) => a + b, 0) / n;

  const hist = { "<5min": 0, "5-15min": 0, "15-30min": 0, "30-60min": 0, ">1h": 0 };
  for (let i = 0; i < n; i++) {
    const d = durations[i];
    if (d < 5) hist["<5min"] += 1;
    else if (d < 15) hist["5-15min"] += 1;
    else if (d < 30) hist["15-30min"] += 1;
    else if (d < 60) hist["30-60min"] += 1;
    else hist[">1h"] += 1;
  }

  return {
    avg_session_min: sumDur / n,
    longest_session_min: maxDur,
    avg_tracks_per_session: avgTracks,
    total_sessions: n,
    peak_session_hour: asInt(modeSmallest(startHours)),
    session_length_histogram: hist,
  };
}

// ── 522-553 ────────────────────────────────────────────────────────────────

function normPlatform(p) {
  // Reihenfolge ist wichtig: spezifische Muster vor den Oberbegriffen,
  // sonst schluckt "android" die Tablets.
  const s = String(p).toLowerCase();
  // PlayStation liefert Geraete-IDs statt Namen, z.B.
  // "Partner SCEI sony_tv;ps4;9b18101888dd42948afd0b8792122bec;;tpapi"
  if (/playstation|ps3|ps4|ps5/.test(s)) return "PlayStation";
  if (s.indexOf("android") >= 0) return s.indexOf("tablet") >= 0 ? "Android Tablet" : "Android";
  if (s.indexOf("ios") >= 0) return "iOS";
  if (s.indexOf("web") >= 0) return "Web Player";
  if (s.indexOf("mac") >= 0 || s.indexOf("osx") >= 0) return "Mac";
  if (s.indexOf("windows") >= 0) return "Windows";
  if (s.indexOf("linux") >= 0) return "Linux";
  if (/smart speaker|sonos|amazon|alexa/.test(s)) return "Sonos / Lautsprecher";
  if (s.indexOf("chromecast") >= 0 || s.indexOf("tv") >= 0) return "TV / Cast";
  if (!s || s === "nan") return "Unbekannt";
  return "Other";
}

export function get_platform_stats(df, year) {
  if (year) df = df.eq("year", asInt(year));
  if (!df.has("platform")) return { platforms: [] };

  const platData = df.col("platform").data;
  const normCol = new Array(platData.length);
  for (let i = 0; i < platData.length; i++) normCol[i] = normPlatform(platData[i]);
  const pf = withColumn(df, "plat_norm", normCol, "s");

  const g = groupByCols(pf, "plat_norm");
  const minutes = g.sum("minutes_played");
  const streams = g.count("ts");
  let totalMin = 0;
  for (let i = 0; i < g.size; i++) totalMin += minutes[i];
  if (totalMin === 0) totalMin = 1;

  const platforms = [];
  for (let i = 0; i < g.size; i++) {
    platforms.push({
      name: g.keyValues[i],
      minutes: minutes[i],
      streams: streams[i],
      pct: (minutes[i] / totalMin) * 100,
    });
  }
  return { platforms: sortRecordsStableDesc(platforms, "minutes", platforms.length) };
}

// ── 555-571 ────────────────────────────────────────────────────────────────

export function get_album_stats(df, year, topN) {
  if (year) df = df.eq("year", asInt(year));
  if (df.n === 0) return [];

  const g = groupByCols(df, ["album", "artist"]);
  const playCount = g.count("ts");
  const totalMinutes = g.sum("minutes_played");
  const uniqueTracks = g.nunique("song_id");

  const recs = [];
  for (let i = 0; i < g.size; i++) {
    recs.push({
      album: g.keyArrays[i][0],
      artist: g.keyArrays[i][1],
      play_count: playCount[i],
      total_minutes: totalMinutes[i],
      unique_tracks: uniqueTracks[i],
      engagement_score: playCount[i] * 0.5 + totalMinutes[i] * 0.5,
    });
  }
  return sortRecordsUnstableDesc(recs, "engagement_score", topN);
}

// ── 573-600 ────────────────────────────────────────────────────────────────

export function get_discovery_timeline(df) {
  if (df.n === 0) return [];

  const tsData = df.col("ts").data;
  const artistData = df.col("artist").data;
  const trackData = df.col("track").data;
  const albumData = df.col("album").data;
  const rows = Array.from(df.rows());
  const order = pandasArgsort(Array.from(rows, (r) => tsData[r]), true);

  // groupby(artist).first() auf dem nach ts sortierten Frame
  const firstRowOf = new Map();
  for (const k of order) {
    const row = rows[k];
    const name = artistData[row];
    if (!firstRowOf.has(name)) firstRowOf.set(name, row);
  }

  const g = groupByCols(df, "artist");
  const plays = g.count("ts");
  const mins = g.sum("minutes_played");

  // merged entsteht per pd.merge(first_rows, ...) - die Reihenfolge von
  // first_rows (groupby, also Artist aufsteigend) bleibt erhalten.
  const results = [];
  for (let i = 0; i < g.size; i++) {
    const name = g.keyValues[i];
    const row = firstRowOf.get(name);
    if (row === undefined) continue;
    const ts = tsData[row];
    results.push({
      artist: name,
      first_track: trackData[row],
      first_album: albumData[row],
      first_heard: fmtDate(ts),
      first_heard_time: fmtTime(ts),
      raw_date: fmtISODate(ts),
      year: new Date(ts).getUTCFullYear(),
      total_plays_ever: plays[i],
      total_min_ever: round1(mins[i]),
    });
  }

  // Python list.sort(reverse=True): stabil, Gleiches bleibt in Reihenfolge
  return results.map((r, i) => [r, i]).sort((a, b) => {
    if (a[0].raw_date < b[0].raw_date) return 1;
    if (a[0].raw_date > b[0].raw_date) return -1;
    return a[1] - b[1];
  }).map((p) => p[0]);
}

// ── 602-636 ────────────────────────────────────────────────────────────────

export function get_streak_stats(df) {
  if (df.n === 0) return {};

  const tsData = df.col("ts").data;
  const rows = df.rows();
  const seen = new Set();
  for (let i = 0; i < rows.length; i++) seen.add(dayNumber(tsData[rows[i]]));
  const dates = Array.from(seen).sort((a, b) => a - b);
  if (!dates.length) return {};

  let currentS = 1;
  for (let i = 1; i < dates.length; i++) {
    if (dates[i] - dates[i - 1] === 1) currentS += 1;
    else currentS = 1;
  }
  let longest = 0;
  let run = 1;
  for (let i = 1; i < dates.length; i++) {
    if (dates[i] - dates[i - 1] === 1) run += 1;
    else { if (run > longest) longest = run; run = 1; }
  }
  if (run > longest) longest = run;

  const today = dayNumber(Date.now());
  const activeStreak = today - dates[dates.length - 1] <= 1 ? currentS : 0;

  // value_counts().idxmax() - bei Gleichstand der frueheste Zeitraum
  const monthCount = new Map();
  const yearCount = new Map();
  const monthData = df.col("ym").data;
  const yearData = df.col("year").data;
  for (let i = 0; i < rows.length; i++) {
    const ym = monthData[rows[i]];
    monthCount.set(ym, (monthCount.get(ym) || 0) + 1);
    const y = yearData[rows[i]];
    yearCount.set(y, (yearCount.get(y) || 0) + 1);
  }
  let bestMonth = "";
  let bestCount = 0;
  for (const ym of Array.from(monthCount.keys()).sort((a, b) => a - b)) {
    if (monthCount.get(ym) > bestCount) { bestCount = monthCount.get(ym); bestMonth = ym; }
  }
  let mostActiveYear = 0;
  let yearBest = 0;
  for (const y of Array.from(yearCount.keys()).sort((a, b) => a - b)) {
    if (yearCount.get(y) > yearBest) { yearBest = yearCount.get(y); mostActiveYear = y; }
  }

  return {
    longest_streak: longest,
    current_streak: activeStreak,
    total_active_days: dates.length,
    best_month: bestMonth
      ? MONTH_LONG[(bestMonth % 100) - 1] + " " + Math.floor(bestMonth / 100)
      : "",
    most_active_year: mostActiveYear,
  };
}

// ── 638-680 ────────────────────────────────────────────────────────────────

export function get_heatmap_cell_songs(df, weekday, hour, year, topN) {
  if (year) df = df.eq("year", asInt(year));
  const wd = asInt(weekday);
  const hr = asInt(hour);
  const cell = df.filter((row) => df.col("weekday").data[row] === wd && df.col("hour").data[row] === hr);

  if (cell.n === 0) {
    return { total_streams: 0, total_minutes: 0.0, top_songs: [], top_artists: [] };
  }

  const totalMinutes = round1(totalOf(cell, "minutes_played"));

  const sg = groupByCols(cell, ["track", "artist"]);
  const songRecs = [];
  const sPlay = sg.count("ts");
  const sMin = sg.sum("minutes_played");
  for (let i = 0; i < sg.size; i++) {
    songRecs.push({
      track: sg.keyArrays[i][0],
      artist: sg.keyArrays[i][1],
      play_count: sPlay[i],
      minutes: round1(sMin[i]),
    });
  }
  const topSongs = sortRecordsLexDesc(songRecs, ["play_count", "minutes"], topN);

  const ag = groupByCols(cell, "artist");
  const artistRecs = [];
  const aPlay = ag.count("ts");
  const aMin = ag.sum("minutes_played");
  for (let i = 0; i < ag.size; i++) {
    artistRecs.push({
      artist: ag.keyValues[i],
      play_count: aPlay[i],
      minutes: round1(aMin[i]),
    });
  }
  const topArtists = sortRecordsLexDesc(artistRecs, ["play_count", "minutes"], 5);

  const dayName = wd >= 0 && wd < 7 ? DAYS_FULL[wd] : "";
  const nextHour = (hr + 1) % 24;

  return {
    weekday: wd,
    day_name: dayName,
    hour: hr,
    time_label: pad2(hr) + ":00 - " + pad2(nextHour) + ":00 Uhr",
    total_streams: cell.n,
    total_minutes: totalMinutes,
    top_songs: topSongs,
    top_artists: topArtists,
  };
}