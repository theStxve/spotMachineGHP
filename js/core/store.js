/**
 * store.js - haelt den aktuellen Datensatz im Speicher und optional in
 * IndexedDB, damit ein Reload nicht erneut importiert werden muss.
 *
 * Datenschutz: die Daten verlassen das Geraet nicht. Der Cache ist eine
 * Entscheidung des Nutzers und laesst sich jederzeit ueber /clear loeschen.
 */

import { ingestRecords, createBuilder, finalizeFrame, extractZip, isHistoryName } from "./parse.js";
import { Frame } from "./frame.js";
import { findOutlierYears, dropOutlierYears, earliestYear } from "./quality.js";
import { appendAndDeduplicateStreams } from "../analytics/behavior.js";

const DB_NAME = "wkmm-store";
const DB_VERSION = 1;
const STORE = "dataset";

let frame = null;
let frameAll = null;      // ungeprueft, wie es aus der Datei kam
let framePreYears = null; // alle Filter AUSSER Jahresfilter - Zaehler fuer die Chips
let quality = null;       // { outliers, dropped, includeOutliers }
let meta = { years: [], total: 0, savedAt: null, fileNames: [] };
let settings = { tz_mode: "utc", profile: "", tz: "", only_music: false, artist_blacklist: [], years: [], years_excluded: [] };
let media = { music: 0, podcast: 0, audiobook: 0, hidden: 0, total: 0 };
let accountData = {
  searches: [],
  inferences: [],
  library: {},
  playlists: [],
  payments: [],
  userdata: {},
  follow: {},
  marquee: [],
  purchases: [],
  wrapped: {},
  messages: {},
  support: [],
  family: {},
  voice: [],
};

export function getAccountData() {
  return accountData;
}

export function getAccountStatus() {
  return {
    has_searches: accountData.searches.length > 0,
    searches_count: accountData.searches.length,
    has_inferences: accountData.inferences.length > 0,
    inferences_count: accountData.inferences.length,
    has_library: Boolean(
      (accountData.library.tracks && accountData.library.tracks.length) ||
      (accountData.library.albums && accountData.library.albums.length)
    ),
    library_tracks_count: (accountData.library.tracks && accountData.library.tracks.length) || 0,
    has_playlists: accountData.playlists.length > 0,
    playlists_count: accountData.playlists.length,
    has_payments: accountData.payments.length > 0 || accountData.purchases.length > 0,
    payments_count: accountData.payments.length + accountData.purchases.length,
    has_follow: Boolean(Object.keys(accountData.follow).length > 0 || Object.keys(accountData.userdata).length > 0),
    followers_count: (accountData.follow.userIsFollowedBy || accountData.follow.followers || []).length,
    has_marquee: accountData.marquee.length > 0,
    marquee_count: accountData.marquee.length,
    has_wrapped: Boolean(Object.keys(accountData.wrapped).length > 0),
    has_purchases: accountData.purchases.length > 0,
    purchases_count: accountData.purchases.length,
    has_userdata: Boolean(Object.keys(accountData.userdata).length > 0),
    display_name: accountData.userdata.displayName || accountData.userdata.username || ""
  };
}

/** Schaltet den Medienfilter um (nur Musik bzw. alles). */
export function setOnlyMusic(onlyMusic) {
  settings.only_music = !!onlyMusic;
  rebuildActiveFrame();
  return { ...settings };
}

/** Umleitung der Kalender-Spalten, je nach Zeitzonen-Einstellung. */
export function aliasesForTime(mode) {
  if (mode === "local") {
    return {
      year: "year_local", hour: "hour_local", weekday: "weekday_local",
      month: "month_local", ym: "ym_local", day: "day_local",
    };
  }
  return null;
}

/** Zählt Streams je Medientyp im ungefilterten Datensatz. */
function countMedia(f) {
  const out = { music: 0, podcast: 0, audiobook: 0, hidden: 0, total: f ? f.n : 0 };
  if (!f || !f.has("media")) return out;
  const d = f.col("media").data;
  for (let i = 0; i < d.length; i++) {
    if (d[i] === 1) out.podcast++;
    else if (d[i] === 2) out.audiobook++;
    else out.music++;
  }
  out.hidden = out.podcast + out.audiobook;
  return out;
}

export function getMedia() {
  return { ...media };
}

