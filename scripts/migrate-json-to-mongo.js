'use strict';

// One-shot migration: data/favorites.json + data/profile-groups.json → normalised MongoDB schema.
// Safe to re-run — uses upserts throughout. Drop collections first for a clean slate.

const fs   = require('fs');
const path = require('path');
const { MongoClient, ObjectId } = require('mongodb');
const { randomUUID } = require('crypto');

const MONGODB_URL = process.env.MONGODB_URL || 'mongodb://localhost:27017';
const MONGODB_DB  = process.env.MONGODB_DB  || 'esa';
const DATA_DIR    = path.join(__dirname, '../data');

// ── Seed data ─────────────────────────────────────────────────────────────────

const PROVIDERS = [
  { _id: 'esa',       name: 'ESA',       baseUrl: 'https://www.esa.co.za' },
  { _id: 'redvelvet', name: 'RedVelvet', baseUrl: 'https://redvelvet.co.za' },
];

const RELATIONSHIP_TYPES = [
  { name: 'profile', description: 'Two listings belong to the same physical person' },
  { name: 'venue',   description: 'Two profiles work at or are linked by the same venue' },
  { name: 'unknown', description: 'Relationship type not yet determined' },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

async function seedProviders(db) {
  for (const p of PROVIDERS) {
    await db.collection('providers').updateOne({ _id: p._id }, { $setOnInsert: p }, { upsert: true });
  }
  console.log('providers: seeded');
}

async function seedRelationshipTypes(db) {
  const rtMap = {};
  for (const rt of RELATIONSHIP_TYPES) {
    const existing = await db.collection('relationshipTypes').findOne({ name: rt.name });
    if (existing) {
      rtMap[rt.name] = existing._id;
    } else {
      const result = await db.collection('relationshipTypes').insertOne(rt);
      rtMap[rt.name] = result.insertedId;
    }
  }
  console.log('relationshipTypes: seeded');
  return rtMap;
}

// Upsert an area and return its _id.
// Old data has "area" as a plain string on each profile.
async function upsertArea(db, areaCache, provider, areaName) {
  const cacheKey = `${provider}:${areaName}`;
  if (areaCache.has(cacheKey)) return areaCache.get(cacheKey);

  const doc  = { provider, name: areaName };
  const col  = db.collection('areas');
  const curr = await col.findOne({ provider, name: areaName });
  if (curr) {
    areaCache.set(cacheKey, curr._id);
    return curr._id;
  }
  const result = await col.insertOne(doc);
  areaCache.set(cacheKey, result.insertedId);
  return result.insertedId;
}

// Upsert a profile and return its _id.
// Old data uses "uid" = provider numeric ID. New schema: providerUid = old uid, uid = new UUID.
async function upsertProfile(db, areaCache, profileUidMap, rawProfile) {
  const { provider, uid: providerUid, name, area, profileUrl, thumbUrl, phone } = rawProfile;

  // Check in-memory map first (deduplicate within this run)
  const key = `${provider}:${providerUid}`;
  if (profileUidMap.has(key)) return profileUidMap.get(key);

  const col      = db.collection('profiles');
  const existing = await col.findOne({ provider, providerUid });
  if (existing) {
    profileUidMap.set(key, existing._id);
    return existing._id;
  }

  const areaId = area ? await upsertArea(db, areaCache, provider, area) : null;
  const doc = {
    uid:         randomUUID(),
    providerUid,
    provider,
    name:        name || '',
    areaId,
    profileUrl:  profileUrl || '',
    thumbUrl:    thumbUrl   || '',
    images:      [],
  };
  if (phone) doc.phone = phone;

  const result   = await col.insertOne(doc);
  const profileId = result.insertedId;

  // Seed thumb as first profileImages entry, then ref it from the profile
  if (thumbUrl) {
    const imgResult = await db.collection('profileImages').insertOne({
      profileId, url: thumbUrl, type: 'image', order: 0,
    });
    await col.updateOne({ _id: profileId }, { $push: { images: imgResult.insertedId } });
  }

  profileUidMap.set(key, profileId);
  return profileId;
}

// ── Migration steps ───────────────────────────────────────────────────────────

async function migrateFavorites(db, areaCache, profileUidMap) {
  const favPath = path.join(DATA_DIR, 'favorites.json');
  if (!fs.existsSync(favPath)) {
    console.log('favorites: data/favorites.json not found, skipping');
    return;
  }

  const raw     = JSON.parse(fs.readFileSync(favPath, 'utf8'));
  const allFavs = Object.values(raw).flat();
  let inserted  = 0;

  for (const fav of allFavs) {
    const profileId = await upsertProfile(db, areaCache, profileUidMap, fav);
    const exists    = await db.collection('favorites').findOne({ profileId });
    if (!exists) {
      await db.collection('favorites').insertOne({ profileId, savedAt: fav.savedAt || Date.now() });
      inserted++;
    }
  }
  console.log(`favorites: ${inserted} inserted (${allFavs.length} total)`);
}

async function migrateGroups(db, areaCache, profileUidMap, rtMap) {
  const groupsPath = path.join(DATA_DIR, 'profile-groups.json');
  if (!fs.existsSync(groupsPath)) {
    console.log('profileGroups: data/profile-groups.json not found, skipping');
    return;
  }

  const groups = JSON.parse(fs.readFileSync(groupsPath, 'utf8'));
  let groupCount = 0, memberCount = 0, relCount = 0;

  for (const group of groups) {
    // 1. Upsert group doc
    await db.collection('profileGroups').updateOne(
      { _id: group.id },
      { $setOnInsert: { _id: group.id, createdAt: group.createdAt } },
      { upsert: true }
    );

    // 2. Upsert members and build lookup old-uid → ObjectId
    const providerUidToOid = {};
    for (const member of group.members) {
      const oid = await upsertProfile(db, areaCache, profileUidMap, member);
      providerUidToOid[`${member.provider}:${member.uid}`] = oid;

      // 3. Upsert membership row
      const memberDoc = { groupId: group.id, profileId: oid };
      await db.collection('profileGroupMembers').updateOne(
        memberDoc,
        { $setOnInsert: memberDoc },
        { upsert: true }
      );
      memberCount++;
    }

    // 4. Upsert relationship rows
    for (const [pairKey, relTypeName] of Object.entries(group.pairs || {})) {
      const [rawA, rawB] = pairKey.split('|');
      const profileAId   = providerUidToOid[rawA];
      const profileBId   = providerUidToOid[rawB];
      if (!profileAId || !profileBId) continue;

      const relationshipTypeId = rtMap[relTypeName] || rtMap.unknown;
      const relDoc = { groupId: group.id, profileAId, profileBId, relationshipTypeId };
      await db.collection('profileRelationships').updateOne(
        { groupId: group.id, profileAId, profileBId },
        { $setOnInsert: relDoc },
        { upsert: true }
      );
      relCount++;
    }

    groupCount++;
  }

  console.log(`profileGroups: ${groupCount} groups, ${memberCount} members, ${relCount} relationships`);
}


async function ensureIndexes(db) {
  await db.collection('profiles').createIndex({ provider: 1, providerUid: 1 }, { unique: true });
  await db.collection('profiles').createIndex({ uid: 1 }, { unique: true });
  await db.collection('areas').createIndex({ provider: 1, name: 1 });
  await db.collection('areas').createIndex({ provider: 1, areaId: 1, cityBucket: 1 });
  await db.collection('profileImages').createIndex({ profileId: 1, order: 1 });
  await db.collection('favorites').createIndex({ profileId: 1 }, { unique: true });
  await db.collection('profileGroupMembers').createIndex({ groupId: 1, profileId: 1 }, { unique: true });
  await db.collection('profileGroupMembers').createIndex({ profileId: 1 });
  await db.collection('profileRelationships').createIndex({ groupId: 1 });
  await db.collection('profileRelationships').createIndex({ profileAId: 1, profileBId: 1 });
  await db.collection('profileCache').createIndex({ provider: 1, uid: 1 }, { unique: true });
  await db.collection('profileCache').createIndex({ fetchedAt: 1 }, { expireAfterSeconds: 4 * 60 * 60 });
  console.log('indexes: created');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const client = new MongoClient(MONGODB_URL);
  await client.connect();
  console.log(`Connected to ${MONGODB_URL}/${MONGODB_DB}`);
  const db = client.db(MONGODB_DB);

  // Drop stale collections for a clean migration
  const DROP = [
    'providers', 'areas', 'relationshipTypes', 'profiles', 'profileImages',
    'favorites', 'profileGroups', 'profileGroupMembers', 'profileRelationships',
  ];
  for (const c of DROP) {
    try { await db.collection(c).drop(); } catch { /* not found is fine */ }
  }
  console.log('collections: dropped for clean migration');

  await ensureIndexes(db);

  const areaCache     = new Map();
  const profileUidMap = new Map();

  await seedProviders(db);
  const rtMap = await seedRelationshipTypes(db);
  await migrateFavorites(db, areaCache, profileUidMap);
  await migrateGroups(db, areaCache, profileUidMap, rtMap);

  const counts = {};
  for (const c of ['providers', 'areas', 'relationshipTypes', 'profiles', 'profileImages', 'favorites', 'profileGroups', 'profileGroupMembers', 'profileRelationships']) {
    counts[c] = await db.collection(c).countDocuments();
  }
  console.log('\nFinal counts:', counts);

  await client.close();
  console.log('Done.');
}

main().catch(err => { console.error(err); process.exit(1); });
