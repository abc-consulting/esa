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

export function normalizeGalleryImageUrl(url) {
  if (!url) return '';

  // Attributes from HTML can contain encoded ampersands.
  let normalized = url.replace(/&amp;/gi, '&').trim();
  if (!normalized) return '';

  if (/\/client\/gallery\/srv\.php/i.test(normalized)) {
    if (/[?&]size=thumb_blur\b/i.test(normalized)) {
      normalized = normalized.replace(/([?&]size=)thumb_blur\b/i, '$1medium');
    } else if (!/[?&]size=/i.test(normalized)) {
      normalized += (normalized.includes('?') ? '&' : '?') + 'size=medium';
    }
  }

  return normalized;
}

export function getProfileUrlByProvider(provider, uid) {
  if (provider === 'redvelvet') {
    return `${REDVELVET_BASE_URL}/escorts/escorts_details.aspx?userid=${encodeURIComponent(uid)}`;
  }
  return `${BASE_URL}/escorts/viewEscort.php?uid=${encodeURIComponent(uid)}`;
}

export function extractGalleryUrlsFromHtml(html) {
  if (!html) return [];

  const found = new Set();
  const patterns = [
    /https?:\/\/userfiles\.esa\.co\.za\/client\/gallery\/srv\.php\?[^"'\s<)]+/gi,
    /https?:\\\/\\\/userfiles\.esa\.co\.za\\\/client\\\/gallery\\\/srv\.php\?[^"'\s<)]+/gi,
    /\/client\/gallery\/srv\.php\?[^"'\s<)]+/gi,
  ];

  patterns.forEach(pattern => {
    const matches = html.match(pattern) || [];
    matches.forEach(match => {
      let candidate = match.replace(/\\\//g, '/');
      if (candidate.startsWith('/client/gallery/srv.php')) {
        candidate = `https://userfiles.esa.co.za${candidate}`;
      }

      const normalized = normalizeGalleryImageUrl(candidate);
      if (/\/client\/gallery\/srv\.php/i.test(normalized)) {
        found.add(normalized);
      }
    });
  });

  return Array.from(found);
}

export function extractSubIdsFromHtml(html) {
  if (!html) return [];

  const found = new Set();
  const patterns = [
    /(?:[?&]|\b)(?:subid|picset_id|picsetid)=(\d{4,})/gi,
    /(?:subid|picset_id|picsetid)%3D(\d{4,})/gi,
    /["'](?:subid|picset_id|picsetid)["']\s*:\s*["']?(\d{4,})/gi,
  ];

  patterns.forEach(pattern => {
    let match;
    while ((match = pattern.exec(html)) !== null) {
      found.add(match[1]);
    }
  });

  return Array.from(found);
}

export function extractPicNum(src) {
  if (!src) return null;
  const normalized = src.replace(/&amp;/gi, '&').trim();
  const match = normalized.match(/[?&]picnum=(\d+)/i);
  return match ? Number(match[1]) : null;
}