/**
 * Haengt Records an den UNGEFILTERTEN Rohbestand an (Last.fm-Sync) und baut
 * die aktive Ansicht mit allen Filtern neu auf. Die Basis ist bewusst
 * frameAll, nicht die aktive Ansicht - sonst wuerden gerade herausgefilterte
 * Zeilen (Blacklist, Jahre, Medien, Ausreisser) beim Mergen verloren gehen.
 * @returns {{addedCount:number, total:number}}
 */
export function appendStreams(records) {
  if (!frameAll) return { df: null, addedCount: 0 };
  const merged = appendAndDeduplicateStreams(frameAll, records);
  frameAll = merged.df;
  media = countMedia(frameAll);
  rebuildActiveFrame();
  return merged;
}

/** Gesperrte Artists als Kleinschreibungs-Set, Leerraum entfernt. */
function blacklistKeys() {
  const out = new Set();
  for (const name of settings.artist_blacklist || []) {
    const key = String(name).trim().toLowerCase();
    if (key) out.add(key);
  }
  return out;
}

/** Entfernt die Streams der gesperrten Artists aus einer Ansicht. */
function filterBlacklisted(f) {
  const keys = blacklistKeys();
  if (!keys.size) return f;
  const artist = f.col("artist").data;
  const rows = f.rows();
  const keep = [];
  for (let i = 0; i < rows.length; i++) {
    const v = artist[rows[i]];
    if (v !== null && v !== undefined && keys.has(String(v).trim().toLowerCase())) continue;
    keep.push(rows[i]);
  }
  return f.sliceRows(keep);
}

/**
 * Was sperrt tatsaechlich etwas. "matched" steht im Datensatz, "unknown"
 * nicht - ein Tippfehler in der Schreibweise soll sichtbar werden.
 */
