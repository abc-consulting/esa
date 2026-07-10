'use strict';

const { send } = require('./utils/http');
const { getDb } = require('./db');
const { upsertProfileCard } = require('./utils/db-profiles');

// ── Read ──────────────────────────────────────────────────────────────────────

async function readGroups() {
  const db     = await getDb();
  const groups = await db.collection('profileGroups').find({}).toArray();
  if (!groups.length) return [];

  const groupIds = groups.map(g => g._id);

  // Load all members for all groups in one query
  const members = await db.collection('profileGroupMembers').find({ groupId: { $in: groupIds } }).toArray();
  const profileIds = [...new Set(members.map(m => m.profileId))];
  const profiles = profileIds.length
    ? await db.collection('profiles').find({ _id: { $in: profileIds } }).toArray()
    : [];

  // Resolve area names
  const areaIds  = [...new Set(profiles.filter(p => p.areaId).map(p => p.areaId))];
  const areas    = areaIds.length ? await db.collection('areas').find({ _id: { $in: areaIds } }).toArray() : [];
  const areaMap  = new Map(areas.map(a => [String(a._id), a.name]));
  const profMap  = new Map(profiles.map(p => [String(p._id), p]));

  // Load relationships and their types
  const rels = await db.collection('profileRelationships').find({ groupId: { $in: groupIds } }).toArray();
  const rtIds = [...new Set(rels.map(r => r.relationshipTypeId))];
  const rtDocs = rtIds.length
    ? await db.collection('relationshipTypes').find({ _id: { $in: rtIds } }).toArray()
    : [];
  const rtMap = new Map(rtDocs.map(r => [String(r._id), r.name]));

  // Group members and relationships by groupId
  const membersByGroup = {};
  for (const m of members) {
    (membersByGroup[m.groupId] ||= []).push(m);
  }
  const relsByGroup = {};
  for (const r of rels) {
    (relsByGroup[r.groupId] ||= []).push(r);
  }

  return groups.map(group => {
    const groupMembers = (membersByGroup[group._id] || []).map(m => {
      const p = profMap.get(String(m.profileId));
      if (!p) return null;
      const entry = {
        provider:   p.provider,
        uid:        p.providerUid,
        name:       p.name,
        area:       areaMap.get(String(p.areaId)) || '',
        thumbUrl:   p.thumbUrl,
        profileUrl: p.profileUrl,
      };
      if (p.phone) entry.phone = p.phone;
      return entry;
    }).filter(Boolean);

    // Rebuild pairs as "provider:providerUid|provider:providerUid" → relTypeName
    const pairs = {};
    for (const r of (relsByGroup[group._id] || [])) {
      const pA = profMap.get(String(r.profileAId));
      const pB = profMap.get(String(r.profileBId));
      if (!pA || !pB) continue;
      const typeName = rtMap.get(String(r.relationshipTypeId)) || 'unknown';
      pairs[`${pA.provider}:${pA.providerUid}|${pB.provider}:${pB.providerUid}`] = typeName;
    }

    return { id: group._id, members: groupMembers, createdAt: group.createdAt, pairs };
  });
}

// ── Write ─────────────────────────────────────────────────────────────────────

async function writeGroups(db, groups) {
  const incomingGroupIds = groups.map(g => g.id);
  const areaCache = new Map();

  // Load relationship types once
  const rtDocs = await db.collection('relationshipTypes').find({}).toArray();
  const rtByName = new Map(rtDocs.map(r => [r.name, r._id]));

  for (const group of groups) {
    // 1. Upsert group doc
    await db.collection('profileGroups').updateOne(
      { _id: group.id },
      { $setOnInsert: { _id: group.id, createdAt: group.createdAt } },
      { upsert: true }
    );

    // 2. Upsert each member profile; build lookup: "provider:providerUid" → ObjectId
    const keyToOid = {};
    for (const member of group.members) {
      const prof = await upsertProfileCard(db, areaCache, member);
      keyToOid[`${member.provider}:${member.uid}`] = prof._id;
    }

    // 3. Replace membership rows (delete stale, insert new)
    await db.collection('profileGroupMembers').deleteMany({ groupId: group.id });
    const memberDocs = Object.values(keyToOid).map(profileId => ({ groupId: group.id, profileId }));
    if (memberDocs.length) await db.collection('profileGroupMembers').insertMany(memberDocs);

    // 4. Replace relationship rows
    await db.collection('profileRelationships').deleteMany({ groupId: group.id });
    const relDocs = [];
    for (const [pairKey, typeName] of Object.entries(group.pairs || {})) {
      const [rawA, rawB] = pairKey.split('|');
      const profileAId   = keyToOid[rawA];
      const profileBId   = keyToOid[rawB];
      if (!profileAId || !profileBId) continue;
      const relationshipTypeId = rtByName.get(typeName) || rtByName.get('unknown');
      if (!relationshipTypeId) continue;
      relDocs.push({ groupId: group.id, profileAId, profileBId, relationshipTypeId });
    }
    if (relDocs.length) await db.collection('profileRelationships').insertMany(relDocs);
  }

  // Remove groups that are no longer in the incoming set
  await db.collection('profileGroups').deleteMany({ _id: { $nin: incomingGroupIds } });
  await db.collection('profileGroupMembers').deleteMany({ groupId: { $nin: incomingGroupIds } });
  await db.collection('profileRelationships').deleteMany({ groupId: { $nin: incomingGroupIds } });
}

// ── Handlers ──────────────────────────────────────────────────────────────────

async function handleGetProfileGroups(req, res) {
  try {
    const groups = await readGroups();
    send(res, 200, JSON.stringify(groups), { 'Content-Type': 'application/json; charset=utf-8' });
  } catch (err) {
    send(res, 500, JSON.stringify({ error: err.message }), { 'Content-Type': 'application/json' });
  }
}

async function handleSaveProfileGroups(req, res) {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', async () => {
    let groups;
    try {
      groups = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      send(res, 400, JSON.stringify({ error: 'Invalid JSON' }), { 'Content-Type': 'application/json' });
      return;
    }
    if (!Array.isArray(groups)) {
      send(res, 400, JSON.stringify({ error: 'Expected an array' }), { 'Content-Type': 'application/json' });
      return;
    }
    try {
      const db = await getDb();
      await writeGroups(db, groups);
      send(res, 200, JSON.stringify({ ok: true }), { 'Content-Type': 'application/json' });
    } catch (err) {
      send(res, 500, JSON.stringify({ error: err.message }), { 'Content-Type': 'application/json' });
    }
  });
}

module.exports = { handleGetProfileGroups, handleSaveProfileGroups };
