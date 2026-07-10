'use strict';

const { MongoClient } = require('mongodb');

const MONGODB_URL = process.env.MONGODB_URL || 'mongodb://localhost:27017';
const MONGODB_DB  = process.env.MONGODB_DB  || 'esa';

let _client     = null;
let _db         = null;
let _connecting = null;

async function getDb() {
  if (_db) return _db;
  if (_connecting) return _connecting;

  _connecting = (async () => {
    _client = new MongoClient(MONGODB_URL);
    await _client.connect();
    _db = _client.db(MONGODB_DB);
    await ensureIndexes(_db);
    console.log(`[DB] Connected to MongoDB: ${MONGODB_URL}/${MONGODB_DB}`);
    return _db;
  })().catch(err => {
    _connecting = null;
    throw err;
  });

  return _connecting;
}

async function ensureIndexes(db) {
  // profiles — (provider, providerUid) is the natural dedup key; uid is our random UUID
  await db.collection('profiles').createIndex({ provider: 1, providerUid: 1 }, { unique: true, background: true });
  await db.collection('profiles').createIndex({ uid: 1 }, { unique: true, background: true });

  // areas — lookup index; not unique because RV has multiple entries per name (different areaId/cityBucket)
  await db.collection('areas').createIndex({ provider: 1, name: 1 }, { background: true });
  await db.collection('areas').createIndex({ provider: 1, areaId: 1, cityBucket: 1 }, { background: true });

  // profileImages — ordered images per profile; uid is our random UUID for external lookup
  await db.collection('profileImages').createIndex({ profileId: 1, order: 1 }, { background: true });
  await db.collection('profileImages').createIndex({ uid: 1 }, { unique: true, sparse: true, background: true });

  // favorites — one entry per profile
  await db.collection('favorites').createIndex({ profileId: 1 }, { unique: true, background: true });

  // profileGroupMembers — one membership row per (group, profile)
  await db.collection('profileGroupMembers').createIndex({ groupId: 1, profileId: 1 }, { unique: true, background: true });
  await db.collection('profileGroupMembers').createIndex({ profileId: 1 }, { background: true });

  // profileRelationships — pairwise links within a group
  await db.collection('profileRelationships').createIndex({ groupId: 1 }, { background: true });
  await db.collection('profileRelationships').createIndex({ profileAId: 1, profileBId: 1 }, { background: true });

  // profileCache — scrape cache, TTL 4 hours
  await db.collection('profileCache').createIndex({ provider: 1, uid: 1 }, { unique: true, background: true });
  await db.collection('profileCache').createIndex({ fetchedAt: 1 }, { expireAfterSeconds: 4 * 60 * 60, background: true });

  // imageErrors — tracks image URLs that failed to load
  await db.collection('imageErrors').createIndex({ url: 1 }, { unique: true, background: true });
  await db.collection('imageErrors').createIndex({ profileId: 1 }, { background: true });
}

// Upsert all areas from the in-memory hash maps built during server warmup.
// ESA map: normalizedName → { name, url }
// RV map:  normalizedName → [{ name, areaId, cityBucket, url }, ...]
// RV areas are keyed by (areaId, cityBucket) — the numeric IDs are the true identity.
// ESA areas are keyed by name (no numeric ID available).
async function syncAreasFromHashMaps(esaMap, rvMap) {
  try {
    const db  = await getDb();
    const col = db.collection('areas');

    // Drop all existing areas and re-insert from the authoritative hash maps.
    // This is safe because areas are only referenced by _id from profiles, and
    // those references are set during profile upsert — area docs themselves are
    // looked up by name at query time, not by _id from stored profile docs.
    await col.deleteMany({});

    const docs = [];

    for (const entry of esaMap.values()) {
      docs.push({ provider: 'esa', name: entry.name, url: entry.url });
    }

    for (const entries of rvMap.values()) {
      for (const entry of entries) {
        docs.push({
          provider:   'redvelvet',
          name:       entry.name,
          url:        entry.url,
          areaId:     entry.areaId,
          cityBucket: entry.cityBucket,
        });
      }
    }

    if (docs.length) await col.insertMany(docs, { ordered: false });
    console.log(`[DB] Synced ${docs.length} areas from hash maps (${esaMap.size} ESA, ${docs.length - esaMap.size} RV)`);
  } catch (err) {
    console.error('[DB] syncAreasFromHashMaps error:', err.message);
  }
}

let _gridfs = null;

async function getGridFSBucket() {
  const db = await getDb();
  if (!_gridfs) {
    const { GridFSBucket } = require('mongodb');
    _gridfs = new GridFSBucket(db, { bucketName: 'profileImages' });
  }
  return _gridfs;
}

module.exports = { getDb, getGridFSBucket, syncAreasFromHashMaps };

/*
 * Schema reference
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * providers
 *   _id     : "esa" | "redvelvet"       natural string key
 *   name    : string                     e.g. "ESA"
 *   baseUrl : string                     e.g. "https://www.esa.co.za"
 *
 * areas
 *   _id         : ObjectId
 *   provider    : string                 ref → providers._id
 *   name        : string                 e.g. "Goodwood"
 *   url         : string                 area listing page URL
 *   areaId?     : string                 RV numeric area ID (redvelvet only)
 *   cityBucket? : string                 RV city bucket ID (redvelvet only)
 *
 * relationshipTypes
 *   _id         : ObjectId
 *   name        : "profile"|"venue"|"unknown"
 *   description : string
 *
 * profiles
 *   _id         : ObjectId
 *   uid         : string (UUID v4)       our own random ID
 *   providerUid : string                 ESA/RV numeric ID
 *   provider    : string                 ref → providers._id
 *   name        : string
 *   areaId      : ObjectId               ref → areas._id
 *   profileUrl  : string
 *   thumbUrl    : string
 *   images      : ObjectId[]                     refs → profileImages._id (sorted by order)
 *   phone?      : string
 *   age?        : string
 *   bust?       : string                 e.g. "75D"
 *   tags?       : string[]
 *
 * profileImages                          metadata doc; binary stored in GridFS (profileImages bucket)
 *   _id         : ObjectId
 *   uid         : string (UUID v4)       our random ID; used by /image?id= endpoint
 *   profileId   : ObjectId               ref → profiles._id
 *   url         : string                 source URL (original provider URL)
 *   type        : "image" | "video"
 *   order       : number
 *   quality?    : string                 ESA size tier: "large"|"medium"|"small"|"thumb_blur"
 *   fileId?     : ObjectId               ref → profileImages.files._id (set once binary is stored)
 *   contentType?: string                 MIME type stored alongside the binary
 *
 * favorites
 *   _id       : ObjectId
 *   profileId : ObjectId                 ref → profiles._id
 *   savedAt   : number                   Unix epoch ms
 *
 * profileGroups
 *   _id       : string (UUID v4)         our random group ID
 *   createdAt : number                   Unix epoch ms
 *
 * profileGroupMembers
 *   _id       : ObjectId
 *   groupId   : string                   ref → profileGroups._id
 *   profileId : ObjectId                 ref → profiles._id
 *
 * profileRelationships
 *   _id                : ObjectId
 *   groupId            : string          ref → profileGroups._id
 *   profileAId         : ObjectId        ref → profiles._id
 *   profileBId         : ObjectId        ref → profiles._id
 *   relationshipTypeId : ObjectId        ref → relationshipTypes._id
 */
