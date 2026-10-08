/**
 * sessions2.js - Port von recommender_core.py (Zeilen 1123-1244).
 *
 * get_session_stats_v2: Eine Session beginnt, wenn zwischen zwei Streams
 * (nach ts sortiert) mehr als 30 Minuten liegen. pandas haengt danach eine
 * laufende session_id an und gruppiert darueber. Hier wird dieselbe
 * Gruppierung in einem linearen Durchlauf erzeugt - die Reihenfolge der
 * Gruppen ist damit exakt die Sortierreihenfolge, die auch pandas' first()
 * (start_ts/start_hour/start_weekday) sieht.
 *
 * get_monthly_stats_v2: Monatsgruppen ueber die Spalte "month". Der Top-Song
 * braucht pandas' quicksort-Reihenfolge aus sort_values("count",
 * ascending=False) - bei Gleichstaenden entscheidet die Introsort-Permutation,
 * nicht die Stabilitaet von Array.sort(). Deshalb pandasArgsort().
 */

import { pandasArgsort } from "./listening_helpers.js";
import { round1, weekdayUTC, dayNumber, MONTH_SHORT } from "../core/format.js";

const WD_LABELS = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
const SESSION_GAP_MS = 30 * 60 * 1000;

const asInt = (v) => Math.trunc(Number(v));

/** pandas Series.mode().iloc[0]: haeufigster Wert, bei Gleichstand der kleinste. */
function modeSmallestNum(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  let best = 0;
  let bestCount = -1;
  for (const [v, c] of counts) {
    if (c > bestCount || (c === bestCount && v < best)) {
      best = v;
      bestCount = c;
    }
  }
  return best;
}

/** strftime("%d.%m.%Y %H:%M") aus einem Epoch-ms-Zeitstempel (UTC). */
function fmtStampShort(ms) {
  const d = new Date(ms);
  const p2 = (n) => (n < 10 ? "0" + n : String(n));
  return p2(d.getUTCDate()) + "." + p2(d.getUTCMonth() + 1) + "." + d.getUTCFullYear() +
    " " + p2(d.getUTCHours()) + ":" + p2(d.getUTCMinutes());
}

