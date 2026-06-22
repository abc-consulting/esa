'use strict';

const { ESA_GALLERY_URL } = require('../constants');
const { send } = require('../utils/http');
const { fetchEsaProfiles } = require('./profiles');
const { normalizeAreaName } = require('../utils/normalize');
const { groupProfilesByPhone } = require('../utils/groups');

async function pLimit(concurrency, tasks) {
  const results = [];
  let i = 0;
  async function worker() {
    while (i < tasks.length) {
      const idx = i++;
      results[idx] = await tasks[idx]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return results;
}

async function handleEsaSearch(req, res) {
  let body;
  try {
    const chunks = [];
    await new Promise((resolve, reject) => {
      req.on('data', c => chunks.push(c));
      req.on('end', resolve);
      req.on('error', reject);
    });
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    send(res, 400, JSON.stringify({ error: 'Invalid JSON body' }), { 'Content-Type': 'application/json; charset=utf-8' });
    return;
  }

  const includedAreas = Array.isArray(body.areas?.included) ? body.areas.included.filter(Boolean) : [];
  const excludedAreas = Array.isArray(body.areas?.excluded) ? body.areas.excluded.filter(Boolean) : [];
  const nickname      = typeof body.nickname === 'string' ? body.nickname.trim() : '';

  const hasIncludes = includedAreas.length > 0 || nickname;
  if (!hasIncludes) {
    send(res, 200, JSON.stringify({ count: 0, groups: [] }), { 'Content-Type': 'application/json; charset=utf-8' });
    return;
  }

  try {
    let profiles;

    if (nickname) {
      // Nickname search — fetch results then optionally filter by included areas
      const url = `${ESA_GALLERY_URL}?sp%5Bnickname%5D=${encodeURIComponent(nickname)}&sp[city]=Cape+Town`;
      profiles = await fetchEsaProfiles(url);
      if (includedAreas.length > 0) {
        const included = new Set(includedAreas.map(normalizeAreaName));
        profiles = profiles.filter(p => included.has(normalizeAreaName(p.area)));
      }
    } else {
      // Area union: fetch each included area in parallel (concurrency 4)
      const tasks = includedAreas.map(area => () => {
        const url = `${ESA_GALLERY_URL}?sp[city]=Cape+Town&sp[area]=${encodeURIComponent(area)}`;
        return fetchEsaProfiles(url).catch(() => []);
      });
      const results = await pLimit(4, tasks);

      // Union by uid
      const allObjects = new Map();
      for (const batch of results) {
        for (const p of batch) allObjects.set(p.uid, p);
      }
      profiles = [...allObjects.values()];
    }

    // Subtract excluded areas
    if (excludedAreas.length > 0) {
      const excluded = new Set(excludedAreas.map(normalizeAreaName));
      profiles = profiles.filter(p => !excluded.has(normalizeAreaName(p.area)));
    }

    const groups = groupProfilesByPhone(profiles);
    send(res, 200, JSON.stringify({ count: profiles.length, groups }), {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
  } catch (err) {
    send(res, 502, JSON.stringify({ error: err.message }), { 'Content-Type': 'application/json; charset=utf-8' });
  }
}

module.exports = { handleEsaSearch };
