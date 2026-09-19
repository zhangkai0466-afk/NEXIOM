// Preferences are optional. Storage restrictions must not prevent the UI from mounting.
const fallback = new Map<string, string>();
export function readPreference(key: string): string | null {
  if (fallback.has(key)) return fallback.get(key)!;
  try { return localStorage.getItem(key) ?? fallback.get(key) ?? null; }
  catch { return fallback.get(key) ?? null; }
}
export function writePreference(key: string, value: string): void {
  fallback.set(key, value);
  try { localStorage.setItem(key, value); fallback.delete(key); }
  catch { /* Keep the preference in memory for this session. */ }
}
export function removePreference(key: string): void {
  fallback.delete(key);
  try { localStorage.removeItem(key); }
  catch { /* The in-memory value has still been cleared. */ }
}