export function get_session_stats_v2(df, year) {
  if (year) df = df.eq("year", asInt(year));
  if (df.n === 0) return {};

  const tsData = df.col("ts").data;
  const minData = df.col("minutes_played").data;
  const hourData = df.col("hour").data;
  const rows = Array.from(df.rows());
  const order = pandasArgsort(Array.from(rows, (r) => tsData[r]), true);

  const durations = [];
  const startHours = [];
  const startWeekdays = [];
  const startTs = [];
  const tracks = [];

  let prevTs = null;
  for (const k of order) {
    const row = rows[k];
    const ts = tsData[row];
    if (prevTs === null || ts - prevTs > SESSION_GAP_MS) {
      durations.push(minData[row]);
      startHours.push(hourData[row]);
      startWeekdays.push(weekdayUTC(ts));
      startTs.push(ts);
      tracks.push(1);
    } else {
      durations[durations.length - 1] += minData[row];
      tracks[tracks.length - 1] += 1;
    }
    prevTs = ts;
  }

  let totalTracks = 0;
  for (let i = 0; i < tracks.length; i++) totalTracks += tracks[i];

  const n = durations.length;
  let sumDur = 0;
  let maxDur = durations[0];
  let maxIdx = 0;
  for (let i = 0; i < n; i++) {
    sumDur += durations[i];
    if (durations[i] > maxDur) { maxDur = durations[i]; maxIdx = i; }
  }

  const hist = { "<5min": 0, "5-15min": 0, "15-30min": 0, "30-60min": 0, ">1h": 0 };
  const wdCounts = new Array(7).fill(0);
  const wdSum = new Float64Array(7);
  const hourCounts = new Array(24).fill(0);
  for (let i = 0; i < n; i++) {
    const d = durations[i];
    if (d < 5) hist["<5min"] += 1;
    else if (d < 15) hist["5-15min"] += 1;
    else if (d < 30) hist["15-30min"] += 1;
    else if (d < 60) hist["30-60min"] += 1;
    else hist[">1h"] += 1;

    const wd = startWeekdays[i];
    wdCounts[wd] += 1;
    wdSum[wd] += d;
    hourCounts[startHours[i]] += 1;
  }

  const wdAvgDur = [];
  for (let i = 0; i < 7; i++) {
    wdAvgDur.push(wdCounts[i] > 0 ? round1(wdSum[i] / wdCounts[i]) : 0.0);
  }

  // Listening-Streak: eindeutige UTC-Tage, aufsteigend.
  const daySet = new Set();
  for (let i = 0; i < rows.length; i++) daySet.add(dayNumber(tsData[rows[i]]));
  const dates = Array.from(daySet).sort((a, b) => a - b);

  let maxStreak = 0;
  let curStreak = 1;
  for (let i = 1; i < dates.length; i++) {
    if (dates[i] - dates[i - 1] === 1) {
      curStreak += 1;
      if (curStreak > maxStreak) maxStreak = curStreak;
    } else {
      curStreak = 1;
    }
  }
  if (dates.length > 0 && curStreak > maxStreak) maxStreak = curStreak;

  return {
    avg_session_min: sumDur / n,
    longest_session_min: maxDur,
    longest_session_start: fmtStampShort(startTs[maxIdx]),
    avg_tracks_per_session: totalTracks / n,
    total_sessions: n,
    peak_session_hour: modeSmallestNum(startHours),
    max_streak_days: maxStreak,
    total_days: dates.length,
    session_length_histogram: hist,
    weekday_labels: WD_LABELS,
    weekday_counts: wdCounts,
    weekday_avg_dur: wdAvgDur,
    sessions_by_hour: hourCounts,
  };
}

export function get_monthly_stats_v2(df, year) {
  if (year) df = df.eq("year", asInt(year));
  if (df.n === 0) return {};

  const months = [];
  const minutes = [];
  const streams = [];
  const uniqueTracks = [];
  const uniqueArtists = [];
  const skipRates = [];
  const topSongs = [];

  const mg = df.groupBy("month");
  const codes = mg.codes;
  const mrows = mg.rows;
  const buckets = Array.from({ length: mg.size }, () => []);
  for (let i = 0; i < mrows.length; i++) {
    const g = codes[i];
    if (g < 0) continue;
    buckets[g].push(mrows[i]);
  }

  const minSum = mg.sum("minutes_played");
  const playCount = mg.count("ts");
  const trackNu = mg.nunique("track");
  const artistNu = mg.nunique("artist");
  const skipSum = mg.sum("skipped");

  for (let g = 0; g < mg.size; g++) {
    const mNum = asInt(mg.keyValues[g]);
    const plays = playCount[g];
    months.push(MONTH_SHORT[mNum - 1]);
    minutes.push(round1(minSum[g]));
    streams.push(plays);
    uniqueTracks.push(trackNu[g]);
    uniqueArtists.push(artistNu[g]);
    skipRates.push(plays > 0 ? round1((skipSum[g] / plays) * 100) : 0.0);

    // Top-Song: groupby(song_id) + sort_values("count", ascending=False)
    const sg = df.take(buckets[g]).groupBy("song_id");
    if (sg.size === 0) {
      topSongs.push(null);
      continue;
    }
    const counts = sg.count("ts");
    const bestTrack = sg.first("track");
    const bestArtist = sg.first("artist");
    const best = pandasArgsort(counts, false)[0];
    topSongs.push({
      track: bestTrack[best],
      artist: bestArtist[best],
      count: counts[best],
    });
  }

  return {
    months,
    minutes,
    streams,
    unique_tracks: uniqueTracks,
    unique_artists: uniqueArtists,
    skip_rates: skipRates,
    top_songs: topSongs,
  };
}