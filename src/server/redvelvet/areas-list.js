'use strict';

const { send } = require('../utils/http');
const { buildRedvelvetAreaHashMap } = require('./areas');
const { URL } = require('url');

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

module.exports = { handleRedvelvetAreas };
