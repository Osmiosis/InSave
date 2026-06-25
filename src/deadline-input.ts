// Converts a native <input type="date"> value ("YYYY-MM-DD") to a local
// start-of-day epoch (ms), or null for empty/malformed/impossible input.
// Local midnight so a picked "Jul 3" drives the item due at the start of Jul 3
// in the user's own timezone (the digest/quiet-hours gate the notification time).
export function dateInputToEpoch(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const y = Number(m[1]);
  const mon = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(y, mon - 1, d);
  // Reject overflow (e.g. 2026-02-31 rolls forward into March).
  if (dt.getFullYear() !== y || dt.getMonth() !== mon - 1 || dt.getDate() !== d) {
    return null;
  }
  return dt.getTime();
}
