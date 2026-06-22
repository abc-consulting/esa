'use strict';

const { fetchText, send } = require('../utils/http');
const { extractHiddenFields } = require('../utils/html');
const {
  parseRedvelvetAreaProfiles,
  getAreaSetForCityBucket,
  filterProfilesByCityBucket,
  buildRedvelvetAreaHashMap,
} = require('./areas');
const { URL } = require('url');
const { groupProfilesByPhone } = require('../utils/groups');
const { REQUEST_TIMEOUT_MS, POSTBACK_TIMEOUT_MS } = require('../constants');

const REDVELVET_BASE = 'https://redvelvet.co.za';
const SEARCH_URL = `${REDVELVET_BASE}/search/search`;

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

    console.log(`[RV DEBUG] nickname-search: GET ${SEARCH_URL}`);
    const formHtml = await fetchText(SEARCH_URL);
    console.log(`[RV DEBUG] nickname-search: form HTML length=${formHtml.length}. Snippet: ${formHtml.slice(0, 200).replace(/\s+/g, ' ')}`);
    const fields = extractHiddenFields(formHtml);
    console.log(`[RV DEBUG] nickname-search: extracted hidden fields: ${Object.keys(fields).join(', ')}`);

    const body = new URLSearchParams(fields);
    body.set('ctl00$ContentPlaceHolder1$txtSearch', nickname);
    body.set('ctl00$ContentPlaceHolder1$Button1', 'Search');
    body.set('hiddenInputToUpdateATBuffer_CommonToolkitScripts', '0');

    console.log(`[RV DEBUG] nickname-search: POST ${SEARCH_URL} nickname="${nickname}"`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), POSTBACK_TIMEOUT_MS);
    try {
      const response = await fetch(SEARCH_URL, {
        method: 'POST',
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
        signal: controller.signal,
      });

      console.log(`[RV DEBUG] nickname-search: POST response HTTP ${response.status}, url=${response.url}`);
      if (response.ok) {
        const resultHtml = await response.text();
        console.log(`[RV DEBUG] nickname-search: result HTML length=${resultHtml.length}. Snippet: ${resultHtml.slice(0, 300).replace(/\s+/g, ' ')}`);
        const raw = parseRedvelvetAreaProfiles(resultHtml);
        console.log(`[RV DEBUG] nickname-search: parsed ${raw.length} profiles (unfiltered)`);
        profiles = filterProfilesByCityBucket(raw, areaSet, areaMap);
        console.log(`[RV DEBUG] nickname-search: ${profiles.length} profiles after cityBucket filter`);
      }
    } finally {
      clearTimeout(timer);
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
