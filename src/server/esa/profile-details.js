'use strict';

const { ESA_BASE_URL, CACHE_TTL_MS } = require('../constants');
const { fetchText, send } = require('../utils/http');
const { decodeHtmlEntities } = require('../utils/html');
const { getDb } = require('../db');
const { upsertProfileCard, upsertProfileDetails, loadProfileImageDocs, fetchPendingBinaries } = require('../utils/db-profiles');

const detailCache = new Map(); // uid → { data, fetchedAt }  (in-memory L1)

async function getCachedDetail(uid) {
  const mem = detailCache.get(uid);
  if (mem && Date.now() - mem.fetchedAt < CACHE_TTL_MS) return mem.data;
  try {
    const db  = await getDb();
    const doc = await db.collection('profileCache').findOne({ uid, provider: 'esa' });
    if (doc) {
      const age = Date.now() - new Date(doc.fetchedAt).getTime();
      if (age < CACHE_TTL_MS) {
        detailCache.set(uid, { data: doc.data, fetchedAt: new Date(doc.fetchedAt).getTime() });
        return doc.data;
      }
    }
  } catch { /* fall through to fetch */ }
  return null;
}

async function setCachedDetail(uid, data) {
  const fetchedAt = Date.now();
  detailCache.set(uid, { data, fetchedAt });
  try {
    const db = await getDb();
    await db.collection('profileCache').updateOne(
      { uid, provider: 'esa' },
      { $set: { uid, provider: 'esa', data, fetchedAt: new Date(fetchedAt) } },
      { upsert: true }
    );
  } catch { /* non-fatal — in-memory cache still works */ }
}