export function getBlacklist() {
  const unique = [];
  const seen = new Set();
  for (const name of settings.artist_blacklist || []) {
    const text = String(name).trim().slice(0, 80);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    unique.push(text);
  }
  const out = { names: unique, matched: [], unknown: [], artists_hidden: 0, streams_hidden: 0 };
  if (!unique.length || !frameAll) {
    out.unknown = unique.slice();
    return out;
  }
  const artist = frameAll.col("artist").data;
  const counts = new Map();
  for (let i = 0; i < artist.length; i++) {
    if (artist[i] === null || artist[i] === undefined) continue;
    const key = String(artist[i]).trim().toLowerCase();
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  for (const name of unique) {
    const n = counts.get(name.toLowerCase()) || 0;
    if (n) {
      out.matched.push(name);
      out.streams_hidden += n;
      out.artists_hidden += 1;
    } else {
      out.unknown.push(name);
    }
  }
  return out;
}

/**
 * Bereinigt Artist-Namen fuer die Blacklist: getrimmt, hoechstens 80 Zeichen,
 * case-insensitiv dedupliziert, hoechstens 200 Eintraege. Gemeinsame Logik
 * fuer setArtistBlacklist() und loadCache() - damit ein Reload exakt die
 * gleiche Normalisierung bekommt wie eine direkte Eingabe.
 */
function _cleanBlacklist(names) {
  const seen = new Set();
  const clean = [];
  for (const n of Array.isArray(names) ? names : []) {
    const text = String(n).trim().slice(0, 80);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    clean.push(text);
  }
  return clean.slice(0, 200);
}

/** Setzt die Blacklist (bereits bereinigt) und baut die Ansicht neu auf. */
export function setArtistBlacklist(names) {
  settings.artist_blacklist = _cleanBlacklist(names);
  rebuildActiveFrame();
  return { ...settings };
}

/**
 * Jahre aus den Settings dauerhaft entfernen (years_excluded) - das Gegenstueck
 * zur Artist-Blacklist, nur fuer Jahrgaenge. Was hier drin steht, ist in ALLEN
 * Auswertungen weg - auch aus den Jahres-Dropdowns der Tabs. Leere Liste =
 * nichts ausgeschlossen.
 */
function excludedYearKeys() {
  const out = new Set();
  for (const y of settings.years_excluded || []) {
    const n = Number(y);
    if (Number.isFinite(n)) out.add(n);
  }
  return out;
}

function filterExcludedYears(f) {
  const banned = excludedYearKeys();
  if (!banned.size) return f;
  return f.notInSet("year", banned);
}

/**
 * Was schliesst tatsaechlich etwas aus. "excluded" steht im Datensatz,
 * "unknown" nicht - ein Vertipper beim Jahr soll sichtbar werden.
 */
export function getYearExclusion() {
  const banned = excludedYearKeys();
  const out = { excluded: [], unknown: [], years_hidden: 0, streams_hidden: 0 };
  if (!banned.size || !frameAll || !frameAll.has("year")) {
    out.unknown = Array.from(banned).sort((a, b) => a - b);
    return out;
  }
  const year = frameAll.col("year").data;
  const counts = new Map();
  for (let i = 0; i < year.length; i++) {
    const y = Number(year[i]);
    if (!Number.isFinite(y)) continue;
    counts.set(y, (counts.get(y) || 0) + 1);
  }
  for (const y of Array.from(banned).sort((a, b) => a - b)) {
    const n = counts.get(y) || 0;
    if (n) {
      out.excluded.push(y);
      out.years_hidden += 1;
      out.streams_hidden += n;
    } else {
      out.unknown.push(y);
    }
  }
  return out;
}

/**
 * Bereinigt die Jahres-Ausschlussliste: ganzzahlig, dedupliziert, aufsteigend
 * sortiert, hoechstens 40 Eintraege. Gemeinsame Logik fuer setYearsExcluded()
 * und loadCache().
 */
function _cleanExcludedYears(years) {
  const picked = [];
  const seen = new Set();
  for (const y of Array.isArray(years) ? years : []) {
    const n = Number(y);
    if (Number.isFinite(n) && !seen.has(n)) {
      seen.add(n);
      picked.push(n);
    }
  }
  return picked.slice(0, 40).sort((a, b) => a - b);
}

/** Setzt die ausgeschlossenen Jahre (leere Liste = nichts raus). */
export function setYearsExcluded(years) {
  settings.years_excluded = _cleanExcludedYears(years);
  rebuildActiveFrame();
  return { ...settings };
}

/**
 * Globaler Jahresfilter. Eine leere Liste heisst "alle Jahre" - sonst wird
 * auf genau diese Jahre eingeschraenkt.
 */
function yearKeys() {
  const out = new Set();
  for (const y of settings.years || []) {
    const n = Number(y);
    if (Number.isFinite(n)) out.add(n);
  }
  return out;
}

function filterYears(f) {
  const keys = yearKeys();
  if (!keys.size) return f;
  return f.inSet("year", keys);
}

/** Welche Jahre im Spiel sind - inklusive Streamzahl je Jahr. */
export function getYearScope() {
  // Ohne Jahresfilter waere framePreYears die aktive Ansicht - die Chips
  // brauchen aber ALLE Jahre inklusive der gerade abgewaehlten.
  const src = framePreYears || frameAll;
  const available = [];
  const counts = {};
  if (src && src.has("year")) {
    const g = src.groupBy("year");
    for (let i = 0; i < g.size; i++) {
      const y = Number(g.keyValues[i]);
      if (!Number.isFinite(y)) continue;
      available.push(y);
      counts[y] = g.counts()[i];
    }
    available.sort((a, b) => a - b);
  }
  const keys = yearKeys();
  const selected = keys.size ? available.filter((y) => keys.has(y)) : available;
  let streams = 0;
  for (const y of selected) streams += counts[y] || 0;
  return { available, counts, selected, all: !keys.size, streams };
}

/**
 * Bereinigt die Jahresauswahl: ganzzahlig, dedupliziert, aufsteigend sortiert,
 * hoechstens 40 Eintraege. Gemeinsame Logik fuer setYears() und loadCache().
 */
function _cleanYears(years) {
  const picked = [];
  const seen = new Set();
  for (const y of Array.isArray(years) ? years : []) {
    const n = Number(y);
    if (Number.isFinite(n) && !seen.has(n)) {
      seen.add(n);
      picked.push(n);
    }
  }
  return picked.slice(0, 40).sort((a, b) => a - b);
}

/** Setzt die globalen Jahre (leere Liste = alle). */
export function setYears(years) {
  settings.years = _cleanYears(years);
  rebuildActiveFrame();
  return { ...settings };
}

/**
 * Baut die aktive Ansicht neu auf. Es gibt genau eine Quelle ungefilterter
 * Daten (frameAll) und fuenf Schalter darauf: auffaellige Zeitstempel,
 * Medienfilter, Artist-Blacklist, Jahres-Ausschluss (Settings) und
 * Jahresfilter. Deshalb kann nichts verloren gehen.
 */
function rebuildActiveFrame() {
  if (!frameAll) return;
  const aliases = aliasesForTime(settings.tz_mode);
  frameAll = frameAll.withAliases(aliases);
  let view = frameAll;
  if (quality && quality.outliers.length && !quality.includeOutliers) {
    view = dropOutlierYears(frameAll, quality.outliers).frame;
  }
  if (settings.only_music && frameAll.has("media")) {
    view = view.eq("media", 0).sliceRows(view.rows());
  }
  view = filterBlacklisted(view);
  view = filterExcludedYears(view);
  view = view.withAliases(aliases);
  framePreYears = view;
  view = filterYears(view);
  view = view.withAliases(aliases);
  frame = view;
  setFrame(frame, { savedAt: meta.savedAt, fileNames: meta.fileNames });
}

/**
 * Setzt den aktiven Kalender-Modus fuer den geladenen Datensatz. Die Spalten
 * liegen beide Varianten vor, deshalb geht das ohne erneuten Import.
 */
export function applyTimeMode(mode) {
  // frameAll bleibt IMMER der ungefilterte Datensatz - nur die Spalten-
  // umleitung aendert sich. Andernfalls waeren die ausgeschlossenen Streams
  // endgueltig weg und nicht zurueckschaltbar.
  rebuildActiveFrame();
}

export function getSettings() {
  return { ...settings };
}

/** @returns {object} die tatsaechlich gesetzten Einstellungen */
export function setSettings(patch) {
  if (patch && patch.tz_mode === "local") settings.tz_mode = "local";
  else if (patch && patch.tz_mode === "utc") settings.tz_mode = "utc";
  if (patch && typeof patch.profile === "string") settings.profile = patch.profile.slice(0, 60);
  // Der Browser kennt seine IANA-Zone ("Europe/Berlin"). Das wird
  // mitgeschickt, weil Python unter Windows die Systemzeitzone nicht
  // zuverlaessig ermitteln kann.
  if (patch && typeof patch.tz === "string" && patch.tz) settings.tz = patch.tz.slice(0, 60);
  if (patch && typeof patch.only_music === "boolean") settings.only_music = patch.only_music;
  return { ...settings };
}

export function getFrame() {
  return frame;
}

export function getQuality() {
  return quality;
}

export function getMeta() {
  return meta;
}

export function hasData() {
  return !!frame && frame.n > 0;
}

export function setFrame(newFrame, info = {}) {
  frame = newFrame;
  // meta gehoert zum Datensatz, nicht zur Zeilenauswahl. Sollte es fehlen,
  // liefert frameUniqueTracks() stattdessen 0, statt die App zu kippen.
  if (!frame.meta) frame.meta = { nSongs: 0, nArtists: 0, nAlbums: 0 };
  const years = getAvailableYearsSafe(frame);
  meta = {
    years,
    total: frame ? frame.n : 0,
    uniqueTracks: frame ? frame.meta.nSongs : 0,
    savedAt: info.savedAt || null,
    fileNames: info.fileNames || [],
  };
  return meta;
}

function getAvailableYearsSafe(f) {
  if (!f) return [];
  const g = f.groupBy("year");
  return Array.from(g.keyValues)
    .map(Number)
    .filter((y) => Number.isFinite(y))
    .sort((a, b) => a - b);
}

export function clearFrame() {
  frame = null;
  frameAll = null;
  framePreYears = null;
  quality = null;
  meta = { years: [], total: 0, savedAt: null, fileNames: [] };
  return clearCache();
}

/**
 * Schaltet die gepruefte Ansicht um: ohne die auffaelligen Jahrgaenge oder
 * mit ihnen. Der Import muss dafuer nicht wiederholt werden.
 */
export function setIncludeOutliers(include) {
  if (!frameAll || !quality) return { changed: false, quality };
  if (!quality.outliers.length) return { changed: false, quality };
  const want = !!include;
  if (want === !!quality.includeOutliers) return { changed: false, quality };
  quality = { ...quality, includeOutliers: want };
  rebuildActiveFrame();
  return { changed: true, quality };
}

// ── IndexedDB ────────────────────────────────────────────────────────────────

function openDb() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in self)) {
      reject(new Error("IndexedDB nicht verfuegbar"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("IndexedDB-Fehler"));
  });
}

