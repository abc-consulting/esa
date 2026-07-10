'use strict';

const { randomUUID } = require('crypto');

// Extract ESA size tier from a URL's size= query param (e.g. "large", "medium")
function extractQuality(url) {
  try {
    const m = url.match(/[?&]size=([^&]+)/i);
    return m ? m[1].toLowerCase() : null;
  } catch { return null; }
}

// ── Area upsert ───────────────────────────────────────────────────────────────

async function upsertArea(db, areaCache, provider, areaName) {
  if (!areaName) return null;
  const key = `${provider}:${areaName}`;
  if (areaCache.has(key)) return areaCache.get(key);
  const result = await db.collection('areas').findOneAndUpdate(
    { provider, name: areaName },
    { $setOnInsert: { provider, name: areaName } },
    { upsert: true, returnDocument: 'after' }
  );
  areaCache.set(key, result._id);
  return result._id;
}

// ── Profile card upsert ───────────────────────────────────────────────────────
//
// card = { provider, uid (providerUid), name, area, profileUrl, thumbUrl, phone? }
//
// Immutable fields (set only on insert): uid (our UUID), providerUid, provider
// Mutable fields (refreshed on every scrape): name, profileUrl, thumbUrl, phone
//
// Returns { _id: ObjectId }

async function upsertProfileCard(db, areaCache, card) {
  const { provider, uid: providerUid, name, area, profileUrl, thumbUrl, phone } = card;
  const areaId = await upsertArea(db, areaCache, provider, area);

  const setOnInsert = { uid: randomUUID(), providerUid, provider, images: [] };
  const set = {
    name:       name       || '',
    profileUrl: profileUrl || '',
    thumbUrl:   thumbUrl   || '',
    areaId,
  };
  if (phone !== undefined) set.phone = phone || '';

  const update = { $setOnInsert: setOnInsert, $set: set };
  const result = await db.collection('profiles').findOneAndUpdate(
    { provider, providerUid },
    update,
    { upsert: true, returnDocument: 'after' }
  );

  // Seed thumb into profileImages if this profile has no images yet
  if (thumbUrl && result.images && result.images.length === 0) {
    try {
      const quality = extractQuality(thumbUrl);
      const imgDoc  = { uid: randomUUID(), profileId: result._id, url: thumbUrl, type: 'image', order: 0 };
      if (quality) imgDoc.quality = quality;
      const imgResult = await db.collection('profileImages').insertOne(imgDoc);
      await db.collection('profiles').updateOne(
        { _id: result._id },
        { $push: { images: imgResult.insertedId } }
      );
    } catch { /* non-fatal */ }
  }

  return { _id: result._id };
}

// ── Profile detail write-back ─────────────────────────────────────────────────
//
// Called after a detail scrape to enrich the profiles doc with age/bust/tags
// and persist image URLs into profileImages, referencing them from profiles.images.
//
// imageUrls: string[] of absolute image/video URLs in display order
// imageTypes: string[] of 'image' | 'video' (parallel to imageUrls); defaults to 'image'

async function upsertProfileDetails(db, profileId, { age, bust, tags, imageUrls = [], imageTypes = [] }) {
  const setFields = {};
  if (age  !== undefined && age  !== '') setFields.age  = age;
  if (bust !== undefined && bust !== '') setFields.bust = bust;
  if (tags !== undefined)               setFields.tags = tags;

  if (Object.keys(setFields).length) {
    await db.collection('profiles').updateOne({ _id: profileId }, { $set: setFields });
  }

  if (!imageUrls.length) return;

  // Load existing image URLs for this profile to avoid duplicates
  const existingImgDocs = await db.collection('profileImages')
    .find({ profileId }, { projection: { url: 1 } }).toArray();
  const existingUrls = new Set(existingImgDocs.map(d => d.url));

  // Load current profiles.images array to know the next order index
  const profileDoc = await db.collection('profiles').findOne({ _id: profileId }, { projection: { images: 1 } });
  let order = (profileDoc?.images?.length) || 0;

  const newImageIds = [];
  for (let i = 0; i < imageUrls.length; i++) {
    const url = imageUrls[i];
    if (!url || existingUrls.has(url)) continue;
    const type    = imageTypes[i] || 'image';
    const quality = extractQuality(url);
    const imgDoc  = { uid: randomUUID(), profileId, url, type, order };
    if (quality) imgDoc.quality = quality;
    try {
      const imgResult = await db.collection('profileImages').insertOne(imgDoc);
      newImageIds.push(imgResult.insertedId);
      order++;
    } catch { /* duplicate or error — skip */ }
  }

  if (newImageIds.length) {
    await db.collection('profiles').updateOne(
      { _id: profileId },
      { $push: { images: { $each: newImageIds } } }
    );
  }
}

// ── Bulk card upsert (fire-and-forget helper for list endpoints) ───────────────

async function upsertProfileCards(db, cards) {
  const areaCache = new Map();
  for (const card of cards) {
    await upsertProfileCard(db, areaCache, card).catch(() => {});
  }
}

// ── Load profileImages docs for a profile, sorted by order ───────────────────
//
// Returns full docs: { _id, uid, url, type, quality, order, fileId? }
// Used by detail handlers to build the response and check binary status.

async function loadProfileImageDocs(db, profileId) {
  const docs = await db.collection('profileImages')
    .find({ profileId }, { projection: { uid: 1, url: 1, type: 1, quality: 1, order: 1, fileId: 1 } })
    .sort({ order: 1 })
    .toArray();
  return docs;
}

// ── Background binary fetch ───────────────────────────────────────────────────
//
// For each profileImages doc that has no fileId yet, fetches the image through
// the local relay (which writes it into GridFS as a side effect) then marks the
// doc as stored. Runs entirely in the background — never awaited by the handler.
//
// relayBase: e.g. "http://localhost:5510"

async function fetchPendingBinaries(db, profileId, relayBase) {
  try {
    const docs = await db.collection('profileImages')
      .find({ profileId, fileId: { $exists: false }, type: 'image' }, { projection: { _id: 1, uid: 1, url: 1 } })
      .sort({ order: 1 })
      .toArray();

    for (const doc of docs) {
      // Random 0–800ms stagger so we don't hammer the upstream
      await new Promise(r => setTimeout(r, Math.floor(Math.random() * 800)));
      try {
        // Hitting /image?id= triggers the relay's DB-first check then upstream fetch + GridFS write
        const res = await fetch(`${relayBase}/image?id=${encodeURIComponent(doc.uid)}`);
        if (!res.ok) continue;
        // Drain the body so the relay actually finishes writing to GridFS
        await res.arrayBuffer();
      } catch { /* non-fatal — will retry next time */ }
    }
  } catch { /* non-fatal */ }
}

module.exports = { upsertArea, upsertProfileCard, upsertProfileDetails, upsertProfileCards, loadProfileImageDocs, fetchPendingBinaries };
