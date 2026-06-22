'use strict';

const { fetchText, send } = require('../utils/http');
const { extractHiddenFields } = require('../utils/html');
const {
  parseRedvelvetAreaProfiles,
  getAreaSetForCityBucket,
  filterProfilesByCityBucket,
  buildRedvelvetAreaHashMap,
  fetchRedvelvetProfilesWithPostback,
} = require('./areas');
const { URL } = require('url');
const { groupProfilesByPhone } = require('../utils/groups');

const REDVELVET_BASE = 'https://redvelvet.co.za';
const SEARCH_URL = `${REDVELVET_BASE}/search/search`;

const CITY_SOURCES = [
  `${REDVELVET_BASE}/escorts`,
  `${REDVELVET_BASE}/capetownescorts`,
  `${REDVELVET_BASE}/johannesburgescorts`,
  `${REDVELVET_BASE}/durbanescorts`,
  `${REDVELVET_BASE}/pretoriaescorts`,
];

async function nicknameSearchFallback(nickname) {
  const queryLower = nickname.toLowerCase();
  const byUid = new Map();

  for (const source of CITY_SOURCES) {
    try {
      const profiles = await fetchRedvelvetProfilesWithPostback(source);
      for (const p of profiles) {
        const key = String(p.uid || '').trim();
        if (!key || byUid.has(key)) continue;
        if (p.name.toLowerCase().includes(queryLower)) {
          byUid.set(key, p);
        }
      }
    } catch {
      // non-fatal — skip this source
    }
  }

  return Array.from(byUid.values());
}

async function handleRedvelvetNicknameSearch(req, res, serverBase) {
  const incoming = new URL(req.url, serverBase);
  const nickname = (incoming.searchParams.get('nickname') || '').trim();
  const cityBucket = (incoming.searchParams.get('cityBucket') || '2').trim();

  if (!nickname) {
    send(res, 400, JSON.stringify({ error: 'Missing nickname' }), {
      'Content-Type': 'application/json; charset=utf-8',
    });
    return;
  }

  try {
    const [areaSet, areaMap] = await Promise.all([
      getAreaSetForCityBucket(cityBucket),
      buildRedvelvetAreaHashMap(),
    ]);

    let profiles = [];

    try {
      const formHtml = await fetchText(SEARCH_URL);
      const fields = extractHiddenFields(formHtml);

      const body = new URLSearchParams(fields);
      body.set('ctl00$ContentPlaceHolder1$txtSearch', nickname);
      body.set('ctl00$ContentPlaceHolder1$Button1', 'Search');
      body.set('hiddenInputToUpdateATBuffer_CommonToolkitScripts', '0');

      const response = await fetch(SEARCH_URL, {
        method: 'POST',
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      });

      if (response.ok) {
        const resultHtml = await response.text();
        const raw = parseRedvelvetAreaProfiles(resultHtml);
        profiles = filterProfilesByCityBucket(raw, areaSet, areaMap);
      }
    } catch {
      // fall through to fallback
    }

    if (profiles.length === 0) {
      const fallbackRaw = await nicknameSearchFallback(nickname);
      profiles = filterProfilesByCityBucket(fallbackRaw, areaSet, areaMap);
    }

    const groups = groupProfilesByPhone(profiles);
    send(res, 200, JSON.stringify({ count: profiles.length, groups }), {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
  } catch (err) {
    send(res, 502, JSON.stringify({ error: err.message }), {
      'Content-Type': 'application/json; charset=utf-8',
    });
  }
}

module.exports = { handleRedvelvetNicknameSearch };
