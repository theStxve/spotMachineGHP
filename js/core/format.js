/**
 * format.js - Datums-/Zahlformatierung.
 *
 * WICHTIG: Alle Zeitstempel werden in UTC verarbeitet, weil Python
 * pd.to_datetime(..., utc=True) und danach .dt.hour / .dt.strftime benutzt.
 * Wer hier lokal rechnet, bekommt bei Streams in der Nacht andere Stunden.
 * Monatsnamen sind fest auf Englisch, um Python-C-Locale zu entsprechen.
 */

export const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const MONTH_LONG = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

const pad2 = (n) => (n < 10 ? "0" + n : String(n));

/** "20.03.2024" */
export function fmtDate(ms) {
  const d = new Date(ms);
  return pad2(d.getUTCDate()) + "." + pad2(d.getUTCMonth() + 1) + "." + d.getUTCFullYear();
}

/** "14:05 Uhr" */
export function fmtTime(ms) {
  const d = new Date(ms);
  return pad2(d.getUTCHours()) + ":" + pad2(d.getUTCMinutes()) + " Uhr";
}

/** "20.03.2024 um 14:05:07 Uhr" */
export function fmtDateTimeSec(ms) {
  const d = new Date(ms);
  return fmtDate(ms) + " um " + pad2(d.getUTCHours()) + ":" +
    pad2(d.getUTCMinutes()) + ":" + pad2(d.getUTCSeconds()) + " Uhr";
}

/** "2024-03" */
export function fmtYearMonth(ms) {
  const d = new Date(ms);
  return d.getUTCFullYear() + "-" + pad2(d.getUTCMonth() + 1);
}

/** "2024-03-20" */
export function fmtISODate(ms) {
  const d = new Date(ms);
  return d.getUTCFullYear() + "-" + pad2(d.getUTCMonth() + 1) + "-" + pad2(d.getUTCDate());
}

/** "2024-03-20T14:05:07Z" */
export function fmtISOStamp(ms) {
  const d = new Date(ms);
  return fmtISODate(ms) + "T" + pad2(d.getUTCHours()) + ":" +
    pad2(d.getUTCMinutes()) + ":" + pad2(d.getUTCSeconds()) + "Z";
}

/** Python round(): kaufmaennisch, nicht "half away from zero" wie Math.round. */
export function roundHalfEven(value, digits = 0) {
  const factor = Math.pow(10, digits);
  const scaled = value * factor;
  const r = Math.round(scaled);
  // Math.round(x) = floor(x + 0.5) und bricht bei .5 immer auf. Python
  // round() geht bei .5 auf die gerade Zahl. Wir korrigieren nur den
  // Randfall, in dem ourzeilig .5 auftritt.
  let out;
  if (Number.isFinite(scaled) && Math.abs(scaled % 1) !== 0.5) {
    out = r;
  } else {
    out = Math.floor(scaled);
    const diff = scaled - Math.floor(scaled);
    if (diff > 0.5) out = Math.floor(scaled) + 1;
    else if (diff === 0.5) out = Math.floor(scaled) % 2 === 0 ? Math.floor(scaled) : Math.floor(scaled) + 1;
  }
  return out / factor;
}

/** Python round(x, 1) - eine Nachkommastelle. */
export function round1(value) {
  return roundHalfEven(value, 1);
}

/** ISO-Wochentag 0=Montag .. 6=Sonntag (pandas dayofweek). */
export function weekdayUTC(ms) {
  const day = new Date(ms).getUTCDay();       // 0=Sonntag
  return (day + 6) % 7;                        // -> 0=Montag
}

/** Ganze Tage seit 1970-01-01 (fuer Streak-Berechnung). */
export function dayNumber(ms) {
  return Math.floor(ms / 86400000);
}

/** Number(value, digits) wie Python - nicht-parsebare Werte werden NaN. */
export function num(value, fallback = 0) {
  if (value === null || value === undefined || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
