/**
 * pandas_helpers.js - Bausteine, damit der Port aus recommender_core.py
 * mechanisch bleibt. Hier steckt die pandas-Semantik, die in
 * recommender_core.py immer wieder vorkommt:
 *
 *   df.groupby(keys).agg(...)  ->  groupAgg(frame, keys, aggs)
 *   .sort_values(by)           ->  sortRecords
 *   .head(n)                   ->  sliceRecords
 *   .round(1)                  ->  round1 (format.js)
 *   .drop_duplicates(subset)   ->  dedupeBy
 *   .nunique()                 ->  countDistinct
 *   .to_dict("records")        ->  records (fertiges Array)
 */

import { round1, roundHalfEven } from "./format.js";

/** Rundet wie Python round(value, digits). */
export function roundTo(value, digits = 0) {
  return roundHalfEven(value, digits);
}


/**
 * groupby(...).agg(...) in einer Stufe.
 *
 * @param {Frame} frame
 * @param {string[]} keyCols
 * @param {Object} aggs  { outName: "count" | {fn, col} }
 *        fn: count | sum | first | last | nunique | mean | max | min
 * @returns {{n:number, keys:Array, keys2d:Array<Array>, out:Object<string,Array>}}
 */
export function groupAgg(frame, keyCols, aggs, opts = {}) {
  const g = frame.groupBy(keyCols, opts);
  const out = {};
  for (const [name, spec] of Object.entries(aggs)) {
    const fn = typeof spec === "string" ? spec : spec.fn;
    const col = typeof spec === "string" ? null : spec.col;
    switch (fn) {
      case "count": out[name] = g.count(col || "ts"); break;
      case "sum": out[name] = g.sum(col); break;
      case "mean": out[name] = g.mean(col); break;
      case "first": out[name] = g.first(col); break;
      case "last": out[name] = g.last(col); break;
      case "nunique": out[name] = g.nunique(col); break;
      case "max": out[name] = g.max(col); break;
      case "min": out[name] = g.min(col); break;
      default: throw new Error("Unbekannte agg: " + fn);
    }
  }
  return { n: g.size, keys: g.keyValues, keys2d: g.keyArrays, out };
}

/**
 * Macht aus einem groupAgg-Ernis ein Array von Objekten.
 * @param {string[]} keyCols  Namen, unter denen die Schluessel im Record landen
 * @param {Object} rename     { outName: recordName } optional
 */
export function toRecords(g, keyCols, rename = null) {
  const total = g.n;
  const recs = new Array(total);
  const multi = g.keys2d !== null && g.keys2d !== undefined;
  for (let i = 0; i < total; i++) {
    const rec = {};
    if (multi) {
      for (let k = 0; k < keyCols.length; k++) rec[keyCols[k]] = g.keys2d[i][k];
    } else {
      rec[keyCols[0]] = g.keys[i];
    }
    for (const [name, values] of Object.entries(g.out)) {
      rec[rename && rename[name] ? rename[name] : name] = values[i];
    }
    recs[i] = rec;
  }
  return recs;
}

/**
 * Stabile Sortierung nach mehreren Spalten.
 * @param {Array} records
 * @param {Array<[string, boolean]>} specs [feld, aufsteigend]
 */
export function sortRecords(records, specs) {
  const arr = records.slice();
  arr.sort((a, b) => {
    for (const [field, asc] of specs) {
      const av = a[field];
      const bv = b[field];
      if (av < bv) return asc ? -1 : 1;
      if (av > bv) return asc ? 1 : -1;
    }
    return 0;
  });
  return arr;
}

/** head(n) auf einem Record-Array. */
export function headRecords(records, n) {
  return records.length > n ? records.slice(0, n) : records;
}

/**
 * pandas sort_values(...).head(n) in einem Aufruf.
 * @param {Array<[string, boolean]>} specs
 */
export function sortHead(records, specs, n) {
  return headRecords(sortRecords(records, specs), n);
}

/** pandas drop_duplicates(subset=[col]) - behält das erste Vorkommen. */
export function dedupeBy(records, col) {
  const seen = new Set();
  const out = [];
  for (const r of records) {
    const k = r[col];
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

/** pandas nunique() auf einer Spalte eines Frames. */
export function countDistinct(frame, colName) {
  return frame.groupBy(colName).size;
}

/** Summe einer Spalte über eine Frame-Ansicht. */
export function sumCol(frame, colName) {
  const d = frame.col(colName).data;
  const r = frame.rows();
  let total = 0;
  for (let i = 0; i < r.length; i++) {
    const v = d[r[i]];
    if (v !== null && v !== undefined && !Number.isNaN(v)) total += v;
  }
  return total;
}

/** Min-Max-Normalisierung wie _norm() in recommender_core.py. */
export function normalizeSeries(values) {
  let mn = Infinity;
  let mx = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  const n = values.length;
  const out = new Float64Array(n);
  if (mx === mn) {
    out.fill(0.5);
    return out;
  }
  for (let i = 0; i < n; i++) out[i] = (values[i] - mn) / (mx - mn);
  return out;
}

/** log1p wie numpy. */
export function log1pArray(values) {
  const out = new Float64Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = Math.log1p(values[i]);
  return out;
}

/** Set aus einer Frame-Spalte (pandas .unique()). */
export function uniqueSet(frame, colName) {
  const d = frame.col(colName).data;
  const r = frame.rows();
  const set = new Set();
  for (let i = 0; i < r.length; i++) {
    const v = d[r[i]];
    if (v !== null && v !== undefined) set.add(v);
  }
  return set;
}

/** Minuten auf eine Nachkommastelle - haeufigster rounding-Fall. */
export function round1Field(records, field) {
  for (const r of records) r[field] = round1(r[field]);
  return records;
}

/** Wie oben, nur direkt auf einem Werte-Array (fuer JSON-Ausgaben). */
export function roundAll(values, digits = 1) {
  const out = new Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = roundTo(values[i], digits);
  return out;
}
