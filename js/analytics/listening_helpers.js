/**
 * listening_helpers.js - Bausteine fuer listening.js.
 *
 * Wichtigster Teil ist pandasArgsort: pandas sort_values() nutzt per Default
 * numpy-Introsort (kind="quicksort"). Der ist NICHT stabil, liefert bei
 * Gleichstaenden aber eine deterministische Reihenfolge. Damit die JS-Ausgabe
 * JSON-strukturell identisch zur pandas-Referenz bleibt, ist genau dieser
 * Algorithmus hier nachgebaut (numpy 1.26 core/src/npysort/quicksort.cpp).
 * pandas.nargsort dreht die Eingabe fuer "ascending=False" zusaetzlich um,
 * das steckt in derselben Funktion.
 *
 * Zweiter Punkt: groupByCols(). frame.groupBy() kann Mehrfach-Schluessel nicht
 * (Array-Key in einer Map trifft nie) und GroupTable liest in sum()/count()/
 * nunique()/first() die Spalte mit dem Positionsindex der Ansicht statt mit dem
 * echten Zeilenindex - bei gefilterten Frames kommen so die falschen Zeilen
 * heraus. GroupView macht beides richtig.
 */

import { Frame, Column } from "../core/frame.js";


// â”€â”€ numpy-Introsort (aquicksort_ + aheapsort_) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const SMALL_QUICKSORT = 15;

function msb(x) {
  let r = 0;
  while (x > 1) { x = Math.floor(x / 2); r++; }
  return r;
}

function swapIdx(a, i, j) {
  const t = a[i]; a[i] = a[j]; a[j] = t;
}

/** aheapsort_ - Fallback, falls die Rekursionstiefe erschoepft ist. */
function aheapsortIdx(v, idx, pl, pr) {
  const n = pr - pl + 1;
  const a = (i) => idx[pl + i - 1];
  const put = (i, val) => { idx[pl + i - 1] = val; };
  for (let l = n >> 1; l > 0; --l) {
    const tmp = a(l);
    let i = l, j = l << 1;
    while (j <= n) {
      if (j < n && v[a(j)] < v[a(j + 1)]) ++j;
      if (v[tmp] < v[a(j)]) { put(i, a(j)); i = j; j += j; } else break;
    }
    put(i, tmp);
  }
  for (let nn = n; nn > 1;) {
    const tmp = a(nn);
    put(nn, a(1));
    nn -= 1;
    let i = 1, j = 2;
    while (j <= nn) {
      if (j < nn && v[a(j)] < v[a(j + 1)]) ++j;
      if (v[tmp] < v[a(j)]) { put(i, a(j)); i = j; j += j; } else break;
    }
    put(i, tmp);
  }
}

/** aquicksort_ fuer float64: sortiert die Indizes idx[] nach v[idx[]]. */
function sortIdx(v, idx, num) {
  let pl = 0;
  let pr = num - 1;
  const lo = [], hi = [], dep = [];
  let cdepth = msb(num) * 2;

  for (;;) {
    if (cdepth < 0) {
      aheapsortIdx(v, idx, pl, pr);
    } else {
      while (pr - pl > SMALL_QUICKSORT) {
        const pm = pl + ((pr - pl) >> 1);
        if (v[idx[pm]] < v[idx[pl]]) swapIdx(idx, pm, pl);
        if (v[idx[pr]] < v[idx[pm]]) swapIdx(idx, pr, pm);
        if (v[idx[pm]] < v[idx[pl]]) swapIdx(idx, pm, pl);
        const vp = v[idx[pm]];
        let pi = pl;
        let pj = pr - 1;
        swapIdx(idx, pm, pj);
        for (;;) {
          do { ++pi; } while (v[idx[pi]] < vp);
          do { --pj; } while (vp < v[idx[pj]]);
          if (pi >= pj) break;
          swapIdx(idx, pi, pj);
        }
        swapIdx(idx, pi, pr - 1);
        if (pi - pl < pr - pi) { lo.push(pi + 1); hi.push(pr); pr = pi - 1; }
        else { lo.push(pl); hi.push(pi - 1); pl = pi + 1; }
        dep.push(--cdepth);
      }
      for (let pi = pl + 1; pi <= pr; pi++) {
        const vi = idx[pi];
        const vp = v[vi];
        let pj = pi, pk = pi - 1;
        while (pj > pl && vp < v[idx[pk]]) { idx[pj] = idx[pk]; pj--; pk--; }
        idx[pj] = vi;
      }
    }
    if (lo.length === 0) break;
    pr = hi.pop();
    pl = lo.pop();
    cdepth = dep.pop();
  }
}

