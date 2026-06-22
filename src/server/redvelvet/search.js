'use strict';

const { send } = require('../utils/http');
const { CACHE_TTL_MS, RACIAL_TAGS } = require('../constants');
const { getRedvelvetAreaProfiles, getAreaSetForCityBucket, filterProfilesByCityBucket, buildRedvelvetAreaHashMap } = require('./areas');
const { fetchRedvelvetProfilesWithPostback } = require('./profiles');
const { resolveRedvelvetTagUrl } = require('./tags');
const { fetchProfileAgeAndBust } = require('./profile-details');
const { groupProfilesByPhone } = require('../utils/groups');

const tagProfileCache = new Map(); // tag label → { profiles, fetchedAt }

const CUP_INDEX = { A: 1, B: 2, C: 3, D: 4, DD: 5, E: 6, F: 7, G: 8, H: 9 };

function parseBust(str) {
  const m = String(str || '').trim().match(/^(\d+)\s*(A|B|C|DD|D|E|F|G|H)$/i);
  if (!m) return null;
  return { band: parseInt(m[1]), cup: m[2].toUpperCase() };
}

function bustVolumeGroup(band, cup) {
  const idx = CUP_INDEX[String(cup).toUpperCase()];
  return idx ? (band / 2) + idx : null;
}

async function fetchTagProfiles(tag, cityBucket) {
  const cacheKey = `${tag}:${cityBucket}`;
  const cached = tagProfileCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.profiles;

  const tagUrl = await resolveRedvelvetTagUrl(tag, '');
  if (!tagUrl) return [];
  const profiles = await fetchRedvelvetProfilesWithPostback(tagUrl);
  const [areaSet, areaMap] = await Promise.all([
    getAreaSetForCityBucket(cityBucket),
    buildRedvelvetAreaHashMap(),
  ]);
  const filtered = filterProfilesByCityBucket(profiles, areaSet, areaMap);
  tagProfileCache.set(cacheKey, { profiles: filtered, fetchedAt: Date.now() });
  return filtered;
}

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

