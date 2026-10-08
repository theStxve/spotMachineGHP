/**
 * frame.js - Minimaler, spaltenbasierter DataFrame-Ersatz fuer den Browser.
 *
 * Warum nicht einfach Objekte-Arrays? Eine Spotify-History enthaelt leicht
 * 1-1.000.000 Streams. 1 Mio. Objekte mit je 20 Feldern = ~1 GB RAM und
 * sekundenlange GCs. Hier liegt jede Spalte in einem Typed Array
 * (8 Byte/Zelle statt ~200 Byte/Zelle). Das macht die Gruppierung auf
 * ganzzahligen Codes zur teuren, aber schnellen Operation.
 *
 * Die API bildet das pandas-Muster ab, damit der Port aus
 * recommender_core.py fast 1:1 uebernommen werden kann:
 *   df[df["year"] == 2024]                     -> frame.eq("year", 2024)
 *   df.groupby("song_id").agg(...)             -> frame.groupBy("song_id").sum(...)
 *   df.sort_values("ts")                       -> frame.sorted("ts")
 *   df.head(10).to_dict("records")             -> frame.head(10).records()
 */

const TYPE = { I: "i", F: "f", S: "s", B: "b" };

export class Column {
  constructor(name, data, type) {
    this.name = name;
    this.data = data;
    this.type = type;
  }
  get length() {
    return this.data.length;
  }
  at(i) {
    return this.data[i];
  }
}

export class GroupTable {
  /**
   * @param {Frame} frame  Quellframe (kann eine gefilterte Ansicht sein)
   * @param {Int32Array} codes  Position in der Ansicht -> Gruppenindex, -1 = verworfen
   * @param {Uint32Array} rows  Position in der Ansicht -> echter Zeilenindex
   * @param {number} nGroups
   * @param {Array} keyValues
   * @param {Array} keyArrays
   */
  constructor(frame, codes, rows, nGroups, keyValues, keyArrays) {
    this.frame = frame;
    this.codes = codes;
    this.rows = rows;
    this.nGroups = nGroups;
    this.keyValues = keyValues;
    this.keyArrays = keyArrays;
  }

  get size() {
    return this.nGroups;
  }

  /**
   * Laeuft ueber alle Zeilen der Ansicht und ruft visit(gruppenindex,
   * echterZeilenindex, spaltenwert) auf. Zaehlende/Aufsummierende Operationen
   * benutzen NUR diese Schleife - so bleibt die Gruppenbildung bei gefilterten
   * Ansichten korrekt (Position != Zeilenindex!).
   */
  _each(visit) {
    const codes = this.codes;
    const rows = this.rows;
    for (let i = 0; i < codes.length; i++) {
      const g = codes[i];
      if (g < 0) continue;
      visit(g, rows[i]);
    }
  }

  /** Anzahl Zeilen je Gruppe (= pandas size / count ohne Spalte). */
  counts() {
    const out = new Int32Array(this.nGroups);
    this._each((g) => { out[g]++; });
    return out;
  }

  /** count() einer beliebigen Spalte: zaehlt nicht-null-Werte. */
  count(colName) {
    const d = this.frame.col(colName).data;
    const out = new Int32Array(this.nGroups);
    this._each((g, row) => {
      const v = d[row];
      if (v === null || v === undefined || v === "" || Number.isNaN(v)) return;
      out[g]++;
    });
    return out;
  }

  sum(colName) {
    const col = this.frame.col(colName);
    const d = col.data;
    const out = new Float64Array(this.nGroups);
    if (col.type === TYPE.B) {
      this._each((g, row) => { out[g] += d[row] ? 1 : 0; });
    } else {
      this._each((g, row) => {
        const v = d[row];
        if (v === null || v === undefined || Number.isNaN(v)) return;
        out[g] += v;
      });
    }
    return out;
  }

  mean(colName) {
    const s = this.sum(colName);
    const c = this.count(colName);
    const out = new Float64Array(this.nGroups);
    for (let g = 0; g < this.nGroups; g++) out[g] = c[g] ? s[g] / c[g] : NaN;
    return out;
  }

  max(colName) {
    const d = this.frame.col(colName).data;
    const out = new Float64Array(this.nGroups).fill(-Infinity);
    this._each((g, row) => {
      const v = d[row];
      if (v === null || v === undefined || Number.isNaN(v)) return;
      if (v > out[g]) out[g] = v;
    });
    return out;
  }