/** Vergleich wie Python auf Strings (fuer stabile Sortierungen). */
export function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * pandas nargsort(values, kind="quicksort", ascending, na_position="last").
 * @param {ArrayLike} values
 * @param {boolean} ascending
 * @returns {Array<number>} Zeilenindizes in pandas-Reihenfolge
 */
export function pandasArgsort(values, ascending) {
  const n = values.length;
  const pos = [];
  const vals = [];
  const nanPos = [];
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (v === null || v === undefined || Number.isNaN(v)) nanPos.push(i);
    else { pos.push(i); vals.push(v); }
  }
  if (!ascending) { pos.reverse(); vals.reverse(); }
  const m = vals.length;
  const idx = new Array(m);
  for (let i = 0; i < m; i++) idx[i] = i;
  if (m > 0) sortIdx(vals, idx, m);
  const out = new Array(m);
  for (let i = 0; i < m; i++) out[i] = pos[idx[i]];
  if (!ascending) out.reverse();
  for (const p of nanPos) out.push(p);
  return out;
}

// â”€â”€ Sortierhilfen auf Record-Arrays â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/** DataFrame.sort_values(by=feld, ascending=False).head(n) */
export function sortRecordsUnstableDesc(records, field, n) {
  const order = pandasArgsort(records.map((r) => r[field]), false);
  const out = new Array(Math.min(n, order.length));
  for (let i = 0; i < out.length; i++) out[i] = records[order[i]];
  return out;
}

/** Python sorted(..., key=..., reverse=True): stabil. */
export function sortRecordsStableDesc(records, field, n) {
  const out = records.slice().sort((a, b) => {
    if (a[field] < b[field]) return 1;
    if (a[field] > b[field]) return -1;
    return 0;
  });
  return out.length > n ? out.slice(0, n) : out;
}

/** pandas lexsort_indexer: fields[0] ist der Primaerschluessel, Gleichstand = stabil. */
export function sortRecordsLexDesc(records, fields, n) {
  let out = records.slice();
  for (let k = fields.length - 1; k >= 0; k--) {
    const f = fields[k];
    out = out.map((r, i) => [r, i]).sort((x, y) => {
      const a = x[0][f], b = y[0][f];
      if (a < b) return 1;
      if (a > b) return -1;
      return x[1] - y[1];
    }).map((p) => p[0]);
  }
  return out.length > n ? out.slice(0, n) : out;
}

// â”€â”€ Frame-Erweiterung und Gruppierung â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/** Neue Ansicht mit einer zusaetzlichen Spalte (pandas: df["x"] = ...). */
export function withColumn(frame, name, data, type) {
  const cols = { ...frame.cols, [name]: new Column(name, data, type) };
  return new Frame(cols, frame.idx);
}

/** Spaltenwerte einer Ansicht - beachtet den Zeilenfilter des Frames. */
export function colValues(frame, colName) {
  const d = frame.col(colName).data;
  const rows = frame.rows();
  const out = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) out[i] = d[rows[i]];
  return out;
}

/** Gruppierung ueber eine Frame-ANSICHT mit zeilenindex-treuen Aggregationen. */
export class GroupView {
  constructor(frame, rows, codes, keyArrays) {
    this.frame = frame;
    this.rows = rows;
    this.codes = codes;
    this.keyArrays = keyArrays;
    this.nGroups = keyArrays.length;
    this.keyValues = keyArrays.length > 0 && keyArrays[0].length === 1
      ? keyArrays.map((k) => k[0])
      : null;
  }

  get size() { return this.nGroups; }

  count(colName) {
    const d = this.frame.col(colName).data;
    const out = new Int32Array(this.nGroups);
    const { rows, codes } = this;
    for (let i = 0; i < rows.length; i++) {
      const v = d[rows[i]];
      if (v === null || v === undefined || Number.isNaN(v)) continue;
      out[codes[i]]++;
    }
    return out;
  }

