'use strict';

const { ESA_GALLERY_URL } = require('../constants');
const { send } = require('../utils/http');
const { fetchEsaProfiles } = require('./profiles');
const { normalizeAreaName } = require('../utils/normalize');
const { flattenWithSameNumber } = require('../utils/groups');
const { getDb } = require('../db');
const { upsertProfileCards } = require('../utils/db-profiles');

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
  const scrape        = body.scrape === true;

  const hasIncludes = includedAreas.length > 0 || nickname;
  if (!hasIncludes) {
    send(res, 200, JSON.stringify({ count: 0, groups: [] }), { 'Content-Type': 'application/json; charset=utf-8' });
    return;
  }

  // DB-first path
  if (!scrape) {
    try {
      const db = await getDb();
      let filter = { provider: 'esa' };

      if (nickname) {
        filter.name = { $regex: nickname, $options: 'i' };
      } else {
        const includedAreaDocs = await db.collection('areas').find({ provider: 'esa', name: { $in: includedAreas } }).toArray();
        const includedIds = includedAreaDocs.map(a => a._id);
        if (includedIds.length) filter.areaId = { $in: includedIds };
      }

      if (excludedAreas.length) {
        const excludedAreaDocs = await db.collection('areas').find({ provider: 'esa', name: { $in: excludedAreas } }).toArray();
        const excludedIds = excludedAreaDocs.map(a => a._id);
        if (excludedIds.length) filter.areaId = { ...filter.areaId, $nin: excludedIds };
      }

      const docs = await db.collection('profiles').find(filter).toArray();
      if (docs.length > 0) {
        const areaIds = [...new Set(docs.filter(p => p.areaId).map(p => p.areaId))];
        const areas   = areaIds.length ? await db.collection('areas').find({ _id: { $in: areaIds } }).toArray() : [];
        const areaMap = new Map(areas.map(a => [String(a._id), a.name]));
        const profiles = docs.map(p => ({ provider: 'esa', uid: p.providerUid, name: p.name, area: areaMap.get(String(p.areaId)) || '', profileUrl: p.profileUrl, thumbUrl: p.thumbUrl, phone: p.phone || '' }));
        const flat = flattenWithSameNumber(profiles);
        send(res, 200, JSON.stringify({ count: profiles.length, profiles: flat }), { 'Content-Type': 'application/json; charset=utf-8' });
        return;
      }
    } catch { /* fall through to scrape */ }
  }

  try {
    let profiles;

    if (nickname) {
      const url = `${ESA_GALLERY_URL}?sp%5Bnickname%5D=${encodeURIComponent(nickname)}&sp[city]=Cape+Town`;
      profiles = await fetchEsaProfiles(url);
      if (includedAreas.length > 0) {
        const included = new Set(includedAreas.map(normalizeAreaName));
        profiles = profiles.filter(p => included.has(normalizeAreaName(p.area)));
      }
    } else {
      const tasks = includedAreas.map(area => () => {
        const url = `${ESA_GALLERY_URL}?sp[city]=Cape+Town&sp[area]=${encodeURIComponent(area)}`;
        return fetchEsaProfiles(url).catch(() => []);
      });
      const results = await pLimit(4, tasks);
      const allObjects = new Map();
      for (const batch of results) {
        for (const p of batch) allObjects.set(p.uid, p);
      }
      profiles = [...allObjects.values()];
    }

    if (excludedAreas.length > 0) {
      const excluded = new Set(excludedAreas.map(normalizeAreaName));
      profiles = profiles.filter(p => !excluded.has(normalizeAreaName(p.area)));
    }

    if (scrape) getDb().then(db => upsertProfileCards(db, profiles)).catch(() => {});
    const flatProfiles = flattenWithSameNumber(profiles);
    send(res, 200, JSON.stringify({ count: profiles.length, profiles: flatProfiles }), {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
  } catch (err) {
    send(res, 502, JSON.stringify({ error: err.message }), { 'Content-Type': 'application/json; charset=utf-8' });
  }
}

module.exports = { handleEsaSearch };