  min(colName) {
    const d = this.frame.col(colName).data;
    const out = new Float64Array(this.nGroups).fill(Infinity);
    this._each((g, row) => {
      const v = d[row];
      if (v === null || v === undefined || Number.isNaN(v)) return;
      if (v < out[g]) out[g] = v;
    });
    return out;
  }

  /** Anzahl verschiedener Werte je Gruppe (nunique). */
  nunique(colName) {
    const d = this.frame.col(colName).data;
    const out = new Int32Array(this.nGroups);
    const seen = new Map();
    this._each((g, row) => {
      const v = d[row];
      if (v === null || v === undefined || v === "") return;
      let set = seen.get(g);
      if (!set) {
        set = new Set();
        seen.set(g, set);
      }
      set.add(v);
    });
    for (const [g, set] of seen) out[g] = set.size;
    return out;
  }

  /** Erster Wert in Zeilenreihenfolge (pandas first()). */
  first(colName) {
    const d = this.frame.col(colName).data;
    const out = new Array(this.nGroups).fill(null);
    const filled = new Uint8Array(this.nGroups);
    this._each((g, row) => {
      if (filled[g]) return;
      filled[g] = 1;
      out[g] = d[row];
    });
    return out;
  }

  last(colName) {
    const d = this.frame.col(colName).data;
    const out = new Array(this.nGroups).fill(null);
    this._each((g, row) => { out[g] = d[row]; });
    return out;
  }
}

export class Frame {
  /**
   * @param {Object<string, Column>} cols
   * @param {Uint32Array|null} idx  Zeilenindizes; null = alle Zeilen
   * @param {Object|null} aliases  Umleitung Spaltenname -> realer Name
   */
  constructor(cols, idx, aliases) {
    this.cols = cols;
    this.idx = idx || null;
    this.aliases = aliases || null;
    this.n = idx ? idx.length : (cols[Object.keys(cols)[0]].data.length);
  }

  static build(columns, n) {
    const cols = {};
    for (const [name, [data, type]] of Object.entries(columns)) {
      cols[name] = new Column(name, data, type);
    }
    return new Frame(cols, null);
  }

  /**
   * Leitet Spaltennamen auf andere um. Dadurch bleibt die Analytics identisch
   * und trotzdem in lokalen Zeit rechenbar:
   *   frame.withAliases({ hour: "hour_local" }).eq("year", 2024)
   * Laesst alle Spalten vorhanden, es wird nur der Name aufgeloest.
   */
  withAliases(aliases) {
    const view = new Frame(this.cols, this.idx, aliases);
    // meta beschreibt den Datensatz, nicht die Ansicht - muss durchgereicht
    // werden, sonst fehlen spaeter nSongs/nArtists.
    if (this.meta) view.meta = this.meta;
    return view;
  }

  has(name) {
    return Object.prototype.hasOwnProperty.call(this.cols, this._resolve(name));
  }

  _resolve(name) {
    if (this.aliases && this.aliases[name]) return this.aliases[name];
    return name;
  }

  col(name) {
    const c = this.cols[this._resolve(name)];
    if (!c) throw new Error("Unbekannte Spalte: " + name);
    return c;
  }

  /** Zeilenindex-Array (nie null). */
  rows() {
    if (this.idx) return this.idx;
    const out = new Uint32Array(this.n);
    for (let i = 0; i < this.n; i++) out[i] = i;
    return out;
  }

  /** Neue Ansicht mit gefilterten Zeilen - es wird nichts kopiert. */
  take(indices) {
    const view = new Frame(this.cols, Uint32Array.from(indices), this.aliases);
    if (this.meta) view.meta = this.meta;
    return view;
  }

  // ── Filter ────────────────────────────────────────────────────────────────
  eq(name, value) {
    const d = this.col(name).data;
    const r = this.rows();
    const out = [];
    for (let i = 0; i < r.length; i++) if (d[r[i]] === value) out.push(r[i]);
    return this.take(out);
  }

  ne(name, value) {
    const d = this.col(name).data;
    const r = this.rows();
    const out = [];
    for (let i = 0; i < r.length; i++) if (d[r[i]] !== value) out.push(r[i]);
    return this.take(out);
  }

  /** Elementweiser Vergleich zweier Spalten (fuer groupby-Joins). */
  eqCol(nameA, nameB) {
    const a = this.col(nameA).data;
    const b = this.col(nameB).data;
    const r = this.rows();
    const out = [];
    for (let i = 0; i < r.length; i++) if (a[r[i]] === b[r[i]]) out.push(r[i]);
    return this.take(out);
  }

