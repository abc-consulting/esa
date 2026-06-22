import { BASE_URL, REDVELVET_BASE_URL } from './config.js';

export function extractUidFromUrl(url) {
  if (!url) return '';
  const match = String(url).match(/[?&]uid=(\d+)|\/(\d+)(?:\/?$)/i);
  if (!match) return '';
  return match[1] || match[2] || '';
}

/**
 * Extract a subId from an image src string.
 * Tries several URL patterns used by ESA:
 *   1. ?subid=123 or &subid=123
 *   2. ?picset_id=123
 *   3. Picset-like numeric path segment in known image paths
 *
 * Note: profile uid is not a reliable picset subId and must be ignored.
 */
export function extractSubId(src) {
  if (!src) return null;

  const normalized = src.replace(/&amp;/gi, '&').trim();

  const explicitMatch = normalized.match(/[?&](subid|picset_id|picsetid)=(\d+)/i);
  if (explicitMatch) {
    return explicitMatch[2];
  }

  // Only allow a path-based numeric fallback for known picset image hosts/paths.
  if (/picserver\.php/i.test(normalized) || /\/picsets?\//i.test(normalized)) {
    const pathMatch = normalized.match(/\/(\d{4,})(?:[\/\.]|$)/);
    if (pathMatch) return pathMatch[1];
  }

  return null;
}


export function getProfileUrlByProvider(provider, uid) {
  if (provider === 'redvelvet') {
    return `${REDVELVET_BASE_URL}/escorts/escorts_details.aspx?userid=${encodeURIComponent(uid)}`;
  }
  return `${BASE_URL}/escorts/viewEscort.php?uid=${encodeURIComponent(uid)}`;
}


export function extractPicNum(src) {
  if (!src) return null;
  const normalized = src.replace(/&amp;/gi, '&').trim();
  const match = normalized.match(/[?&]picnum=(\d+)/i);
  return match ? Number(match[1]) : null;
}
