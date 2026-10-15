/** @param {unknown} value */
export function errorMessage(value) {
  let raw = value instanceof Error ? value.message : String(value);
  // The wrapper can nest: stringifying the rejection gives
  // `Error: Error invoking remote method 'x': Error: <message>`.
  for (let round = 0; round < 4; round++) {
    const next = raw
      .replace(/^[A-Za-z]*Error:\s*/, '')
      .replace(/^Error invoking remote method '[^']*':\s*/, '');
    if (next === raw) break;
    raw = next;
  }
  return raw.trim();
}
