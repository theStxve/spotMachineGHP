/**
 * api.js - lokale Umsetzung aller Flask-Routen aus app.py.
 *
 * Ziel: static/app.js bleibt unveraendert und bekommt exakt die JSON-Strukturen,
 * die es vom Python-Server bekam. Dadurch funktioniert dasselbe Frontend
 * hinter dem Flask-Server (EXE/Render) und hier im Browser.
 */

import {
  getFrame, getMeta, hasData, clearFrame, saveCache, loadCache, peekCache, clearCache,
  loadFiles, setIncludeOutliers, getQuality, getSettings, setSettings, applyTimeMode,
  setOnlyMusic, getMedia, setArtistBlacklist, getBlacklist, setYears, getYearScope,
  setYearsExcluded, getYearExclusion, appendStreams,
  getAccountData, getAccountStatus,
} from "./core/store.js";
import {
  analyzeSearches, analyzeInferences, analyzeLibrary, analyzePlaylists, analyzePayments,
  analyzeFollow, analyzeMarquee, analyzeWrapped, analyzePurchases,
} from "./analytics/account.js";
import { get_available_years, get_all_artists, recommend } from "./analytics/core.js";
import { get_top_songs } from "./analytics/topsongs.js";
import {
  get_heatmap_data, get_skip_analysis, get_discover_tracks, get_compare_data,
  get_artist_data, get_monthly_stats, get_session_stats, get_platform_stats,
  get_album_stats, get_discovery_timeline, get_streak_stats, get_heatmap_cell_songs,
} from "./analytics/listening.js";
import {
  get_deep_behavior_stats, get_latest_stream_info, appendAndDeduplicateStreams,
  get_fuzzy_search, get_song_stats, get_album_detail, get_skip_analytics,
} from "./analytics/behavior.js";
import { get_session_stats_v2, get_monthly_stats_v2 } from "./analytics/sessions2.js";
import { generate_playlist } from "./analytics/playlist.js";
import * as lastfm from "./lastfm.js";

class RouteError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const needFrame = () => {
  if (!hasData()) throw new RouteError("No data", 400);
  return getFrame();
};

const intOrNull = (value) => {
  if (value === undefined || value === null || value === "" || value === "all") return null;
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
};

const int = (value, fallback) => {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
};

/** Key der letzten.fm-Funktionen einlesen - nur aus dem Aufruf, nie gespeichert. */
const keyOf = (body) => (body && typeof body.key === "string" ? body.key.trim() : "");

