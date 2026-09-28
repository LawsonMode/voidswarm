// Safe localStorage wrappers — storage may be unavailable (private mode, blocked site data).

export function loadStr(key: string): string | null {
  try { return globalThis.localStorage?.getItem(key) ?? null; } catch { return null; }
}

export function saveStr(key: string, value: string): void {
  try { globalThis.localStorage?.setItem(key, value); } catch { /* ignore */ }
}

export function loadJSON<T>(key: string, fallback: T): T {
  const s = loadStr(key);
  if (!s) return fallback;
  try {
    const v = JSON.parse(s);
    if (v && typeof v === 'object' && fallback && typeof fallback === 'object') return { ...fallback, ...v };
    return (v as T) ?? fallback;
  } catch { return fallback; }
}

export function saveJSON(key: string, value: unknown): void {
  try { saveStr(key, JSON.stringify(value)); } catch { /* ignore */ }
}