  sum(colName) {
    const col = this.frame.col(colName);
    const d = col.data;
    const out = new Float64Array(this.nGroups);
    const { rows, codes } = this;
    if (col.type === "b") {
      for (let i = 0; i < rows.length; i++) out[codes[i]] += d[rows[i]] ? 1 : 0;
      return out;
    }
    for (let i = 0; i < rows.length; i++) {
      const v = d[rows[i]];
      if (v === null || v === undefined || Number.isNaN(v)) continue;
      out[codes[i]] += v;
    }
    return out;
  }

  nunique(colName) {
    const d = this.frame.col(colName).data;
    const out = new Int32Array(this.nGroups);
    const seen = new Map();
    const { rows, codes } = this;
    for (let i = 0; i < rows.length; i++) {
      const v = d[rows[i]];
      if (v === null || v === undefined) continue;
      const g = codes[i];
      let set = seen.get(g);
      if (!set) { set = new Set(); seen.set(g, set); }
      set.add(v);
    }
    for (const [g, set] of seen) out[g] = set.size;
    return out;
  }

  first(colName) {
    const d = this.frame.col(colName).data;
    const out = new Array(this.nGroups).fill(null);
    const filled = new Uint8Array(this.nGroups);
    const { rows, codes } = this;
    for (let i = 0; i < rows.length; i++) {
      const g = codes[i];
      if (filled[g]) continue;
      filled[g] = 1;
      out[g] = d[rows[i]];
    }
    return out;
  }
}

/**
 * pandas groupby(cols, sort=True): Schluessel aufsteigend, beliebig viele Spalten.
 */
export function groupByCols(frame, cols) {
  const list = Array.isArray(cols) ? cols : [cols];
  const rows = frame.rows();
  const n = rows.length;
  const arrays = list.map((c) => frame.col(c).data);
  const codes = new Int32Array(n);
  const map = new Map();
  const keyByCode = [];
  for (let i = 0; i < n; i++) {
    const row = rows[i];
    const parts = new Array(arrays.length);
    const pieces = new Array(arrays.length);
    for (let k = 0; k < arrays.length; k++) {
      const v = arrays[k][row];
      parts[k] = v;
      pieces[k] = JSON.stringify(v === undefined ? null : v);
    }
    const key = pieces.join(" ");
    let code = map.get(key);
    if (code === undefined) {
      code = keyByCode.length;
      map.set(key, code);
      keyByCode.push(parts);
    }
    codes[i] = code;
  }
  const order = keyByCode.map((_, i) => i);
  order.sort((a, b) => {
    const ka = keyByCode[a], kb = keyByCode[b];
    for (let k = 0; k < ka.length; k++) {
      const av = ka[k], bv = kb[k];
      if (typeof av === "number" && typeof bv === "number") {
        if (av !== bv) return av - bv;
      } else {
        const s = String(av), t = String(bv);
        if (s !== t) return s < t ? -1 : 1;
      }
    }
    return 0;
  });
  const remap = new Map();
  order.forEach((old, nw) => remap.set(old, nw));
  for (let i = 0; i < n; i++) codes[i] = remap.get(codes[i]);
  return new GroupView(frame, rows, codes, order.map((old) => keyByCode[old]));
}

/** Anzahl verschiedener Werte einer Spalte (pandas nunique). */
export function nuniqueOf(frame, colName) {
  return groupByCols(frame, colName).size;
}

/** Summe einer Spalte ueber eine Frame-Ansicht (pandas .sum()). */
export function totalOf(frame, colName) {
  const d = frame.col(colName).data;
  const rows = frame.rows();
  let total = 0;
  for (let i = 0; i < rows.length; i++) {
    const v = d[rows[i]];
    if (v !== null && v !== undefined && !Number.isNaN(v)) total += v;
  }
  return total;
}

/** pandas mode().iloc[0]: haeufigster Wert, bei Gleichstand der kleinste. */
export function modeSmallest(values) {
  const counts = new Map();
  for (const v of values) {
    const k = v === null || v === undefined ? " null" : v;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  let best = null;
  let bestCount = -1;
  for (const [k, c] of counts) {
    if (c > bestCount || (c === bestCount && String(k) < String(best))) {
      best = k;
      bestCount = c;
    }
  }
  return best === " null" ? null : best;
}
