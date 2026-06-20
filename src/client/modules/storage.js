import { STORAGE_KEYS } from './config.js';

export function parseJsonStorage(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function writeJsonStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore storage failures (private mode/quota).
  }
}

export function getStorageScopedValue(map, provider) {
  if (!map || typeof map !== 'object') return null;
  return map[provider] ?? null;
}

export function setStorageScopedValue(key, provider, value) {
  const map = parseJsonStorage(key, {});
  const next = { ...(map && typeof map === 'object' ? map : {}) };
  next[provider] = value;
  writeJsonStorage(key, next);
}

export function readSelectedProvider() {
  const provider = localStorage.getItem(STORAGE_KEYS.provider);
  return provider === 'redvelvet' ? 'redvelvet' : 'esa';
}

export function saveSelectedProviderToStorage(provider) {
  localStorage.setItem(STORAGE_KEYS.provider, provider);
}
