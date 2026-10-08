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

const DB_NAME = "wkmm-store";
const DB_VERSION = 1;
const STORE = "dataset";

let frame = null;
let frameAll = null;      // ungeprueft, wie es aus der Datei kam
let quality = null;       // { outliers, dropped, includeOutliers }
let meta = { years: [], total: 0, savedAt: null, fileNames: [] };
let settings = { tz_mode: "utc", profile: "", tz: "" };

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

/**
 * Setzt den aktiven Kalender-Modus fuer den geladenen Datensatz. Die Spalten
 * liegen beide Varianten vor, deshalb geht das ohne erneuten Import.
 */
export function applyTimeMode(mode) {
  const aliases = aliasesForTime(mode);
  if (!frameAll) return;
  // frameAll bleibt IMMER der ungefilterte Datensatz - nur die Spalten-
  // umleitung aendert sich. Andernfalls waeren die ausgeschlossenen Streams
  // endgueltig weg und nicht zurueckschaltbar.
  frameAll = frameAll.withAliases(aliases);
  frame = quality && quality.outliers.length && !quality.includeOutliers
    ? dropOutlierYears(frameAll, quality.outliers).frame.withAliases(aliases)
    : frameAll;
  setFrame(frame, { savedAt: meta.savedAt, fileNames: meta.fileNames });
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
  frame = (want ? frameAll : dropOutlierYears(frameAll, quality.outliers).frame)
    .withAliases(aliasesForTime(settings.tz_mode));
  setFrame(frame, { savedAt: meta.savedAt, fileNames: meta.fileNames });
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
 * Schreibt den Datensatz in den Cache. Typed Arrays werden per Structured
 * Clone direkt uebernommen - kein JSON-Umweg, keine Groessenverluste.
 * @param {object} opts  { profile: string }
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
export async function saveCache(opts = {}) {
  if (!frame) return { ok: false, reason: "kein Datensatz" };
  try {
    const cols = {};
    const types = {};
    for (const [name, col] of Object.entries(frame.cols)) {
      cols[name] = col.data;
      types[name] = col.type;
    }
    const payload = {
      cols, types, n: frame.n, dict: frame.meta,
      at: Date.now(), fileNames: meta.fileNames, quality,
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
    // Ein bereits gepruefter Datensatz bleibt geprueft - die verworfenen
    // Zeilen liegen nicht im Cache und sollen nicht wieder auftauchen.
    if (payload.quality && payload.quality.includeOutliers) {
      quality = { ...payload.quality, includeOutliers: true, dropped: 0 };
      frame = restored;
    } else if (payload.quality) {
      quality = { ...payload.quality, includeOutliers: false };
      frame = dropOutlierYears(restored, payload.quality.outliers).frame;
    } else {
      quality = null;
      frame = restored;
    }
    setFrame(frame, { savedAt: payload.at, fileNames: payload.fileNames || [] });
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
      const entries = await extractZip(file);
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
      ingestRecords(builder, JSON.parse(await file.text()));
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

  // Plausibilitaetspruefung: vereinzelte Jahrgaenge mit falschen Zeitstempeln
  // aus den Auswertungen heraushalten, aber sichtbar und umschaltbar.
  const report = findOutlierYears(built);
  const cleaned = dropOutlierYears(built, report.outliers);
  quality = {
    outliers: report.outliers,
    dropped: cleaned.dropped,
    includeOutliers: false,
    threshold: report.threshold,
    earliest: earliestYear(built),
  };
  // Aktiven Kalender-Modus anwenden (UTC ist Vorgabe)
  applyTimeMode(settings.tz_mode);
  return { meta, quality, fromZip };
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