  inSet(name, set) {
    const d = this.col(name).data;
    const r = this.rows();
    const out = [];
    for (let i = 0; i < r.length; i++) if (set.has(d[r[i]])) out.push(r[i]);
    return this.take(out);
  }

  notInSet(name, set) {
    const d = this.col(name).data;
    const r = this.rows();
    const out = [];
    for (let i = 0; i < r.length; i++) if (!set.has(d[r[i]])) out.push(r[i]);
    return this.take(out);
  }

  ge(name, value) {
    return this._cmp(name, (v) => v >= value);
  }
  gt(name, value) {
    return this._cmp(name, (v) => v > value);
  }
  le(name, value) {
    return this._cmp(name, (v) => v <= value);
  }
  lt(name, value) {
    return this._cmp(name, (v) => v < value);
  }

  _cmp(name, pred) {
    const d = this.col(name).data;
    const r = this.rows();
    const out = [];
    for (let i = 0; i < r.length; i++) if (pred(d[r[i]])) out.push(r[i]);
    return this.take(out);
  }

  filter(pred) {
    const r = this.rows();
    const out = [];
    for (let i = 0; i < r.length; i++) {
      if (pred(r[i], this)) out.push(r[i]);
    }
    return this.take(out);
  }

  concat(other) {
    const merged = { ...this.cols };
    for (const [k, v] of Object.entries(other.cols)) if (!(k in merged)) merged[k] = v;
    const view = new Frame(merged, null);
    if (this.meta) view.meta = this.meta;
    return view;
  }

  // ── Sortieren ─────────────────────────────────────────────────────────────
  /**
   * @param {Array<[string, boolean]>} specs  [Spalte, aufsteigend?]
   * @returns {Uint32Array} Zeilenindizes, stabil sortiert (wie pandas head())
   */
  sorted(specs) {
    const cols = specs.map(([name]) => this.col(name).data);
    const dirs = specs.map(([, asc]) => (asc ? 1 : -1));
    const r = Array.from(this.rows());
    r.sort((a, b) => {
      for (let k = 0; k < cols.length; k++) {
        const av = cols[k][a];
        const bv = cols[k][b];
        if (av < bv) return -dirs[k];
        if (av > bv) return dirs[k];
      }
      return 0;
    });
    return Uint32Array.from(r);
  }

  /** head(n) als Frame. */
  head(n) {
    const r = this.rows();
    return this.take(r.length > n ? r.slice(0, n) : r);
  }

  /**
   * Neue Ansicht mit einer Auswahl konkreter Zeilenindizes, wherein den
   * Spalten die Werte liegen. Die Spalten werden kopiert, weil sich sonst die
   * Views gegenseitig in die Fresse schreiben wuerden.
   *
   * Wichtig: Das Ergebnis traegt KEINE zusaetzliche Indexierung mehr - die
   * Spalten enthalten die Auswahl bereits. Sonst wuerden die Originalindizes
   * ein zweites Mal auf die bereits geschnittenen Spalten angewandt.
   * @param {number[]|Uint32Array} keep
   */
  sliceRows(keep) {
    const n = keep.length;
    const cols = {};
    for (const [name, col] of Object.entries(this.cols)) {
      const out = new col.data.constructor(n);
      for (let i = 0; i < n; i++) out[i] = col.data[keep[i]];
      cols[name] = new Column(name, out, col.type);
    }
    const view = new Frame(cols, null);
    // meta gehoert zum Datensatz, nicht zur Zeilenauswahl - ohne sie fehlen
    // spaeter nSongs/nArtists (z.B. in /api/session_status).
    if (this.meta) view.meta = this.meta;
    return view;
  }

  // ── Gruppen ───────────────────────────────────────────────────────────────
  /**
   * @param {string|Array<string>} names
   * @param {Object} opts  {sorted: true|false, codeCol: "song_id_code"}
   */
  groupBy(names, opts = {}) {
    const list = Array.isArray(names) ? names : [names];
    const rows = this.rows();
    const built = buildCodes(this, list, rows, opts);
    return new GroupTable(this, built.codes, rows, built.nGroups, built.keyValues, built.keyArrays);
  }

