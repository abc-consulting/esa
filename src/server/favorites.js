'use strict';

const { send } = require('./utils/http');
const { getDb } = require('./db');
const { upsertProfileCard } = require('./utils/db-profiles');

async function handleGetFavorites(req, res) {
  try {
    const db   = await getDb();
    const favs = await db.collection('favorites').find({}).toArray();

    const profileIds = favs.map(f => f.profileId);
    const profiles   = await db.collection('profiles').find({ _id: { $in: profileIds } }).toArray();

    const areaIds    = [...new Set(profiles.filter(p => p.areaId).map(p => p.areaId))];
    const areas      = areaIds.length ? await db.collection('areas').find({ _id: { $in: areaIds } }).toArray() : [];
    const areaMap    = new Map(areas.map(a => [String(a._id), a.name]));
    const profileMap = new Map(profiles.map(p => [String(p._id), p]));

    const result = {};
    for (const fav of favs) {
      const p = profileMap.get(String(fav.profileId));
      if (!p) continue;
      const entry = {
        provider:   p.provider,
        uid:        p.providerUid,
        name:       p.name,
        area:       areaMap.get(String(p.areaId)) || '',
        thumbUrl:   p.thumbUrl,
        profileUrl: p.profileUrl,
        savedAt:    fav.savedAt,
      };
      if (p.phone) entry.phone = p.phone;
      if (!result[p.provider]) result[p.provider] = [];
      result[p.provider].push(entry);
    }

    send(res, 200, JSON.stringify(result), { 'Content-Type': 'application/json; charset=utf-8' });
  } catch (err) {
    send(res, 500, JSON.stringify({ error: err.message }), { 'Content-Type': 'application/json' });
  }
}

async function handleSaveFavorites(req, res) {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', async () => {
    let data;
    try {
      data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      send(res, 400, JSON.stringify({ error: 'Invalid JSON' }), { 'Content-Type': 'application/json' });
      return;
    }
    if (typeof data !== 'object' || Array.isArray(data) || data === null) {
      send(res, 400, JSON.stringify({ error: 'Expected an object' }), { 'Content-Type': 'application/json' });
      return;
    }
    try {
      const db        = await getDb();
      const allFavs   = Object.values(data).flat();
      const areaCache = new Map();

      const profileEntries = await Promise.all(
        allFavs.map(async fav => ({
          profileId: (await upsertProfileCard(db, areaCache, fav))._id,
          savedAt:   fav.savedAt || Date.now(),
        }))
      );

      const incomingIds = profileEntries.map(e => e.profileId);
      await db.collection('favorites').deleteMany({ profileId: { $nin: incomingIds } });
      for (const { profileId, savedAt } of profileEntries) {
        await db.collection('favorites').updateOne(
          { profileId },
          { $setOnInsert: { profileId, savedAt } },
          { upsert: true }
        );
      }

      send(res, 200, JSON.stringify({ ok: true }), { 'Content-Type': 'application/json' });
    } catch (err) {
      send(res, 500, JSON.stringify({ error: err.message }), { 'Content-Type': 'application/json' });
    }
  });
}

module.exports = { handleGetFavorites, handleSaveFavorites };
