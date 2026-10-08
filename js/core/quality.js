/**
 * quality.js - Plausibilitaetspruefung der importierten Daten.
 *
 * Hintergrund: In Spoti fys eigenem Extended-Export stecken manchmal
 * Streams mit voellig falschem Datum. Beispiel aus einer echten Datei:
 * 9 Streams aus 2009, danach 13 Jahre nichts, dann regulaer ab 2022 -
 * alle exakt 2:25 Minuten auseinander und mit identischer ms_played pro
 * Track. Das sind keine Hoer-Sessions, sondern kaputte Zeitstempel.
 *
 * Regel (bewusst zurueckhaltend, damit echte alte Daten nicht verloren gehen):
 * Ein Jahr wird nur gestrichen, wenn
 *   1. es weit unter der Regelmaenge liegt (maximal 10 Streams bzw. 0,5 %),
 *   2. direkt danach nichts gehoert wurde (mindestens eine Luecke), und
 *   3. im naechsten befuellten Jahr tatsaechlich Streams stehen.
 * Wer 2015 bis heute durchgehend gehoert hat, verliert dadurch nichts.
 */

const MIN_ABSOLUTE = 10;       // nie weniger als 10 Streams...
const MIN_SHARE = 0.005;      // ...und nie weniger als 0,5 % aller Streams
const MIN_GAP = 2;             // mindestens ein leeres Jahr auf beiden Seiten
const MIN_TOTAL = 200;         // unterhalb dieser Menge keine Pruefung

/** Zaehlt Streams je Jahrgang. */
export function countByYear(frame) {
  const g = frame.groupBy("year");
  const counts = g.counts();
  const map = new Map();
  for (let i = 0; i < g.size; i++) {
    const y = Number(g.keyValues[i]);
    if (Number.isFinite(y)) map.set(y, counts[i]);
  }
  return map;
}

/**
 * @returns {{outliers: Array<{year:number,count:number}>, threshold:number, total:number, years:number[]}}
 */
export function findOutlierYears(frame) {
  const counts = countByYear(frame);
  const years = [...counts.keys()].sort((a, b) => a - b);
  let total = 0;
  for (const c of counts.values()) total += c;
  const threshold = Math.max(MIN_ABSOLUTE, total * MIN_SHARE);
  const outliers = [];

  if (total >= MIN_TOTAL) {
    for (let i = 0; i < years.length - 1; i++) {
      const year = years[i];
      const count = counts.get(year);
      if (count >= threshold) continue;                 // genug Masse -> plausibel
      const gapBefore = i === 0 ? Infinity : year - years[i - 1];
      const gapAfter = years[i + 1] - year;
      if (gapBefore < MIN_GAP || gapAfter < MIN_GAP) continue;  // haengt am Nachbarjahr
      outliers.push({ year, count });
    }
  }
  return { outliers, threshold: Math.round(threshold), total, years };
}

/** Fruehester noch vorhandener Jahrgang. */
export function earliestYear(frame) {
  const years = frame.col("year").data;
  let min = Infinity;
  for (let i = 0; i < years.length; i++) if (years[i] < min) min = years[i];
  return Number.isFinite(min) ? min : null;
}

/**
 * Baut ein Frame ohne die Ausreisser-Jahrgaenge. Die Gruppen-Codes der
 * Spalten (song_id_code usw.) bleiben gueltig - groupByCode() leitet seine
 * Gruppen aus den vorhandenen Codes ab, also entstehen keine leeren Gruppen.
 */
export function dropOutlierYears(frame, outliers) {
  if (!outliers || !outliers.length) return { frame, dropped: 0 };
  const bad = new Set(outliers.map((o) => o.year));
  const rows = frame.rows();
  const yearData = frame.col("year").data;
  const keep = [];
  for (let i = 0; i < rows.length; i++) {
    if (!bad.has(yearData[rows[i]])) keep.push(rows[i]);
  }
  return { frame: frame.sliceRows(keep), dropped: rows.length - keep.length };
}

/** Kurzfassung fuer die Anzeige. */
export function describeQuality(report) {
  if (!report || !report.outliers || !report.outliers.length) return null;
  const years = report.outliers.map((o) => `${o.year} (${o.count})`).join(", ");
  return `Auffällige Zeitstempel aus ${report.outliers.length} Jahrgang${report.outliers.length === 1 ? "" : "en"} wurden ausgeschlossen: ${years}`;
}