function parseEsaProfileDetails(uid, html) {
  // Name from <h2>
  const h2Match = html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
  const name = h2Match
    ? decodeHtmlEntities(h2Match[1].replace(/<[^>]+>/g, '')).trim()
    : `UID ${uid}`;

  // Area from <h1><a ...>Area</a></h1>
  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const h1Inner = h1Match ? h1Match[1] : '';
  const area = h1Inner.replace(/<[^>]+>/g, '').trim();

  // Area URL from <a href="..."> inside h1
  const areaHrefMatch = h1Inner.match(/href="([^"]+)"/i);
  const areaUrl = areaHrefMatch
    ? (areaHrefMatch[1].startsWith('http') ? areaHrefMatch[1] : `${ESA_BASE_URL}${areaHrefMatch[1]}`)
    : '';

  // Phone from tel: link
  const phoneMatch = html.match(/href="tel:([^"]+)"/i);
  const phone = phoneMatch ? phoneMatch[1].trim() : '';

  // Age from body text
  const ageMatch = html.match(/Age:\s*(\d+)/i);
  const age = ageMatch ? ageMatch[1] : '';

  // Thumbnail: prefer data-original or src on gallery/thumb image
  const thumbRe = /<img[^>]+(?:class="[^"]*(?:photo|thumb-v)[^"]*"|src="[^"]*\/client\/gallery\/srv\.php[^"]*")[^>]*>/i;
  const thumbElMatch = html.match(thumbRe);
  let thumbUrl = '';
  if (thumbElMatch) {
    const dataOrigMatch = thumbElMatch[0].match(/data-original="([^"]+)"/i);
    const srcMatch      = thumbElMatch[0].match(/src="([^"]+)"/i);
    const raw           = dataOrigMatch?.[1] || srcMatch?.[1] || '';
    thumbUrl = normalizeGalleryUrl(raw);
  }

  // Direct gallery URLs — all /client/gallery/srv.php references
  const galleryRe = /["']((?:https?:\/\/[^"']*)?\/client\/gallery\/srv\.php[^"']+)["']/gi;
  const seenGallery = new Set();
  const directImages = [];
  let gm;
  while ((gm = galleryRe.exec(html)) !== null) {
    const normalized = normalizeGalleryUrl(gm[1]);
    if (!seenGallery.has(normalized)) {
      seenGallery.add(normalized);
      directImages.push(normalized);
    }
  }

  // SubIds and their max picnum — expanded inline into image URLs
  const subIdRe = /subid=(\d+)/gi;
  const subIdMaxPic = new Map();
  let sm;
  while ((sm = subIdRe.exec(html)) !== null) {
    const id = sm[1];
    if (!subIdMaxPic.has(id)) subIdMaxPic.set(id, 0);
  }
  const subIdContextRe = /subid=(\d+)[^"']*picnum=(\d+)|picnum=(\d+)[^"']*subid=(\d+)/gi;
  let cm;
  while ((cm = subIdContextRe.exec(html)) !== null) {
    const id  = cm[1] || cm[4];
    const pic = parseInt(cm[2] || cm[3], 10);
    if (id && !isNaN(pic)) {
      subIdMaxPic.set(id, Math.max(subIdMaxPic.get(id) || 0, pic));
    }
  }

  const PICSERVER = 'https://goldmember.esa.co.za/picserver.php';
  for (const [id, maxPicNum] of subIdMaxPic.entries()) {
    const count = Math.max(1, Math.min(maxPicNum || 6, 30));
    for (let i = 1; i <= count; i++) {
      directImages.push(`${PICSERVER}?type=picsets&subid=${id}&picnum=${i}&size=large`);
    }
  }

  const profileUrl = `${ESA_BASE_URL}/escorts/viewEscort.php?uid=${uid}`;

  return {
    profile: { provider: 'esa', uid, name, area, areaUrl, thumbUrl, profileUrl, phone, age },
    images: directImages,
    videos: [],
  };
}

function normalizeGalleryUrl(raw) {
  if (!raw) return '';
  const absolute = raw.startsWith('http') ? raw : `${ESA_BASE_URL}${raw}`;
  return absolute.replace(/size=(?:medium|small|thumb_blur|original)/i, 'size=large');
}

function buildImageResponse(imgDocs) {
  return imgDocs
    .filter(d => d.type !== 'video')
    .map(d => ({ uid: d.uid, url: d.url, quality: d.quality || null, stored: !!d.fileId }));
}

async function fetchEsaProfileDetails(uid, scrape = false) {
  const relayBase = `http://localhost:${process.env.PORT || require('../constants').PORT}`;

  if (!scrape) {
    // DB-first: profile has been detail-scraped before
    try {
      const db  = await getDb();
      const doc = await db.collection('profiles').findOne({ provider: 'esa', providerUid: uid });
      if (doc && doc.age !== undefined) {
        const imgDocs = doc.images && doc.images.length
          ? await loadProfileImageDocs(db, doc._id)
          : [];

        const allStored = imgDocs.length > 0 && imgDocs.every(d => d.fileId);
        if (!allStored) fetchPendingBinaries(db, doc._id, relayBase);

        return {
          profile: {
            uid,
            name:       doc.name,
            area:       doc.areaName || '',
            profileUrl: doc.profileUrl,
            thumbUrl:   doc.thumbUrl,
            phone:      doc.phone || '',
            age:        doc.age   || '',
          },
          images: buildImageResponse(imgDocs),
          videos: [],
        };
      }
    } catch { /* fall through to cache/scrape */ }

    const cached = await getCachedDetail(uid);
    if (cached) return cached;
  }

  const url = `${ESA_BASE_URL}/escorts/viewEscort.php?uid=${encodeURIComponent(uid)}`;
  const html = await fetchText(url);
  const data = parseEsaProfileDetails(uid, html);

  await setCachedDetail(uid, data);

  // Write to DB then kick off background binary fetch
  getDb().then(async db => {
    const card = { provider: 'esa', uid, ...data.profile };
    const { _id } = await upsertProfileCard(db, new Map(), card);
    await upsertProfileDetails(db, _id, {
      age:        data.profile.age,
      imageUrls:  data.images,
      imageTypes: data.images.map(() => 'image'),
    });
    // Binaries not yet stored — fetch in background
    fetchPendingBinaries(db, _id, relayBase);
  }).catch(() => {});

  return data;
}

async function handleEsaProfileDetails(req, res) {
  const urlObj = new URL(req.url, 'http://localhost');
  const id     = urlObj.searchParams.get('id')     || '';
  const scrape = urlObj.searchParams.get('scrape') === 'true';

  if (!/^\d+$/.test(id)) {
    send(res, 400, JSON.stringify({ error: 'id must be numeric' }), { 'Content-Type': 'application/json; charset=utf-8' });
    return;
  }

  try {
    const data = await fetchEsaProfileDetails(id, scrape);
    send(res, 200, JSON.stringify(data), {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
  } catch (err) {
    send(res, 502, JSON.stringify({ error: err.message }), { 'Content-Type': 'application/json; charset=utf-8' });
  }
}

module.exports = { fetchEsaProfileDetails, handleEsaProfileDetails };