  /**
   * Gruppierung direkt ueber einen vorberechneten Integer-Code (schnellster
   * Weg, weil die Codes in parse.js schon beim Einlesen vergeben werden).
   * @param {string} codeCol
   */
  groupByCode(codeCol, opts = {}) {
    const d = this.col(codeCol).data;
    const rows = this.rows();
    const codes = new Int32Array(rows.length).fill(-1);
    const map = new Map();
    for (let i = 0; i < rows.length; i++) {
      const v = d[rows[i]];
      if (v === null || v === undefined || Number.isNaN(v)) continue;
      let g = map.get(v);
      if (g === undefined) {
        g = map.size;
        map.set(v, g);
      }
      codes[i] = g;
    }
    let nGroups = map.size;
    if (opts.sorted !== false && !opts.sortedDone) {
      // Schluessel aufsteigend ordnen (pandas groupby(sort=True))
      const entries = Array.from(map.entries()).sort((a, b) => a[0] - b[0]);
      const remap = new Int32Array(entries.length);
      entries.forEach(([k], i) => { remap[map.get(k)] = i; });
      for (let i = 0; i < codes.length; i++) if (codes[i] >= 0) codes[i] = remap[codes[i]];
    }
    return new GroupTable(this, codes, rows, nGroups, null, null);
  }

  // ── Ausgabe ───────────────────────────────────────────────────────────────
  /** Python to_dict("records") - nur fuer kleine Ergebnis-Mengen. */
  records(cols = null) {
    const names = cols || Object.keys(this.cols);
    const arrays = names.map((n) => this.col(n).data);
    const r = this.rows();
    const out = new Array(r.length);
    for (let i = 0; i < r.length; i++) {
      const rec = {};
      for (let k = 0; k < names.length; k++) rec[names[k]] = arrays[k][r[i]];
      out[i] = rec;
    }
    return out;
  }

  /** Schnellzugriff auf einen Einzelwert. */
  at(name, rowIndex) {
    const r = this.rows();
    return this.col(name).data[r[rowIndex]];
  }
}

/**
 * Vergibt Gruppen-Codes fuer eine oder mehrere Schluessel-Spalten.
 *
 * Zwei Fallen, die hier bewusst behandelt werden:
 *  1. Zeilen mit null-Schluessel fallen raus - pandas groupby verwirft NaN.
 *  2. Mehrfachschluessel brauchen einen stabilen Map-Key. Ein frisches Array
 *     als Key trifft nie (Referenzgleichheit), deshalb wird ein String gebaut.
 */
function buildCodes(frame, names, rows, opts) {
  const sorted = opts.sorted !== false;
  const codes = new Int32Array(rows.length).fill(-1);
  const nKeys = names.length;
  const arrays = names.map((n) => frame.col(n).data);
  const map = new Map();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    let key;
    if (nKeys === 1) {
      const v = arrays[0][row];
      if (v === null || v === undefined) continue;      // NaN fliegt raus
      key = v;
    } else {
      const parts = new Array(nKeys);
      let bad = false;
      for (let k = 0; k < nKeys; k++) {
        const v = arrays[k][row];
        if (v === null || v === undefined) { bad = true; break; }
        parts[k] = v;
      }
      if (bad) continue;
      key = parts.join("\u0000");
    }
    let code = map.get(key);
    if (code === undefined) {
      code = map.size;
      map.set(key, code);
    }
    codes[i] = code;
  }

  // pandas gruppiert nach Schluessel sortiert (sort=True).
  const entries = Array.from(map.entries());
  const nGroups = entries.length;
  const kv = new Array(nGroups);
  const ka = nKeys === 1 ? null : Array.from({ length: nGroups }, () => new Array(nKeys));

  if (!sorted) {
    entries.forEach(([k], newCode) => {
      if (nKeys === 1) {
        kv[newCode] = k;
      } else {
        const parts = k.split("\u0000");
        for (let i = 0; i < nKeys; i++) ka[newCode][i] = parts[i];
      }
    });
    return { codes, nGroups, keyValues: kv, keyArrays: ka };
  }

  entries.sort((a, b) => {
    if (typeof a[0] === "number" && typeof b[0] === "number") return a[0] - b[0];
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
  });
  const remap = new Int32Array(nGroups);
  entries.forEach(([k, oldCode], newCode) => {
    remap[oldCode] = newCode;
    if (nKeys === 1) {
      kv[newCode] = k;
    } else {
      const parts = k.split("\u0000");
      for (let i = 0; i < nKeys; i++) ka[newCode][i] = parts[i];
    }
  });
  for (let i = 0; i < codes.length; i++) if (codes[i] >= 0) codes[i] = remap[codes[i]];

  return { codes, nGroups, keyValues: kv, keyArrays: ka };
}

export const TYPES = TYPE;
