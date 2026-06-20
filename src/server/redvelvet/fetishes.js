'use strict';

const { fetchText, send } = require('../utils/http');
const { stripTags, decodeHtmlEntities } = require('../utils/html');
const { normalizeFetishName } = require('../utils/normalize');
const { REDVELVET_FETISHES_URL, AREA_MAP_CACHE_TTL_MS } = require('../constants');
const { URL } = require('url');

let fetishMapCache = null;
let fetishMapCacheTime = 0;

async function buildRedvelvetFetishHashMap() {
  if (fetishMapCache && Date.now() - fetishMapCacheTime < AREA_MAP_CACHE_TTL_MS) {
    return fetishMapCache;
  }

  try {
    const html = await fetchText(REDVELVET_FETISHES_URL);
    const map = new Map();
    const optionPattern = /<option\b[^>]*value="([^"]*\/escorts\/fetish_escorts[^"]*)"[^>]*>([\s\S]*?)<\/option>/gi;
    let match;

    while ((match = optionPattern.exec(html)) !== null) {
      const href = match[1] || '';
      const innerHtml = match[2] || '';
      const rawText = decodeHtmlEntities(stripTags(innerHtml)).replace(/\s+/g, ' ').trim();
      const label = rawText.replace(/\s*\(\d+\)\s*$/g, '').trim();
      const countMatch = rawText.match(/\((\d+)\)\s*$/);
      const count = countMatch ? Number(countMatch[1]) : null;
      if (!label) continue;

      let parsed;
      try {
        parsed = new URL(href, 'https://redvelvet.co.za');
      } catch {
        continue;
      }

      const pathname = parsed.pathname.toLowerCase();
      if (pathname === '/escorts/fetish_escorts' && !parsed.search && normalizeFetishName(label) === 'all fetishes') continue;

      const key = normalizeFetishName(label);
      if (!key || map.has(key)) continue;

      map.set(key, {
        label,
        url: parsed.toString(),
        count,
      });
    }

    fetishMapCache = map;
    fetishMapCacheTime = Date.now();
    console.log(`[INFO] Built RedVelvet fetish hash map with ${map.size} keys`);
    return map;
  } catch (err) {
    console.error('[ERROR] Failed to build RedVelvet fetish hash map:', err.message);
    return new Map();
  }
}

async function resolveRedvelvetFetishUrl(tag, tagUrl = '') {
  const direct = String(tagUrl || '').trim();
  if (/^https?:\/\/.*\/escorts\/fetish_escorts/i.test(direct)) {
    return direct;
  }

  const normalizedTag = normalizeFetishName(tag);
  if (!normalizedTag) return '';

  const map = await buildRedvelvetFetishHashMap();
  const exact = map.get(normalizedTag);
  if (exact?.url) return exact.url;

  for (const [key, value] of map.entries()) {
    if (key.includes(normalizedTag) || normalizedTag.includes(key)) {
      return value.url;
    }
  }

  return '';
}

async function handleRedvelvetFetishes(req, res) {
  try {
    const fetishMap = await buildRedvelvetFetishHashMap();
    const fetishes = Array.from(fetishMap.values())
      .sort((a, b) => a.label.localeCompare(b.label));

    send(res, 200, JSON.stringify({
      count: fetishes.length,
      fetishes,
    }), {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    });
  } catch (err) {
    send(res, 502, JSON.stringify({ error: err.message }), {
      'Content-Type': 'application/json; charset=utf-8',
    });
  }
}

module.exports = {
  buildRedvelvetFetishHashMap,
  resolveRedvelvetFetishUrl,
  handleRedvelvetFetishes,
};
