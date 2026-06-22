'use strict';

const { ESA_BASE_URL, CACHE_TTL_MS } = require('../constants');
const { fetchText, send } = require('../utils/http');
const { decodeHtmlEntities } = require('../utils/html');

const detailCache = new Map(); // uid → { data, fetchedAt }

const SIZE_FALLBACKS = ['large', 'medium', 'small', 'thumb_blur'];
const PROBE_TIMEOUT_MS = 5000;
const PROBE_CONCURRENCY = 10;

function setSize(url, size) {
  return url.replace(/size=[^&]+/i, `size=${size}`);
}

async function probeSize(url) {
  for (const size of SIZE_FALLBACKS) {
    const candidate = setSize(url, size);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      const res = await fetch(candidate, { method: 'HEAD', signal: controller.signal, redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (res.ok) return candidate;
    } catch {
      // try next size
    } finally {
      clearTimeout(timer);
    }
  }
  return url; // return original if all fail — client can handle
}

async function resolveImageSizes(urls) {
  const sizeable = urls.map(u => /size=[^&]+/i.test(u));
  const results = new Array(urls.length);

  let idx = 0;
  async function next() {
    while (idx < urls.length) {
      const i = idx++;
      results[i] = sizeable[i] ? await probeSize(urls[i]) : urls[i];
    }
  }

  const workers = Array.from({ length: Math.min(PROBE_CONCURRENCY, urls.length) }, next);
  await Promise.all(workers);
  return results;
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

async function fetchEsaProfileDetails(uid) {
  const cached = detailCache.get(uid);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.data;

  const url = `${ESA_BASE_URL}/escorts/viewEscort.php?uid=${encodeURIComponent(uid)}`;
  const html = await fetchText(url);
  const parsed = parseEsaProfileDetails(uid, html);

  const [resolvedImages, resolvedThumb] = await Promise.all([
    resolveImageSizes(parsed.images),
    parsed.profile.thumbUrl && /size=[^&]+/i.test(parsed.profile.thumbUrl)
      ? probeSize(parsed.profile.thumbUrl)
      : Promise.resolve(parsed.profile.thumbUrl),
  ]);

  const data = {
    ...parsed,
    profile: { ...parsed.profile, thumbUrl: resolvedThumb },
    images: resolvedImages,
  };

  detailCache.set(uid, { data, fetchedAt: Date.now() });
  return data;
}

async function handleEsaProfileDetails(req, res) {
  const urlObj = new URL(req.url, 'http://localhost');
  const id = urlObj.searchParams.get('id') || '';

  if (!/^\d+$/.test(id)) {
    send(res, 400, JSON.stringify({ error: 'id must be numeric' }), { 'Content-Type': 'application/json; charset=utf-8' });
    return;
  }

  try {
    const data = await fetchEsaProfileDetails(id);
    send(res, 200, JSON.stringify(data), {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
  } catch (err) {
    send(res, 502, JSON.stringify({ error: err.message }), { 'Content-Type': 'application/json; charset=utf-8' });
  }
}

module.exports = { fetchEsaProfileDetails, handleEsaProfileDetails };
