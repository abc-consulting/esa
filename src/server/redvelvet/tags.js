'use strict';

const { fetchText, send } = require('../utils/http');
const { stripTags, decodeHtmlEntities } = require('../utils/html');
const { normalizeTagName } = require('../utils/normalize');
const { REDVELVET_TAGS_URL, AREA_MAP_CACHE_TTL_MS } = require('../constants');
const { URL } = require('url');

let tagMapCache = null;
let tagMapCacheTime = 0;

async function buildRedvelvetTagHashMap() {
  if (tagMapCache && Date.now() - tagMapCacheTime < AREA_MAP_CACHE_TTL_MS) {
    return tagMapCache;
  }

  try {
    const html = await fetchText(REDVELVET_TAGS_URL);
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
      if (pathname === '/escorts/fetish_escorts' && !parsed.search && normalizeTagName(label) === 'all tags') continue;

      const key = normalizeTagName(label);
      if (!key || map.has(key)) continue;

      map.set(key, {
        label,
        url: parsed.toString(),
        count,
      });
    }

    tagMapCache = map;
    tagMapCacheTime = Date.now();
    console.log(`[INFO] Built RedVelvet tag hash map with ${map.size} keys`);
    return map;
  } catch (err) {
    console.error('[ERROR] Failed to build RedVelvet tag hash map:', err.message);
    return new Map();
  }
}

async function resolveRedvelvetTagUrl(tag, tagUrl = '') {
  const direct = String(tagUrl || '').trim();
  if (/^https?:\/\/.*\/escorts\/fetish_escorts/i.test(direct)) {
    return direct;
  }

  const normalizedTag = normalizeTagName(tag);
  if (!normalizedTag) return '';

  const map = await buildRedvelvetTagHashMap();
  const exact = map.get(normalizedTag);
  if (exact?.url) return exact.url;

  for (const [key, value] of map.entries()) {
    if (key.includes(normalizedTag) || normalizedTag.includes(key)) {
      return value.url;
    }
  }

  return '';
}

async function handleRedvelvetTags(req, res) {
  try {
    const tagMap = await buildRedvelvetTagHashMap();
    const tags = Array.from(tagMap.values())
      .sort((a, b) => a.label.localeCompare(b.label));

    send(res, 200, JSON.stringify({
      count: tags.length,
      tags,
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
  buildRedvelvetTagHashMap,
  resolveRedvelvetTagUrl,
  handleRedvelvetTags,
};
