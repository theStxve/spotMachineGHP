/**
 * topsongs.js - die meistgehörten Songs als reine Liste.
 *
 * Der Tab "Empfehlungen" mischt Songs des Zieljahres mit Treffern anderer
 * Jahre. Das ist eine Empfehlung, keine Bestenliste. Hier steht genau das,
 * wonach man zuerst greift: was habe ich am häufigsten gehört.
 *
 * Sortiert wird immer zweistufig: erst der gewählte Wert, dann song_id.
 * pandas sort_values ist instabil - bei Gleichständen würde die Reihenfolge
 * zwischen zwei Läufen springen. Die Liste soll stabil bleiben.
 */

import { computeEngagement } from "./core.js";
import { round1, roundHalfEven } from "../core/format.js";
import { sumCol } from "../core/pandas_helpers.js";

/** Sortiermodi: Feld und Richtung. Reihenfolge hier ist die Prüfliste. */
const MODES = {
  plays: ["play_count", false],
  minutes: ["total_min", false],
  engagement: ["engagement_score", false],
  avg: ["avg_min", false],
  skip: ["skip_rate", false],
  completion: ["completion_rate", false],
  artist: ["artist", true],
  track: ["track", true],
};

const compareStrings = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function get_top_songs(df, year = null, sort = "plays", limit = 50) {
  const scope = (year === null || year === undefined || year === "all")
    ? df
    : df.eq("year", Number(year));

  if (!scope.n) {
    return {
      year: year ? Number(year) : null,
      sort,
      total_songs: 0,
      total_streams: 0,
      total_hours: 0.0,
      songs: [],
    };
  }

  const recs = computeEngagement(scope);
  const [field, ascending] = MODES[sort] || MODES.plays;

  // Zweitstufig sortieren: Primärschlüssel, dann song_id als Stichprobe.
  recs.sort((a, b) => {
    let av = a[field];
    let bv = b[field];
    if (typeof av === "string" || typeof bv === "string") {
      const c = compareStrings(String(av), String(bv));
      if (c) return ascending ? c : -c;
    } else {
      const aNan = Number.isNaN(av);
      const bNan = Number.isNaN(bv);
      if (aNan || bNan) {
        if (aNan !== bNan) return aNan ? 1 : -1;
      } else if (av !== bv) {
        return ascending ? (av < bv ? -1 : 1) : (av > bv ? -1 : 1);
      }
    }
    return compareStrings(String(a.song_id), String(b.song_id));
  });

  const take = Number(limit) > 0 ? Number(limit) : recs.length;
  const top = recs.slice(0, take);

  const songs = top.map((r, i) => ({
    rank: i + 1,
    track: r.track,
    artist: r.artist,
    album: r.album || "",
    play_count: r.play_count,
    total_minutes: round1(r.total_min),
    avg_minutes: roundHalfEven(r.avg_min, 2),
    skip_rate: r.skip_rate,
    completion_rate: r.completion_rate,
    engagement_score: r.engagement_score,
    spotify_url: typeof r.uri === "string" && r.uri.startsWith("spotify:track:")
      ? `https://open.spotify.com/track/${r.uri.split(":").pop()}`
      : null,
  }));

  const totalMinutes = sumCol(scope, "minutes_played");
  return {
    year: year ? Number(year) : null,
    sort,
    total_songs: recs.length,
    total_streams: scope.n,
    total_hours: round1(totalMinutes / 60.0),
    songs,
  };
}
