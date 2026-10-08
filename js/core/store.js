/**
 * store.js - haelt den aktuellen Datensatz im Speicher und optional in
 * IndexedDB, damit ein Reload nicht erneut importiert werden muss.
 *
 * Datenschutz: die Daten verlassen das Geraet nicht. Der Cache ist eine
 * Entscheidung des Nutzers und laesst sich jederzeit ueber /clear loeschen.
 */

import { ingestRecords, createBuilder, finalizeFrame, extractZip, isHistoryName } from "./parse.js";
import { Frame } from "./frame.js";

const DB_NAME = "wkmm-store";
const DB_VERSION = 1;
const STORE = "dataset";

let frame = null;
let meta = { years: [], total: 0, savedAt: null, fileNames: [] };

export function getFrame() {
  return frame;
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
  meta = { years: [], total: 0, savedAt: null, fileNames: [] };
  return clearCache();
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
export async function saveCache() {
  if (!frame) return false;
  try {
    const cols = {};
    const types = {};
    for (const [name, col] of Object.entries(frame.cols)) {
      cols[name] = col.data;
      types[name] = col.type;
    }
    const payload = {
      cols, types, n: frame.n, dict: frame.meta,
      at: Date.now(), fileNames: meta.fileNames,
    };
    await withStore("readwrite", (store) => store.put(payload, "current"));
    return true;
  } catch (e) {
    // Quota ueberschritten o.ae. - die App laeuft ohne Cache weiter.
    console.warn("Cache nicht speicherbar:", e && e.message);
    return false;
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
    setFrame(restored, { savedAt: payload.at, fileNames: payload.fileNames || [] });
    return meta;
  } catch (e) {
    console.warn("Cache nicht lesbar:", e && e.message);
    return null;
  }
}

export async function clearCache() {
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
  setFrame(built, { savedAt: Date.now(), fileNames: names });
  return { meta, fromZip };
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
