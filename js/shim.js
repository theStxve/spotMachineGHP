/**
 * shim.js - leitet alle API-Aufrufe des Frontends auf den lokalen Router um.
 *
 * static/app.js ruft per fetch() gegen /api/... bzw. /upload. Hier wird
 * window.fetch ersetzt, sodass das Frontend unveraendert sowohl hinter Flask
 * (EXE, Render) als auch rein statisch auf GitHub Pages laufen kann.
 *
 * Alles laeuft im Browser: es gibt keinen Server, der die Daten sieht.
 */

import { handleRequest } from "./api.js";
import { hasData, peekCache } from "./core/store.js";

const KNOWN_PATHS = [
  "/upload", "/clear", "/recommend",
  "/api/years", "/api/artists", "/api/heatmap", "/api/skips", "/api/discover",
  "/api/compare", "/api/artist", "/api/monthly", "/api/monthly_v2",
  "/api/sessions", "/api/sessions_v2", "/api/platforms", "/api/albums",
  "/api/discoveries", "/api/streaks", "/api/behavior", "/api/skip_analytics",
  "/api/search", "/api/song", "/api/album_detail", "/api/session_status",
  "/api/heartbeat", "/api/disconnect", "/api/playlist/generate", "/api/outliers",
  "/api/cache/info", "/api/cache/restore", "/api/cache/clear", "/api/settings",
  "/api/top_songs",
];

const KNOWN_PREFIXES = ["/api/heatmap/cell", "/api/lastfm/", "/api/account/"];

function isLocalRoute(path) {
  if (KNOWN_PATHS.includes(path)) return true;
  return KNOWN_PREFIXES.some((p) => path.startsWith(p));
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const realFetch = window.fetch.bind(window);

window.fetch = async function shim(input, init = {}) {
  const url = typeof input === "string" ? input : input.url;
  const method = (init.method || (typeof input !== "string" && input.method) || "GET").toUpperCase();

  let parsed;
  try {
    parsed = new URL(url, location.href);
  } catch (e) {
    return realFetch(input, init);
  }

  // Achtung: URL normalisiert den Host auf Kleinschreibung, location.origin
  // nicht. Ohne .toLowerCase() waere der Vergleich bei einem Host wie
  // "theStxve.github.io" immer falsch und alle API-Aufrufe wuerden ins
  // Leere laufen.
  const sameOrigin = parsed.origin.toLowerCase() === String(location.origin || "").toLowerCase();
  if (!sameOrigin || !isLocalRoute(parsed.pathname)) {
    return realFetch(input, init);
  }

  // Der Cache muss geladen sein, bevor der erste API-Aufruf antwortet -
  // sonst wuerde /api/session_status leeren Lauf melden und das Frontend
  // wuerde den Upload-Screen zeigen, obwohl Daten da sind.
  await cacheReady;

  // Kein Datenbestand und etwas, das ihn braucht: so antworten wie Flask mit 400.
  if (!hasData() && ![
    "/upload", "/clear", "/api/session_status", "/api/heartbeat", "/api/disconnect",
    "/api/cache/info", "/api/cache/restore", "/api/cache/clear", "/api/settings",
  ].includes(parsed.pathname)) {
    return jsonResponse({ error: "No data" }, 400);
  }

  let body = null;
  const raw = init.body;
  if (raw instanceof FormData) {
    body = raw;
  } else if (typeof raw === "string" && raw.length) {
    try {
      body = JSON.parse(raw);
    } catch (e) {
      body = null;
    }
  } else if (raw && typeof raw === "object" && !(raw instanceof Blob)) {
    body = raw;
  }

  try {
    const payload = await handleRequest(method, parsed.pathname + parsed.search, body, parsed.searchParams);
    return jsonResponse(payload);
  } catch (err) {
    const status = err && err.status ? err.status : 500;
    return jsonResponse({ error: err && err.message ? err.message : String(err) }, status);
  }
};

/**
 * Ein vorhandener Cache wird **nicht** von selbst geladen.
 *
 * Der Cache liegt pro Origin, nicht pro Nutzer. Ohne Nachfrage wuerde auf
 * einem geteilten Rechner die naechste Person, die die Seite oeffnet, die
 * Daten des Vorherigen sehen - genau das Problem, das es bei der
 * Server-Variante gab. Stattdessen wird nur gemeldet, dass etwas da ist.
 */
function offerCachedData() {
  return peekCache().then((info) => {
    window.__wkmmCacheInfo = info;
    if (info) window.dispatchEvent(new CustomEvent("wkmm:cache-found", { detail: info }));
    return info;
  }).catch(() => null);
}

const cacheReady = offerCachedData();