async function withStore(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const store = tx.objectStore(STORE);
      const result = fn(store);
      tx.oncomplete = () => resolve(result && result.result !== undefined ? result.result : result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/**
 * Schreibt den Datensatz in den Cache. Typed Arrays werden per Structured
 * Clone direkt uebernommen - kein JSON-Umweg, keine Groessenverluste.
 * @returns {Promise<boolean>} true wenn gespeichert
 */
/**
 * Der ungefilterte Rohbestand mit garantiert zusammenhaengenden Spalten.
 * frameAll teilt seine Spalten-Arrays mit dem Ursprungsframe und hat im
 * Normalfall idx=null - dann ist es direkt serialisierbar. Sollte idx doch
 * gesetzt sein (Ansicht statt Materialisierung), wird einmalig materialisiert,
 * damit saveCache keine Ansicht mit Luecken sichert.
 */
function _rawFrame() {
  if (!frameAll) return null;
  if (frameAll.idx) return frameAll.sliceRows(frameAll.rows());
  return frameAll;
}

/**
 * Schreibt den Datensatz in den Cache. Typed Arrays werden per Structured
 * Clone direkt uebernommen - kein JSON-Umweg, keine Groessenverluste.
 * @param {object} opts  { profile: string }
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
export async function saveCache(opts = {}) {
  if (!frame) return { ok: false, reason: "kein Datensatz" };
  try {
    // WICHTIG: immer frameAll (der ungefilterte Rohbestand) sichern, NIE die
    // aktive Ansicht `frame`. `frame` ist bei aktiver Blacklist/Medien-/
    // Jahres- bzw. Ausreisser-Filter ein sliceRows-Abzug mit gekuerzten
    // Spalten. Wuerde der gesichert, waeren die herausgefilterten Zeilen nach
    // dem Reload endgueltig weg - gesperrte Artists liessen sich nicht mehr
    // entsperren, Ausreisser-Jahrgaenge nicht zurueckschalten. Die Filter
    // leben ausschliesslich in `settings` und werden beim Laden neu angewendet.
    const source = _rawFrame();
    const cols = {};
    const types = {};
    for (const [name, col] of Object.entries(source.cols)) {
      cols[name] = col.data;
      types[name] = col.type;
    }
    const payload = {
      cols, types, n: source.n, dict: source.meta || frame.meta,
      at: Date.now(), fileNames: meta.fileNames, quality, settings: { ...settings },
      profile: opts.profile || "",
    };
    await withStore("readwrite", (store) => store.put(payload, "current"));
    return { ok: true };
  } catch (e) {
    // Quota ueberschritten o.ae. - die App laeuft ohne Cache weiter, aber der
    // Nutzer soll davon wissen, sonst wundert er sich nach dem Reload.
    console.warn("Cache nicht speicherbar:", e && e.message);
    return { ok: false, reason: (e && e.name) || "Fehler" };
  }
}

/**
 * Liest nur die Metadaten des Caches - **laedt die Daten nicht**.
 *
 * Grund: der Cache liegt pro Origin, nicht pro Nutzer. Auf einem geteilten
 * Rechner wuerde die naechste Person, die die Seite oeffnet, sonst die Daten
 * des Vorherigen sehen, ohne eine Datei auswaehlen zu muessen. Deshalb
 * fragt die App erst nach, statt still zu laden.
 * @returns {Promise<{n:number, savedAt:number, fileNames:string[], profile:string}|null>}
 */
export async function peekCache() {
  try {
    const payload = await withStore("readonly", (store) => store.get("current"));
    if (!payload || !payload.n) return null;
    return {
      n: payload.n,
      savedAt: payload.at || 0,
      fileNames: payload.fileNames || [],
      profile: payload.profile || "",
    };
  } catch (e) {
    return null;
  }
}

/**
 * Laedt den Datensatz aus dem Cache. Gibt null zurueck, wenn nichts da ist
 * oder der Cache nicht lesbar war (z.B. Format aus aelterer Version).
 */
export async function loadCache() {
  try {
    const payload = await withStore("readonly", (store) => store.get("current"));
    if (!payload || !payload.cols || !payload.n) return null;
    const columns = {};
    for (const [name, data] of Object.entries(payload.cols)) {
      columns[name] = [data, (payload.types && payload.types[name]) || "s"];
    }
    // Die Gruppen-Codes liegen im Cache, finalizeFrame muss nicht neu laufen.
    const restored = Frame.build(columns, payload.n);
    restored.meta = payload.dict || { nSongs: 0, nArtists: 0, nAlbums: 0 };
    frameAll = restored;
    media = countMedia(restored);
    // Ein bereits gepruefter Datensatz bleibt geprueft - die verworfenen
    // Zeilen liegen nicht im Cache und sollen nicht wieder auftauchen.
    if (payload.quality && payload.quality.includeOutliers) {
      quality = { ...payload.quality, includeOutliers: true, dropped: 0 };
    } else if (payload.quality) {
      quality = { ...payload.quality, includeOutliers: false };
    } else {
      quality = null;
    }
    // Die gespeicherten Einstellungen komplett zuruecklesen. saveCache legt
    // das ganze settings-Objekt ab - wird hier nur ein Teil gelesen, waeren
    // Blacklist, Zeitzone und Profil nach dem Reload stillschweigend weg und
    // die gefilterte Ansicht wuerde ohne sie neu aufgebaut. Die Felder werden
    // direkt (ohne die Setter) belegt, damit rebuildActiveFrame nur EINMAL
    // mit vollstaendig belegten Einstellungen laeuft.
    const saved = payload.settings || {};
    settings.tz_mode = saved.tz_mode === "local" ? "local" : "utc";
    settings.tz = typeof saved.tz === "string" ? saved.tz.slice(0, 60) : "";
    settings.profile = typeof saved.profile === "string" ? saved.profile.slice(0, 60) : (payload.profile || "");
    settings.only_music = !!saved.only_music;
    // Blacklist: getrimmt, dedupliziert, hoechstens 200 - wie setArtistBlacklist.
    settings.artist_blacklist = _cleanBlacklist(saved.artist_blacklist);
    // Jahres-Ausschluss: ganzzahlig, dedupliziert, sortiert - wie setYearsExcluded.
    settings.years_excluded = _cleanExcludedYears(saved.years_excluded);
    // Jahre: ganzzahlig, dedupliziert, sortiert, hoechstens 40 - wie setYears.
    settings.years = _cleanYears(saved.years);
    rebuildActiveFrame();
    return meta;
  } catch (e) {
    console.warn("Cache nicht lesbar:", e && e.message);
    return null;
  }
}

export async function clearCache() {
  // Ohne IndexedDB (privater Modus, abgeschalteter Speicher) gibt es auch
  // keine Kopie - das ist fuer den Nutzer ein Erfolg, kein Fehler.
  if (!("indexedDB" in self)) return true;
  try {
    await withStore("readwrite", (store) => store.delete("current"));
    return true;
  } catch (e) {
    return false;
  }
}

// ── Import ──────────────────────────────────────────────────────────────────

const decoder = new TextDecoder("utf-8");

function ingestAccountEntry(k, v) {
  const low = String(k || "").toLowerCase();
  if (low.includes("search")) {
    if (Array.isArray(v)) accountData.searches.push(...v);
    else if (v && Array.isArray(v.searchQueries)) accountData.searches.push(...v.searchQueries);
  } else if (low.includes("inference")) {
    if (Array.isArray(v)) accountData.inferences.push(...v);
    else if (v && Array.isArray(v.inferences)) accountData.inferences.push(...v.inferences);
  } else if (low.includes("library")) {
    if (typeof v === "object") accountData.library = v;
  } else if (low.includes("playlist")) {
    if (Array.isArray(v)) accountData.playlists.push(...v);
    else if (v && Array.isArray(v.playlists)) accountData.playlists.push(...v.playlists);
  } else if (low.includes("payment")) {
    if (Array.isArray(v)) accountData.payments.push(...v);
    else if (v && Array.isArray(v.payments)) accountData.payments.push(...v.payments);
  } else if (low.includes("purchase")) {
    if (Array.isArray(v)) accountData.purchases.push(...v);
  } else if (low.includes("marquee")) {
    if (Array.isArray(v)) accountData.marquee.push(...v);
    else if (v && Array.isArray(v.marquees)) accountData.marquee.push(...v.marquees);
  } else if (low.includes("wrapped")) {
    if (typeof v === "object") Object.assign(accountData.wrapped, v);
  } else if (low.includes("message")) {
    if (typeof v === "object") Object.assign(accountData.messages, v);
  } else if (low.includes("userattributes") || low.includes("userdata") || low.includes("identity")) {
    if (typeof v === "object") Object.assign(accountData.userdata, v);
  } else if (low.includes("follow")) {
    if (typeof v === "object") Object.assign(accountData.follow, v);
  } else if (low.includes("support")) {
    if (Array.isArray(v)) accountData.support.push(...v);
  } else if (low.includes("family")) {
    if (typeof v === "object") accountData.family = v;
  } else if (low.includes("voice")) {
    if (Array.isArray(v)) accountData.voice.push(...v);
  }
}

/**
 * Liest Dateien ein (ZIP oder einzelne JSON) und baut den Datensatz.
 * @param {File[]} files
 * @param {(pct:number, label:string) => void} onProgress
 */
export async function loadFiles(files, onProgress = () => {}) {
  const builder = createBuilder();
  let done = 0;
  const total = files.length;
  const names = [];
  let fromZip = 0;

  for (const file of files) {
    names.push(file.name);
    if (/\.zip$/i.test(file.name)) {
      const res = await extractZip(file);
      const entries = res.history || [];
      const acc = res.account || {};
      for (const [k, v] of Object.entries(acc)) {
        ingestAccountEntry(k, v);
      }
      for (const entry of entries) {
        ingestRecords(builder, JSON.parse(decoder.decode(entry.bytes)));
        fromZip += 1;
        done += 1;
        onProgress(done / total, `ZIP: ${entry.name.split("/").pop()}`);
      }
      if (!entries.length) {
        // ZIP ohne passende Dateien: letzte Chance ueber den Dateinamen
        const all = await extractAnyZipJson(file);
        for (const data of all) {
          ingestRecords(builder, JSON.parse(decoder.decode(data)));
          done += 1;
          onProgress(done / total, `ZIP-Inhalt: ${file.name}`);
        }
      }
    } else if (/\.json$/i.test(file.name)) {
      const base = file.name.toLowerCase();
      if (/Streaming_History/i.test(base) || /endsong/i.test(base) || /StreamingHistory/i.test(base)) {
        ingestRecords(builder, JSON.parse(await file.text()));
      } else {
        try {
          const v = JSON.parse(await file.text());
          ingestAccountEntry(base, v);
        } catch (e) {}
      }
      done += 1;
      onProgress(done / total, file.name);
    }
  }

  if (!builder.ts.length) {
    throw new Error(
      "Keine Streaming-History gefunden. Erwartet werden Dateien wie " +
      "Streaming_History_Audio_2024.json oder ein ZIP davon."
    );
  }

  const built = finalizeFrame(builder);
  frameAll = built;
  media = countMedia(built);

  // Plausibilitaetspruefung: vereinzelte Jahrgaenge mit falschen Zeitstempeln
  // aus den Auswertungen herausaushalten, aber sichtbar und umschaltbar.
  const report = findOutlierYears(built);
  const cleaned = dropOutlierYears(built, report.outliers);
  quality = {
    outliers: report.outliers,
    dropped: cleaned.dropped,
    includeOutliers: false,
    threshold: report.threshold,
    earliest: earliestYear(built),
  };
  // Aktiven Kalender- und Medienmodus anwenden (UTC und "alles" sind Vorgabe)
  rebuildActiveFrame();
  return { meta, quality, media, fromZip };
}



/** Fallback fuer ZIPs, deren Dateinamen nicht dem Spotify-Muster entsprechen. */
async function extractAnyZipJson(file) {
  const { unzipSync } = await import("../vendor/fflate.js");
  const buf = new Uint8Array(await file.arrayBuffer());
  const entries = unzipSync(buf);
  return Object.entries(entries)
    .filter(([name]) => !name.endsWith("/") && /\.json$/i.test(name))
    .map(([, data]) => data);
}

export { isHistoryName };