async function handleRedvelvetSearch(req, res) {
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

  const cityBucket = String(body.cityBucket || '2');
  const includedAreas = Array.isArray(body.areas?.included) ? body.areas.included.filter(Boolean) : [];
  const excludedAreas = Array.isArray(body.areas?.excluded) ? body.areas.excluded.filter(Boolean) : [];
  const includedTags  = Array.isArray(body.tags?.included)  ? body.tags.included.filter(Boolean)  : [];
  const excludedTags  = Array.isArray(body.tags?.excluded)  ? body.tags.excluded.filter(Boolean)  : [];
  const ageMin  = body.age?.min  ? Number(body.age.min)  : null;
  const ageMax  = body.age?.max  ? Number(body.age.max)  : null;
  const bustBand = body.bust?.band ? parseInt(body.bust.band) : null;
  const bustCup  = body.bust?.cup  ? String(body.bust.cup).toUpperCase() : null;
  const bustMin  = body.bust?.range?.min != null ? Number(body.bust.range.min) : null;
  const bustMax  = body.bust?.range?.max != null ? Number(body.bust.range.max) : null;

  const hasIncludes = includedAreas.length > 0 || includedTags.length > 0;
  if (!hasIncludes) {
    send(res, 200, JSON.stringify({ count: 0, groups: [] }), { 'Content-Type': 'application/json; charset=utf-8' });
    return;
  }

  try {
    // Split included tags into racial (union) and other (intersection)
    const racialIncluded = includedTags.filter(t => RACIAL_TAGS.has(t));
    const otherIncluded  = includedTags.filter(t => !RACIAL_TAGS.has(t));

    // Fetch all in parallel
    const [areaResults, racialResults, otherResults] = await Promise.all([
      Promise.all(includedAreas.map(a => getRedvelvetAreaProfiles(a, cityBucket).then(r => r.profiles).catch(() => []))),
      Promise.all(racialIncluded.map(t => fetchTagProfiles(t, cityBucket).catch(() => []))),
      Promise.all(otherIncluded.map(t => fetchTagProfiles(t, cityBucket).catch(() => []))),
    ]);

    // Build UID sets
    const areaProfileMaps = areaResults.map(profiles => new Map(profiles.map(p => [p.uid, p])));

    // Merge all profile objects (areas override tags for richer data)
    const allObjects = new Map();
    for (const profiles of [...racialResults, ...otherResults]) for (const p of profiles) allObjects.set(p.uid, p);
    for (const m of areaProfileMaps) for (const [uid, p] of m) allObjects.set(uid, p);

    // Area union
    let areaUids = null;
    if (areaProfileMaps.length > 0) {
      areaUids = new Set();
      for (const m of areaProfileMaps) for (const uid of m.keys()) areaUids.add(uid);
    }

    // Racial tags → union
    let racialUids = null;
    if (racialResults.length > 0) {
      racialUids = new Set();
      for (const profiles of racialResults) for (const p of profiles) racialUids.add(p.uid);
    }

    // Other tags → intersection
    let otherUids = null;
    if (otherResults.length > 0) {
      const sets = otherResults.map(profiles => new Set(profiles.map(p => p.uid)));
      otherUids = sets.reduce((acc, set) => new Set([...acc].filter(uid => set.has(uid))), sets[0]);
    }

    // Combine racial union with other intersection
    let tagUids = null;
    if (racialUids && otherUids) {
      tagUids = new Set([...racialUids].filter(uid => otherUids.has(uid)));
    } else {
      tagUids = racialUids || otherUids;
    }

    let finalUids;
    if (tagUids && areaUids) {
      finalUids = new Set([...tagUids].filter(uid => areaUids.has(uid)));
    } else {
      finalUids = tagUids || areaUids;
    }

    // Fetch excluded profiles and subtract
    const [excludedAreaResults, excludedTagResults] = await Promise.all([
      Promise.all(excludedAreas.map(a => getRedvelvetAreaProfiles(a, cityBucket).then(r => r.profiles.map(p => p.uid)).catch(() => []))),
      Promise.all(excludedTags.map(t => fetchTagProfiles(t, cityBucket).then(ps => ps.map(p => p.uid)).catch(() => []))),
    ]);
    for (const uids of [...excludedAreaResults, ...excludedTagResults]) {
      for (const uid of uids) finalUids.delete(uid);
    }

    let profiles = [...finalUids].map(uid => allObjects.get(uid)).filter(Boolean);

    // Fetch detail pages when age/bust filters are active OR when tags are excluded
    // (tag listing pages may not include every profile that carries that tag)
    const hasBustFilter = bustBand !== null || bustCup !== null || bustMin !== null || bustMax !== null;
    const needsDetail = ageMin !== null || ageMax !== null || hasBustFilter || excludedTags.length > 0;
    if (needsDetail && profiles.length > 0) {
      const detailTasks = profiles.map(p => () => fetchProfileAgeAndBust(p.uid));
      const details = await pLimit(10, detailTasks);
      profiles = profiles.filter((p, i) => {
        const d = details[i];
        if (!d) return true; // detail fetch failed entirely — include rather than drop
        // Tag-based exclusion via profile detail (catches profiles missing from tag listing pages)
        if (excludedTags.length > 0 && Array.isArray(d.tags)) {
          const profileTags = d.tags.map(t => t.toLowerCase());
          if (excludedTags.some(et => profileTags.includes(et.toLowerCase()))) return false;
        }
        if (ageMin !== null && Number(d.age) < ageMin) return false;
        if (ageMax !== null && Number(d.age) > ageMax) return false;
        if (hasBustFilter) {
          const parsed = parseBust(d.bust);
          if (!parsed) return false; // bust not parseable — exclude when a bust filter is active
          const vol = bustVolumeGroup(parsed.band, parsed.cup);
          if (bustMin !== null && vol < bustMin) return false;
          if (bustMax !== null && vol > bustMax) return false;
          if (bustBand && bustCup) {
            if (vol !== bustVolumeGroup(bustBand, bustCup)) return false;
          } else if (bustCup) {
            if (parsed.cup !== bustCup) return false;
          } else if (bustBand) {
            if (parsed.band !== bustBand) return false;
          }
        }
        return true;
      });
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

module.exports = { handleRedvelvetSearch };
