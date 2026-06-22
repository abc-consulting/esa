'use strict';

const { fetchText, send } = require('../utils/http');
const { extractHiddenFields, extractDataPagerTargets } = require('../utils/html');
const { normalizeAreaName } = require('../utils/normalize');
const { REDVELVET_AREAS_URL, AREA_MAP_CACHE_TTL_MS } = require('../constants');
const { URL } = require('url');
const { groupProfilesByPhone } = require('../utils/groups');

let areaMapCache = null;
let areaMapCacheTime = 0;
const areaProfileListCache = new Map(); // normalizedAreaName → { profiles, areaUrl, fetchedAt }

async function buildRedvelvetAreaHashMap() {
  if (areaMapCache && Date.now() - areaMapCacheTime < AREA_MAP_CACHE_TTL_MS) {
    return areaMapCache;
  }

  try {
    const html = await fetchText(REDVELVET_AREAS_URL);
    const map = new Map();

    const routePattern = /\/escorts\/escorts_in_area\/([^/"'<>\s]+)\/(\d+)\/(\d+)/gi;
    let match;

    while ((match = routePattern.exec(html)) !== null) {
      const areaSlug = match[1] || '';
      const areaId = match[2] || '';
      const cityBucket = match[3] || '';
      const areaName = normalizeAreaName(areaSlug);

      if (!areaName || !areaId || !cityBucket) continue;

      const entries = map.get(areaName) || [];
      const duplicate = entries.some(
        (entry) => entry.areaId === areaId && entry.cityBucket === cityBucket,
      );
      if (duplicate) continue;

      entries.push({
        name: areaName,
        areaId,
        cityBucket,
        url: `https://redvelvet.co.za/escorts/escorts_in_area/${areaSlug}/${areaId}/${cityBucket}`,
      });
      map.set(areaName, entries);
    }

    areaMapCache = map;
    areaMapCacheTime = Date.now();
    console.log(`[INFO] Built RedVelvet area hash map with ${map.size} keys`);
    return map;
  } catch (err) {
    console.error('[ERROR] Failed to build RedVelvet area hash map:', err.message);
    return new Map();
  }
}

function chooseAreaEntry(entries, preferredCityBucket = '2') {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const preferred = entries.find((entry) => entry.cityBucket === preferredCityBucket);
  return preferred || entries[0];
}

function findAreaEntryByName(areaMap, rawName, preferredCityBucket = '2') {
  const normalizedName = normalizeAreaName(rawName);
  if (!normalizedName) return null;

  const exact = chooseAreaEntry(areaMap.get(normalizedName), preferredCityBucket);
  if (exact) return exact;

  const suffixCleaned = normalizedName
    .replace(/\b(western cape|cape town|south africa)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (suffixCleaned) {
    const cleanedExact = chooseAreaEntry(areaMap.get(suffixCleaned), preferredCityBucket);
    if (cleanedExact) return cleanedExact;
  }

  let bestMatchKey = '';
  for (const key of areaMap.keys()) {
    if (normalizedName.startsWith(`${key} `) || key.startsWith(`${normalizedName} `)) {
      if (key.length > bestMatchKey.length) bestMatchKey = key;
    }
  }

  if (bestMatchKey) {
    return chooseAreaEntry(areaMap.get(bestMatchKey), preferredCityBucket);
  }

  return null;
}

async function getAreaSetForCityBucket(cityBucket = '2') {
  const map = await buildRedvelvetAreaHashMap();
  const areaSet = new Set();

  for (const [areaName, entries] of map.entries()) {
    if (!Array.isArray(entries) || entries.length === 0) continue;
    if (!cityBucket) {
      areaSet.add(areaName);
      continue;
    }
    const inBucket = entries.some((entry) => String(entry.cityBucket) === String(cityBucket));
    if (inBucket) areaSet.add(areaName);
  }

  return areaSet;
}

function filterProfilesByCityBucket(profiles, areaSet, areaMap = null) {
  if (!(areaSet instanceof Set) || areaSet.size === 0) return profiles;
  return profiles.filter((profile) => {
    const normalized = normalizeAreaName(profile?.area || '');
    if (!normalized) return true; // no area info — include rather than drop
    // Exact match in target bucket
    if (areaSet.has(normalized)) return true;
    // Partial match in target bucket
    for (const known of areaSet) {
      if (normalized.startsWith(known) || known.startsWith(normalized)) return true;
    }
    // If area map available, check if this area is known to belong to a different city bucket
    // If it's known-elsewhere → exclude; if unknown → include (tag page is already city-scoped)
    if (areaMap instanceof Map) {
      for (const [key, entries] of areaMap.entries()) {
        if (normalized === key || normalized.startsWith(key) || key.startsWith(normalized)) {
          // Found in map — it's a known area belonging to a different bucket, exclude it
          return false;
        }
      }
    }
    // Area not in hashmap at all — include (unknown suburb, assume correct city)
    return true;
  });
}

function decodePlusSegment(value) {
  return decodeURIComponent(String(value || '')).replace(/\+/g, ' ').trim();
}

function parseRedvelvetProfileFromHref(href, fallbackName = '') {
  const absolute = href.startsWith('http') ? href : `https://redvelvet.co.za${href}`;

  // Slug-based URL: /escorts/escorts_details/Name/Area/UID
  const slugMatch = absolute.match(/\/escorts\/escorts_details\/([^/]+)\/([^/]+)\/(\d+)(?:\/|$)/i);
  if (slugMatch) {
    return {
      uid: slugMatch[3],
      name: decodePlusSegment(slugMatch[1]),
      area: decodePlusSegment(slugMatch[2]),
      profileUrl: absolute,
    };
  }

  // Query-string URL: escorts_details.aspx?userid=12345
  const qsMatch = absolute.match(/escorts_details\.aspx\?.*userid=(\d+)/i);
  if (qsMatch) {
    return {
      uid: qsMatch[1],
      name: fallbackName || `Profile ${qsMatch[1]}`,
      area: '',
      profileUrl: absolute,
    };
  }

  return null;
}

function parseRedvelvetAreaProfiles(html) {
  const profiles = [];
  const byUid = new Set();

  // Split into per-profile card blocks using the image-container div as the boundary
  // Each profile card starts with class="image-container"
  const cardSplitRe = /(?=<div\b[^>]*class="image-container")/gi;
  const blocks = html.split(cardSplitRe);

  for (const block of blocks) {
    // Extract profile URL from the first escorts_details anchor
    const hrefMatch = block.match(/href="([^"]*\/escorts\/escorts_details[^"#]+)"/i);
    if (!hrefMatch) continue;

    const parsed = parseRedvelvetProfileFromHref(hrefMatch[1]);
    if (!parsed) continue;

    const uidKey = String(parsed.uid || '').trim();
    if (!uidKey || byUid.has(uidKey)) continue;
    byUid.add(uidKey);

    const imgMatch = block.match(/<img\b[^>]*src="([^"]+)"/i);
    const thumbUrl = imgMatch
      ? new URL(imgMatch[1], 'https://redvelvet.co.za/').href
      : '';

    const phoneMatch = block.match(/cellNumberLabel[^>]*>([^<]+)</i);
    const phone = phoneMatch ? phoneMatch[1].trim() : '';

    profiles.push({
      provider: 'redvelvet',
      ...parsed,
      thumbUrl,
      phone,
    });
  }

  return profiles;
}

async function fetchRedvelvetProfilesWithPostback(startUrl) {
  const byUid = new Map();
  const seenTargets = new Set();

  const pushProfilesFromHtml = (html) => {
    parseRedvelvetAreaProfiles(html).forEach((profile) => {
      const key = String(profile.uid || '').trim();
      if (!key || byUid.has(key)) return;
      byUid.set(key, profile);
    });
  };

  const firstHtml = await fetch(startUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  }).then((r) => r.text());
  pushProfilesFromHtml(firstHtml);

  const NEXT_BUTTON_SUFFIX = /DataPager\d*\$ctl02\$ctl00$/i;
  const MAX_POSTBACK_PAGES = 50;
  let currentHtml = firstHtml;
  let traversed = 0;

  while (traversed < MAX_POSTBACK_PAGES) {
    const allTargets = extractDataPagerTargets(currentHtml);
    const target = allTargets.find(t => NEXT_BUTTON_SUFFIX.test(t));
    if (!target) break;
    seenTargets.add(target);
    traversed += 1;

    const fields = extractHiddenFields(currentHtml);
    const body = new URLSearchParams(fields);
    body.set('__EVENTTARGET', target);
    body.set('__EVENTARGUMENT', '');

    let response;
    try {
      response = await fetch(startUrl, {
        method: 'POST',
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      });
    } catch {
      break;
    }

    if (!response.ok) break;
    const html = await response.text();
    if (!html) break;

    pushProfilesFromHtml(html);
    currentHtml = html;
  }

  return Array.from(byUid.values());
}

async function getRedvelvetAreaProfiles(areaName, preferredCityBucket = '2') {
  const normalizedArea = normalizeAreaName(areaName);
  if (!normalizedArea) return { areaUrl: '', profiles: [] };

  const cached = areaProfileListCache.get(normalizedArea);
  if (cached && Date.now() - cached.fetchedAt < AREA_MAP_CACHE_TTL_MS) {
    return { areaUrl: cached.areaUrl, profiles: cached.profiles };
  }

  const areaMap = await buildRedvelvetAreaHashMap();
  const areaEntry = findAreaEntryByName(areaMap, normalizedArea, preferredCityBucket);
  if (!areaEntry) return { areaUrl: '', profiles: [] };

  const profiles = await fetchRedvelvetProfilesWithPostback(areaEntry.url);
  areaProfileListCache.set(normalizedArea, { profiles, areaUrl: areaEntry.url, fetchedAt: Date.now() });
  return { areaUrl: areaEntry.url, profiles };
}

async function handleRedvelvetAreaLookup(req, res, serverBase) {
  const incoming = new URL(req.url, serverBase);
  const rawName = (incoming.searchParams.get('name') || '').trim();
  const normalizedName = normalizeAreaName(rawName);

  if (!normalizedName) {
    send(res, 400, JSON.stringify({ error: 'Missing area name' }), {
      'Content-Type': 'application/json; charset=utf-8',
    });
    return;
  }

  try {
    const areaMap = await buildRedvelvetAreaHashMap();
    const areaInfo = findAreaEntryByName(areaMap, normalizedName, '2');

    if (areaInfo) {
      send(res, 200, JSON.stringify({
        url: areaInfo.url,
        area: areaInfo.name,
        areaId: areaInfo.areaId,
        cityBucket: areaInfo.cityBucket,
      }), {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
      });
    } else {
      send(res, 200, JSON.stringify({ url: '' }), {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=300',
      });
    }
  } catch (err) {
    send(res, 502, JSON.stringify({ error: err.message }), {
      'Content-Type': 'application/json; charset=utf-8',
    });
  }
}

async function handleRedvelvetAreaProfiles(req, res, serverBase) {
  const incoming = new URL(req.url, serverBase);
  const rawName = (incoming.searchParams.get('name') || '').trim();
  const cityBucket = (incoming.searchParams.get('cityBucket') || '2').trim();

  if (!rawName) {
    send(res, 400, JSON.stringify({ error: 'Missing area name' }), {
      'Content-Type': 'application/json; charset=utf-8',
    });
    return;
  }

  try {
    const result = await getRedvelvetAreaProfiles(rawName, cityBucket);
    const groups = groupProfilesByPhone(result.profiles);
    send(res, 200, JSON.stringify({
      area: normalizeAreaName(rawName),
      areaUrl: result.areaUrl,
      count: result.profiles.length,
      groups,
    }), {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    });
  } catch (err) {
    send(res, 502, JSON.stringify({ error: err.message }), {
      'Content-Type': 'application/json; charset=utf-8',
    });
  }
}

async function handleRedvelvetAreas(req, res, serverBase) {
  const incoming = new URL(req.url, serverBase);
  const cityBucket = (incoming.searchParams.get('cityBucket') || '').trim();

  try {
    const areaMap = await buildRedvelvetAreaHashMap();
    const areas = [];

    for (const [name, entries] of areaMap.entries()) {
      if (!Array.isArray(entries) || entries.length === 0) continue;
      if (!cityBucket) {
        areas.push(name);
        continue;
      }
      const matchesBucket = entries.some((entry) => String(entry.cityBucket) === cityBucket);
      if (matchesBucket) areas.push(name);
    }

    areas.sort((a, b) => a.localeCompare(b));

    send(res, 200, JSON.stringify({
      cityBucket: cityBucket || 'all',
      count: areas.length,
      areas,
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
  buildRedvelvetAreaHashMap,
  chooseAreaEntry,
  findAreaEntryByName,
  getAreaSetForCityBucket,
  filterProfilesByCityBucket,
  getRedvelvetAreaProfiles,
  parseRedvelvetProfileFromHref,
  parseRedvelvetAreaProfiles,
  fetchRedvelvetProfilesWithPostback,
  handleRedvelvetAreaLookup,
  handleRedvelvetAreaProfiles,
  handleRedvelvetAreas,
};
