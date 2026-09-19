/** Grammar is deliberately independent of the language model. */
export function parseRating(raw: string): number|null {
  const text = raw.normalize('NFC').replace(/\s/gu, ' ').trim();
  if (/[^0-9]\p{Nd}|\p{Nd}[^0-9]/u.test(text.replace(/[0-9]/g,'')) || /[\p{N}]/u.test(text.replace(/[0-9]/g,''))) return null;
  if (/[+\-−–—]\s*\d|\d\s*[-−–—/+]|\d[.,]\d|\d\s*[.,/]\s*\d|\d[eE][+-]?\d/u.test(text)) return null;
  const matches = [...text.matchAll(/[0-9]+/g)];
  if (matches.length !== 1) return null;
  const match = matches[0]; const start = match.index!; const end = start + match[0].length;
  if (/[\p{L}\p{N}_]/u.test(text[start-1] ?? '') || /[\p{L}\p{N}_]/u.test(text[end] ?? '')) return null;
  return /^(?:[1-9]|10)$/.test(match[0]) ? Number(match[0]) : null;
}
