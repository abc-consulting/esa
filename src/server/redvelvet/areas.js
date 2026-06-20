'use strict';

const { fetchText, send } = require('../utils/http');
const { normalizeAreaName } = require('../utils/normalize');
const { REDVELVET_AREAS_URL, AREA_MAP_CACHE_TTL_MS } = require('../constants');
const { URL } = require('url');

let areaMapCache = null;
let areaMapCacheTime = 0;

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
        url: `https://redvelvet.co.za/escorts/escorts_in_area/${encodeURIComponent(areaName).replace(/%20/g, '+')}/${areaId}/${cityBucket}`,
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

function filterProfilesByCityBucket(profiles, areaSet) {
  if (!(areaSet instanceof Set) || areaSet.size === 0) return profiles;
  return profiles.filter((profile) => areaSet.has(normalizeAreaName(profile?.area || '')));
}

function decodePlusSegment(value) {
  return decodeURIComponent(String(value || '')).replace(/\+/g, ' ').trim();
}

function parseRedvelvetProfileFromHref(href) {
  const absolute = href.startsWith('http') ? href : `https://redvelvet.co.za${href}`;
  const match = absolute.match(/\/escorts\/escorts_details\/([^/]+)\/([^/]+)\/(\d+)(?:\/|$)/i);
  if (!match) return null;
  return {
    uid: match[3],
    name: decodePlusSegment(match[1]),
    area: decodePlusSegment(match[2]),
    profileUrl: absolute,
  };
}

function parseRedvelvetAreaProfiles(html) {
  const profiles = [];
  const byUid = new Set();
  const anchorPattern = /<a\b[^>]*href="([^"]*\/escorts\/escorts_details\/[^"#]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = anchorPattern.exec(html)) !== null) {
    const href = match[1] || '';
    const parsed = parseRedvelvetProfileFromHref(href);

    if (!parsed) continue;

    const uidKey = String(parsed.uid || '').trim();
    if (!uidKey || byUid.has(uidKey)) continue;
    byUid.add(uidKey);

    const innerHtml = match[2] || '';
    const imgMatch = innerHtml.match(/<img\b[^>]*src="([^"]+)"/i);
    const thumbUrl = imgMatch
      ? new URL(imgMatch[1], 'https://redvelvet.co.za/').href
      : '';

    profiles.push({
      provider: 'redvelvet',
      ...parsed,
      thumbUrl,
    });
  }

  return profiles;
}

async function getRedvelvetAreaProfiles(areaName, preferredCityBucket = '2') {
  const normalizedArea = normalizeAreaName(areaName);
  if (!normalizedArea) return { areaUrl: '', profiles: [] };

  const areaMap = await buildRedvelvetAreaHashMap();
  const areaEntry = findAreaEntryByName(areaMap, normalizedArea, preferredCityBucket);
  if (!areaEntry) return { areaUrl: '', profiles: [] };

  const html = await fetchText(areaEntry.url);
  const profiles = parseRedvelvetAreaProfiles(html);
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
    send(res, 200, JSON.stringify({
      area: normalizeAreaName(rawName),
      areaUrl: result.areaUrl,
      count: result.profiles.length,
      profiles: result.profiles,
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
  handleRedvelvetAreaLookup,
  handleRedvelvetAreaProfiles,
  handleRedvelvetAreas,
};
