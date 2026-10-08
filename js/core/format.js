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

/**
 * Zerlegt einen double in die exakte Form m * 2^e (m ganzzahlig).
 * Nur so laesst sich ein double exakt gegen eine Dezimalmitte vergleichen.
 */
function doubleParts(x) {
  const buf = new DataView(new ArrayBuffer(8));
  buf.setFloat64(0, x);
  const hi = buf.getUint32(0);
  const lo = buf.getUint32(4);
  const expBits = (hi >>> 20) & 0x7ff;
  let mantissa = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  if (expBits === 0) return { m: mantissa, e: -1074 };          // Subnormal
  return { m: mantissa | (1n << 52n), e: expBits - 1075 };
}

/**
 * Python round(): kaufmaennisch (half to even), entschieden anhand des
 * EXAKTEN Binärwerts.
 *
 * Warum das so aufwendig ist: das double 4.35 ist in Wahrheit
 * 4.34999999999999964. Ein doppeltes * 10 ergibt exakt 43.5 und verliert
 * damit die Information "eigentlich unter der Mitte". Wer auf 43.5 rundet,
 * landet bei 4.4 - Python dagegen bei 4.3. Der Vergleich laeuft deshalb in
 * BigInt gegen die exakte Mitte.
 */
export function roundHalfEven(value, digits = 0) {
  if (!Number.isFinite(value)) return value;
  const factor = Math.pow(10, digits);
  const sign = value < 0 ? -1 : 1;
  const abs = Math.abs(value);

  const { m, e } = doubleParts(abs);
  // abs gegen (floor + 0.5) vergleichen:
  //   abs * factor * 2  ?  2 * floor + 1
  // Bei negativem Exponenten muss der Faktor auf die andere Seite wandern -
  // BigInt erlaubt keine negativen Shift-Zaehler.
  const floor = Math.floor(abs * factor);
  const right = 2n * BigInt(floor) + 1n;
  const scaled = m * BigInt(factor);
  const k = e + 1;
  let lhs, rhs;
  if (k >= 0) {
    lhs = scaled << BigInt(k);
    rhs = right;
  } else {
    lhs = scaled;
    rhs = right << BigInt(-k);
  }

  let rounded;
  if (lhs > rhs) rounded = floor + 1;
  else if (lhs < rhs) rounded = floor;
  else rounded = floor % 2 === 0 ? floor : floor + 1;   // exakt auf der Mitte
  return (sign * rounded) / factor;
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
