export function shannonEntropy(s: string): number {
  if (s.length === 0) {
    return 0;
  }
  const freq = new Map<string, number>();
  for (const ch of s) {
    freq.set(ch, (freq.get(ch) ?? 0) + 1);
  }
  let entropy = 0;
  const len = s.length;
  for (const count of freq.values()) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

const LOWERCASE_RE = /[a-z]/;
const UPPERCASE_RE = /[A-Z]/;
const DIGIT_RE = /[0-9]/;
const SYMBOL_RE = /[^a-zA-Z0-9]/;

export function charsetClasses(s: string): number {
  let classes = 0;
  if (LOWERCASE_RE.test(s)) classes += 1;
  if (UPPERCASE_RE.test(s)) classes += 1;
  if (DIGIT_RE.test(s)) classes += 1;
  if (SYMBOL_RE.test(s)) classes += 1;
  return classes;
}
