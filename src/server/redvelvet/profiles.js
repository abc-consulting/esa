'use strict';

const fs = require('fs');
const path = require('path');
const { send, fetchText } = require('../utils/http');
const { getAreaSetForCityBucket, filterProfilesByCityBucket, buildRedvelvetAreaHashMap, fetchRedvelvetProfilesWithPostback } = require('./areas');
const { resolveRedvelvetTagUrl } = require('./tags');
const { URL } = require('url');
const { getDb } = require('../db');
const { upsertProfileCards } = require('../utils/db-profiles');

const TAG_OVERRIDES_PATH = path.join(__dirname, '../../../tag-overrides.json');
const REDVELVET_BASE = 'https://redvelvet.co.za';

function loadTagOverrides() {
  try {
    return JSON.parse(fs.readFileSync(TAG_OVERRIDES_PATH, 'utf8'));
  } catch {
    return {};
  }
}

async function fetchProfileStub(uid) {
  const url = `${REDVELVET_BASE}/escorts/escorts_details.aspx?userid=${uid}`;
  try {
    const html = await fetchText(url);
    const slugMatch = html.match(/escorts_details\/([^/]+)\/([^/]+)\/(\d+)/i);
    if (slugMatch) {
      const name = decodeURIComponent(slugMatch[1]).replace(/\+/g, ' ').trim();
      const area = decodeURIComponent(slugMatch[2]).replace(/\+/g, ' ').trim();
      const resolvedUid = slugMatch[3];
      const imgMatch = html.match(/src="([^"]*\/uploadimages\/[^"]+)"/i);
      const thumbUrl = imgMatch ? (imgMatch[1].startsWith('http') ? imgMatch[1] : `${REDVELVET_BASE}${imgMatch[1]}`) : '';
      return { provider: 'redvelvet', uid: resolvedUid, name, area, profileUrl: `${REDVELVET_BASE}/escorts/escorts_details/${slugMatch[1]}/${slugMatch[2]}/${resolvedUid}`, thumbUrl };
    }
  } catch { /* non-fatal */ }
  return null;
}

async function handleRedvelvetProfileLookup(req, res) {
  send(res, 501, JSON.stringify({ error: 'Not implemented' }), {
    'Content-Type': 'application/json; charset=utf-8',
  });
}

async function handleRedvelvetTagProfiles(req, res, serverBase) {
  const incoming   = new URL(req.url, serverBase);
  const tag        = (incoming.searchParams.get('tag')        || '').trim();
  const tagUrl     = (incoming.searchParams.get('tagUrl')     || '').trim();
  const cityBucket = (incoming.searchParams.get('cityBucket') || '2').trim();
  const scrape     = incoming.searchParams.get('scrape') === 'true';

  if (!tag && !tagUrl) {
    send(res, 400, JSON.stringify({ error: 'Missing tag or tagUrl' }), {
      'Content-Type': 'application/json; charset=utf-8',
    });
    return;
  }

  // DB-first path (tags are only present after a detail scrape, so fall through if empty)
  if (!scrape && tag) {
    try {
      const db   = await getDb();
      const docs = await db.collection('profiles').find({ provider: 'redvelvet', tags: tag }).toArray();
      if (docs.length > 0) {
        const areaIds = [...new Set(docs.filter(p => p.areaId).map(p => p.areaId))];
        const areas   = areaIds.length ? await db.collection('areas').find({ _id: { $in: areaIds } }).toArray() : [];
        const areaMap = new Map(areas.map(a => [String(a._id), a.name]));
        const profiles = docs.map(p => ({ provider: 'redvelvet', uid: p.providerUid, name: p.name, area: areaMap.get(String(p.areaId)) || '', profileUrl: p.profileUrl, thumbUrl: p.thumbUrl, phone: p.phone || '' }));
        send(res, 200, JSON.stringify({ tag, tagUrl: '', cityBucket, beforeCount: profiles.length, count: profiles.length, profiles }), { 'Content-Type': 'application/json; charset=utf-8' });
        return;
      }
    } catch { /* fall through */ }
  }

  try {
    const resolvedTagUrl = await resolveRedvelvetTagUrl(tag, tagUrl);
    console.log(`[RV DEBUG] tag-profiles: tag="${tag}" resolved URL=${resolvedTagUrl || 'NOT FOUND'}`);
    if (!resolvedTagUrl) {
      send(res, 200, JSON.stringify({
        tag,
        tagUrl: '',
        cityBucket,
        beforeCount: 0,
        count: 0,
        profiles: [],
      }), {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=300',
      });
      return;
    }

    const profiles = await fetchRedvelvetProfilesWithPostback(resolvedTagUrl);
    console.log(`[RV DEBUG] tag-profiles: fetched ${profiles.length} profiles (before filter)`);
    const [areaSet, areaMap] = await Promise.all([
      getAreaSetForCityBucket(cityBucket),
      buildRedvelvetAreaHashMap(),
    ]);
    const filteredProfiles = filterProfilesByCityBucket(profiles, areaSet, areaMap);
    console.log(`[RV DEBUG] tag-profiles: ${filteredProfiles.length} profiles after cityBucket="${cityBucket}" filter`);

    // Merge any local overrides for this tag
    const overrides = loadTagOverrides();
    const overrideUids = (overrides[tag] || []).map(String);
    const existingUids = new Set(filteredProfiles.map(p => String(p.uid)));
    const missingUids = overrideUids.filter(uid => !existingUids.has(uid));
    if (missingUids.length > 0) {
      const stubs = await Promise.all(missingUids.map(fetchProfileStub));
      stubs.filter(Boolean).forEach(p => filteredProfiles.push(p));
    }

    if (scrape) getDb().then(db => upsertProfileCards(db, filteredProfiles)).catch(() => {});
    send(res, 200, JSON.stringify({
      tag,
      tagUrl: resolvedTagUrl,
      cityBucket,
      beforeCount: profiles.length,
      count: filteredProfiles.length,
      profiles: filteredProfiles,
    }), {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    });
  } catch (err) {
    send(res, 502, JSON.stringify({ error: err.message }), {
      'Content-Type': 'application/json; charset=utf-8',
    });
  }
}

module.exports = {
  handleRedvelvetProfileLookup,
  handleRedvelvetTagProfiles,
};