export async function handleRequest(method, url, body, query) {
  const q = (name, fallback = null) => (query && query.has(name) ? query.get(name) : fallback);
  const path = url.split("?")[0];

  // ── Upload / Import ───────────────────────────────────────────────────────
  if (path === "/upload" && method === "POST") {
    const files = (body && body.getAll ? body.getAll("files") : []).filter(
      (f) => f && f.name && f.name !== ""
    );
    if (!files.length) throw new RouteError("Keine Datei hochgeladen.");
    const { meta, quality, media: mediaInfo } = await loadFiles(files, onUploadProgress);
    const saved = await saveCache({ profile: (getSettings().profile || "").trim() });
    return {
      success: true,
      years: meta.years,
      total_streams: meta.total,
      unique_tracks: meta.uniqueTracks,
      quality: qualitySummary(quality),
      media: mediaInfo,
      blacklist: getBlacklist(),
      year_scope: getYearScope(),
      account_status: getAccountStatus(),
      cache_saved: saved.ok,
      cache_error: saved.ok ? null : saved.reason,
    };
  }

  // ── Cache: erst nachfragen, dann laden ────────────────────────────────────
  if (path === "/api/cache/info" && method === "GET") {
    const info = await peekCache();
    return { available: !!info, ...(info || {}) };
  }

  if (path === "/api/cache/restore" && method === "POST") {
    const loaded = await loadCache();
    if (!loaded) return { success: false, reason: "nicht lesbar" };
    return { success: true, total_streams: getMeta().total, years: getMeta().years };
  }

  if (path === "/api/cache/clear" && method === "POST") {
    // Loescht nur die Zwischenspeicherung, nicht den geladenen Datensatz -
    // der Nutzer will die Kopie auf dem Geraet weg haben, nicht die Auswertung.
    return { success: await clearCache() };
  }

  // ── Einstellungen ─────────────────────────────────────────────────────────
  if (path === "/api/settings" && method === "GET") return getSettings();

  if (path === "/api/settings" && method === "POST") {
    const previous = getSettings();
    const blBefore = JSON.stringify(previous.artist_blacklist || []);
    const yrBefore = JSON.stringify(previous.years || []);
    const exBefore = JSON.stringify(previous.years_excluded || []);
    if (Array.isArray(body && body.artist_blacklist)) setArtistBlacklist(body.artist_blacklist);
    if (Array.isArray(body && body.years)) setYears(body.years);
    if (Array.isArray(body && body.years_excluded)) setYearsExcluded(body.years_excluded);
    const next = setSettings(body || {});
    const blAfter = JSON.stringify(next.artist_blacklist || []);
    const yrAfter = JSON.stringify(next.years || []);
    const exAfter = JSON.stringify(next.years_excluded || []);
    const tzChanged = body && body.tz_mode !== undefined && previous.tz_mode !== next.tz_mode;
    const mediaChanged = body && body.only_music !== undefined && previous.only_music !== next.only_music;
    const blChanged = blBefore !== blAfter;
    const yrChanged = yrBefore !== yrAfter;
    const exChanged = exBefore !== exAfter;
    if (mediaChanged || blChanged || yrChanged || exChanged) setOnlyMusic(next.only_music);
    else if (tzChanged) applyTimeMode(next.tz_mode);
    let cache = null;
    if (tzChanged || mediaChanged || blChanged || yrChanged || exChanged) cache = await saveCache({ profile: next.profile });
    const m = getMeta();
    return {
      success: true,
      settings: next,
      total_streams: m.total,
      years: m.years,
      media: getMedia(),
      blacklist: getBlacklist(),
      year_exclusion: getYearExclusion(),
      year_scope: getYearScope(),
      cache_saved: cache ? cache.ok : null,
      cache_error: cache && !cache.ok ? cache.reason : null,
    };
  }

  if (path === "/api/outliers" && method === "POST") {
    const { changed, quality } = setIncludeOutliers(body && body.include);
    if (changed) await saveCache({ profile: getSettings().profile });
    const m = getMeta();
    return {
      success: true,
      changed,
      total_streams: m.total,
      years: m.years,
      quality: qualitySummary(quality),
      year_scope: getYearScope(),
    };
  }

  if (path === "/clear" && method === "POST") {
    await clearFrame();
    return { success: true };
  }

  if (path === "/api/session_status" && method === "GET") {
    if (!hasData()) return { loaded: false, account_status: getAccountStatus() };
    const df = getFrame();
    return {
      loaded: true,
      total_streams: df.n,
      unique_tracks: df.meta.nSongs,
      years: getMeta().years,
      latest_stream: get_latest_stream_info(df),
      quality: qualitySummary(getQuality()),
      media: getMedia(),
      blacklist: getBlacklist(),
      year_exclusion: getYearExclusion(),
      year_scope: getYearScope(),
      account_status: getAccountStatus(),
    };
  }

  // Im Browser gibt es keinen Server, der etwas loeschen koennte - die
  // Endpunkte existieren nur, damit das Frontend keinen Fehler sieht.
  if (path === "/api/heartbeat" || path === "/api/disconnect") return { ok: true };

  // ── Account Analytics (ZIP Datensätze) ──────────────────────────────────
  if (path === "/api/account/status" && method === "GET") {
    return getAccountStatus();
  }

  if (path === "/api/account/searches" && method === "GET") {
    const frame = hasData() ? getFrame() : null;
    return analyzeSearches(getAccountData().searches, frame);
  }

  if (path === "/api/account/inferences" && method === "GET") {
    return analyzeInferences(getAccountData().inferences, getAccountData().userdata);
  }

  if (path === "/api/account/library" && method === "GET") {
    const frame = hasData() ? getFrame() : null;
    return analyzeLibrary(getAccountData().library, frame);
  }

  if (path === "/api/account/playlists" && method === "GET") {
    const frame = hasData() ? getFrame() : null;
    return analyzePlaylists(getAccountData().playlists, frame);
  }

  if (path === "/api/account/payments" && method === "GET") {
    const frame = hasData() ? getFrame() : null;
    const res = analyzePayments(getAccountData().payments, frame);
    const purchases = getAccountData().purchases || [];
    let totalHours = 0;
    let totalStreams = 0;
    if (frame && frame.has && frame.has("minutes_played")) {
      const mins = frame.col("minutes_played").data;
      let totalMins = 0;
      for (let i = 0; i < mins.length; i++) totalMins += mins[i];
      totalHours = totalMins / 60;
      totalStreams = frame.n || 0;
    }
    if (purchases.length) {
      const pRes = analyzePurchases(purchases);
      res.has_purchases = true;
      res.merch_spent = pRes.total_spent;
      res.merch_orders = pRes.orders;
      res.merch_items = pRes.items;
      res.merch_currency = pRes.currency;
      if (!res.loaded) {
        const costPerHour = totalHours > 0 ? Math.round((pRes.total_spent / totalHours) * 100) / 100 : 0;
        const costPerStream = totalStreams > 0 ? Math.round((pRes.total_spent / totalStreams) * 10000) / 100 : 0;
        res.loaded = true;
        res.total_spent = pRes.total_spent;
        res.currency = pRes.currency;
        res.cost_per_hour = costPerHour;
        res.cost_per_stream_cents = costPerStream;
        res.total_hours = Math.round(totalHours * 10) / 10;
        res.total_streams = totalStreams;
        res.only_merch = true;
        res.payments = [];
      }
    }
    return res;
  }

  if (path === "/api/account/follow" && method === "GET") {
    return analyzeFollow(getAccountData().follow, getAccountData().userdata);
  }

  if (path === "/api/account/marquee" && method === "GET") {
    return analyzeMarquee(getAccountData().marquee);
  }

  if (path === "/api/account/wrapped" && method === "GET") {
    return analyzeWrapped(getAccountData().wrapped);
  }

  if (path === "/api/account/purchases" && method === "GET") {
    return analyzePurchases(getAccountData().purchases);
  }

  // ── Empfehlungen & Grunddaten ─────────────────────────────────────────────
  if (path === "/recommend" && method === "POST") {
    const df = needFrame();
    const year = int(body.year, 2023);
    const topN = int(body.top_n, 20);
    const minMinutes = Number.isFinite(Number(body.min_minutes)) ? Number(body.min_minutes) : 0.5;
    let result;
    try {
      result = recommend(df, year, topN, minMinutes);
    } catch (err) {
      // Flask liefert bei einem unbekannten Jahr 400 (ValueError), nicht 500.
      throw new RouteError(err && err.message ? err.message : String(err), 400);
    }
    return { success: true, year, profile: result.profile, recommendations: result.recommendations };
  }

  if (path === "/api/years") return get_available_years(needFrame());
  if (path === "/api/artists") return get_all_artists(needFrame());

  if (path === "/api/top_songs") {
    return get_top_songs(needFrame(), intOrNull(q("year")), q("sort", "plays"), int(q("limit"), 50));
  }

  if (path === "/api/heatmap") return get_heatmap_data(needFrame(), intOrNull(q("year")));
  if (path === "/api/skips") {
    return get_skip_analysis(needFrame(), intOrNull(q("year")), int(q("min_plays"), 5), int(q("top_n"), 30));
  }
  if (path === "/api/discover") return get_discover_tracks(needFrame(), intOrNull(q("year")), int(q("top_n"), 20));
  if (path === "/api/compare" && method === "POST") {
    return get_compare_data(needFrame(), int(body.year1, 2023), int(body.year2, 2023));
  }
  if (path === "/api/artist" && method === "POST") return get_artist_data(needFrame(), body.artist || "");

  if (path === "/api/monthly") return get_monthly_stats(needFrame(), intOrNull(q("year")));
  if (path === "/api/monthly_v2") return get_monthly_stats_v2(needFrame(), intOrNull(q("year")));
  if (path === "/api/sessions") return get_session_stats(needFrame(), intOrNull(q("year")));
  if (path === "/api/sessions_v2") return get_session_stats_v2(needFrame(), intOrNull(q("year")));
  if (path === "/api/platforms") return get_platform_stats(needFrame(), intOrNull(q("year")));
  if (path === "/api/albums") {
    return get_album_stats(needFrame(), intOrNull(q("year")), int(q("top_n"), 20));
  }
  if (path === "/api/discoveries") return get_discovery_timeline(needFrame());
  if (path === "/api/streaks") return get_streak_stats(needFrame());
  if (path === "/api/heatmap/cell") {
    return get_heatmap_cell_songs(
      needFrame(), int(q("weekday"), 0), int(q("hour"), 0), intOrNull(q("year")), 15
    );
  }
  if (path === "/api/behavior") return get_deep_behavior_stats(needFrame(), intOrNull(q("year")));
  if (path === "/api/skip_analytics") return get_skip_analytics(needFrame(), q("year", "all"), int(q("min_plays"), 3));

  if (path === "/api/search") {
    const queryText = (q("q", "") || "").trim();
    if (!queryText) return [];
    return get_fuzzy_search(needFrame(), queryText, int(q("top_n"), 25));
  }
  if (path === "/api/song" && method === "POST") {
    return get_song_stats(needFrame(), body.track || "", body.artist || "");
  }
  if (path === "/api/album_detail" && method === "POST") {
    return get_album_detail(needFrame(), body.album || "", body.artist || "");
  }

  // ── Last.fm ───────────────────────────────────────────────────────────────
  if (path === "/api/lastfm/test" && method === "POST") {
    return { valid: await lastfm.testApiKey(keyOf(body)) };
  }
  if (path === "/api/lastfm/tags" && method === "POST") {
    const tracks = Array.isArray(body.tracks) ? body.tracks : [];
    return lastfm.getTagsBatch(tracks.map((t) => [t.artist, t.track]), keyOf(body));
  }
  if (path === "/api/lastfm/similar" && method === "POST") {
    const limit = int(body.limit, 5);
    return {
      tracks: await lastfm.getSimilarTracks(body.artist, body.track, keyOf(body), limit),
    };
  }
  if (path === "/api/lastfm/artist_info" && method === "POST") {
    return lastfm.getArtistInfo(body.artist, keyOf(body));
  }
  if (path === "/api/lastfm/track_stats" && method === "POST") {
    return lastfm.getTrackGlobalStats(body.artist, body.track, keyOf(body));
  }
  if (path === "/api/lastfm/artist_top_tracks" && method === "POST") {
    return { tracks: await lastfm.getArtistTopTracks(body.artist, keyOf(body), int(body.limit, 10)) };
  }
  if (path === "/api/lastfm/similar_artists" && method === "POST") {
    return { artists: await lastfm.getSimilarArtists(body.artist, keyOf(body), int(body.limit, 8)) };
  }
  if (path === "/api/lastfm/latest_stream") return get_latest_stream_info(needFrame());

  if (path === "/api/lastfm/sync" && method === "POST") {
    const df = needFrame();
    const username = (body.username || "").trim();
    const key = keyOf(body);
    if (!username || !key) {
      throw new RouteError("Bitte Last.fm Username und API Key angeben.");
    }
    const latest = get_latest_stream_info(df);
    const fromEpoch = latest.epoch_sec || 0;
    const newTracks = await lastfm.getUserRecentTracks(username, key, fromEpoch, 10);
    if (!newTracks.length) {
      return {
        success: true,
        added_count: 0,
        message: "Alles auf dem neuesten Stand! Keine neuen Streams gefunden.",
        total_streams: df.n,
        latest_stream: latest,
      };
    }
    // An den UNGEFILTERTEN Rohbestand anhaengen (store.appendStreams), nicht an
    // die aktive Ansicht - sonst gingen gerade herausgefilterte Zeilen
    // (Blacklist/Jahre/Medien/Ausreisser) beim Mergen verloren.
    const merged = appendStreams(newTracks);
    await saveCache({ profile: getSettings().profile });
    const years = get_available_years(merged.df);
    const sample = [];
    const count = Math.min(10, newTracks.length);
    for (let i = 0; i < count; i++) {
      const t = newTracks[i];
      let tsStr = "";
      try {
        const d = new Date(t.ts);
        tsStr = d.toLocaleDateString("de-DE") + " um " + d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }) + " Uhr";
      } catch (e) {
        tsStr = t.ts || "";
      }
      sample.push({
        track: t.master_metadata_track_name,
        artist: t.master_metadata_album_artist_name,
        album: t.master_metadata_album_album_name || "",
        ts: tsStr,
        uri: t.spotify_track_uri || "",
      });
    }
    return {
      success: true,
      added_count: merged.addedCount,
      message: merged.addedCount > 0
        ? `${merged.addedCount} neue Streams erfolgreich geloggt und dauerhaft gespeichert!`
        : "Alles aktuell! (0 neue Streams)",
      total_streams: merged.df.n,
      years,
      latest_stream: get_latest_stream_info(merged.df),
      recent_added: sample,
    };
  }

  // ── Playlist ──────────────────────────────────────────────────────────────
  if (path === "/api/playlist/generate" && method === "POST") {
    const df = getFrame();
    return generate_playlist(df, {
      mode: body.mode || "song",
      query: body.query || "",
      artist: body.artist || "",
      album: body.album || "",
      year: body.year === undefined ? "" : body.year,
      genre: body.genre || "",
      sourceMix: body.source_mix || "both",
      limit: int(body.limit, 25),
      lastfmKey: body.key || null,
    });
  }

  throw new RouteError(`Unbekannter Endpunkt: ${path}`, 404);
}

/** Fortschrittsanzeige waehrend des Imports (app.js zeigt ueber den Loader). */
function onUploadProgress(pct, label) {
  const el = document.getElementById("loader-text");
  if (el) el.textContent = `Lese ${label} ... ${Math.round(pct * 100)} %`;
}

/** Was das Frontend zum Ausschluss auffaelliger Zeitstempel wissen muss.
 *  Feldnamen in snake_case wie im Rest der API. */
function qualitySummary(quality) {
  if (!quality) {
    return { has_outliers: false, dropped: 0, include_outliers: false, detail: [], years: [], earliest: null };
  }
  const detail = (quality.outliers || []).map((o) => ({ year: o.year, count: o.count }));
  return {
    has_outliers: detail.length > 0,
    dropped: quality.dropped || 0,
    include_outliers: !!quality.includeOutliers,
    detail,
    years: detail.map((o) => o.year),
    earliest: quality.earliest ?? null,
  };
}

export { loadCache, RouteError };
