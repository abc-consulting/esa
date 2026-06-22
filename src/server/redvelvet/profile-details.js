'use strict';

const { send } = require('../utils/http');
const { decodeHtmlEntities, stripTags } = require('../utils/html');
const { findAreaEntryByName, buildRedvelvetAreaHashMap } = require('./areas');
const { getSessionCookie, clearSessionCookie } = require('./auth');
const { REQUEST_TIMEOUT_MS, CACHE_TTL_MS } = require('../constants');
const { URL } = require('url');

const REDVELVET_BASE = 'https://redvelvet.co.za';

const metaCache   = new Map(); // uid → { data: parsed meta, fetchedAt }
const detailCache = new Map(); // uid → { data: { profile, directImages, videos }, fetchedAt }

function toAbsolute(src, base = REDVELVET_BASE) {
  if (!src) return '';
  if (/^https?:\/\//i.test(src)) return src;
  if (src.startsWith('//')) return `https:${src}`;
  if (src.startsWith('/')) return `${REDVELVET_BASE}${src}`;
  // relative path — resolve against base
  try { return new URL(src, base).href; } catch { return `${REDVELVET_BASE}/${src}`; }
}

function attr(html, tag, attrName) {
  const re = new RegExp(`<${tag}\\b[^>]*\\s${attrName}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i');
  const m = html.match(re);
  return m ? decodeHtmlEntities(m[2]) : '';
}

function parseProfileDetails(html, profileUrl) {
  // Name and area from URL segments (slug or query-string after redirect)
  const urlMatch = profileUrl.match(/\/escorts\/escorts_details\/([^/]+)\/([^/]+)\/(\d+)/i);
  const qsMatch  = !urlMatch && profileUrl.match(/[?&]userid=(\d+)/i);
  const pathId   = urlMatch?.[3] || qsMatch?.[1] || profileUrl.match(/\/(\d+)(?:\/?$)/)?.[1] || '';
  const nameFromUrl = urlMatch ? decodeURIComponent(urlMatch[1]).replace(/\+/g, ' ').trim() : '';
  const areaFromUrl = urlMatch ? decodeURIComponent(urlMatch[2]).replace(/\+/g, ' ').trim() : '';

  // Name/area from slug link inside the page (handles ?userid= entry point)
  const slugInPage = html.match(/\/escorts\/escorts_details\/([^/]+)\/([^/]+)\/(\d+)/i);
  const nameFromSlug = slugInPage ? decodeURIComponent(slugInPage[1]).replace(/\+/g, ' ').trim() : '';
  const areaFromSlug = slugInPage ? decodeURIComponent(slugInPage[2]).replace(/\+/g, ' ').trim() : '';
  const uidFromSlug  = slugInPage?.[3] || '';

  // Name/area fallback from h1
  const h1Match = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  const h1Text  = h1Match ? stripTags(decodeHtmlEntities(h1Match[1])).trim() : '';
  const nameFromH1 = h1Text.split(/\bin\b/i)[0].trim();
  const areaFromH1 = (h1Text.match(/\bin\s+(.+)$/i)?.[1] || '').trim();

  const name = nameFromUrl || nameFromSlug || nameFromH1 || `Profile ${pathId}`;
  const area = areaFromUrl || areaFromSlug || areaFromH1;
  const uid  = pathId || uidFromSlug;

  // Age / bust from labelled elements
  const ageMatch  = html.match(/id="ctl00_ContentPlaceHolder1_lbl_age"[^>]*>([\s\S]*?)<\//i);
  const bustMatch = html.match(/id="ctl00_ContentPlaceHolder1_lbl_bust"[^>]*>([\s\S]*?)<\//i);
  const age  = ageMatch  ? stripTags(decodeHtmlEntities(ageMatch[1])).trim()  : '';
  const bust = bustMatch ? stripTags(decodeHtmlEntities(bustMatch[1])).trim() : '';

  // Tags
  const tagPattern = /<strong>([\s\S]*?)<\/strong>/gi;
  const tags = [];
  const tagSection = html.match(/class="category-tags-container"([\s\S]*?)(?:<\/div>\s*<\/div>|$)/i)?.[0] || '';
  let tm;
  while ((tm = tagPattern.exec(tagSection)) !== null) {
    const t = stripTags(decodeHtmlEntities(tm[1])).trim();
    if (t) tags.push(t);
  }

  // Phone
  const phoneMatch = html.match(/href="tel:([^"]+)"/i);
  const phone = phoneMatch ? phoneMatch[1].trim() : '';

  const seenMedia = new Set();
  const images = [];

  function addImage(src) {
    const abs = toAbsolute(decodeHtmlEntities(src));
    if (abs && !seenMedia.has(abs)) { seenMedia.add(abs); images.push(abs); }
  }

  // All /uploadimages/ references anywhere in the HTML — double or single quotes
  const uploadAnyRe = /["']((https?:\/\/[^"']*)?\/uploadimages\/[^"']+)["']/gi;
  let im;
  while ((im = uploadAnyRe.exec(html)) !== null) addImage(im[1]);

  // Selfie images from /selfies/up/ — double or single quotes
  const selfieRe = /src=["']([^"']*\/selfies\/up\/[^"']+)["']/gi;
  let sm;
  while ((sm = selfieRe.exec(html)) !== null) addImage(sm[1]);

  // Videos link: /selfies/escort_videos/Name/Area/UID
  const videoPageHref = (html.match(/href=["'](\/selfies\/escort_videos\/[^"']+)["']/i) || [])[1] || '';

  // Raw/uncensored images link: /escorts/raw_escort_details/Name/Area/UID (href may be relative)
  const rawPageHref = (html.match(/href=["']([^"']*raw_escort_details\/[^"']+)["']/i) || [])[1] || '';

  return { uid, name, area, age, bust, phone, tags, images, videoPageUrl: videoPageHref ? toAbsolute(videoPageHref, profileUrl) : '', rawPageUrl: rawPageHref ? toAbsolute(rawPageHref, profileUrl) : '' };
}

function parseRawPage(html) {
  const images = [];
  const seen = new Set();
  const gallerySection = html.match(/class="gallery-container"([\s\S]*)/i)?.[0] || html;
  const re = /<img\b[^>]*src="([^"]*\/uploadimages\/[^"]+)"/gi;
  let m;
  while ((m = re.exec(gallerySection)) !== null) {
    const abs = toAbsolute(decodeHtmlEntities(m[1]));
    if (abs && !seen.has(abs)) { seen.add(abs); images.push(abs); }
  }
  return images;
}

function parseVideoPage(html) {
  const videos = [];
  const seenMedia = new Set();
  // <source src="/selfies/up/....mp4#t=0.5" ...>
  const srcRe = /<source\b[^>]*src=["']([^"']*\/selfies\/up\/[^"']+\.(?:mp4|webm|ogg|mov))[^"']*["']/gi;
  let m;
  while ((m = srcRe.exec(html)) !== null) {
    // strip fragment (#t=0.5) for clean URL
    const clean = toAbsolute(decodeHtmlEntities(m[1]).replace(/#.*$/, ''));
    if (clean && !seenMedia.has(clean)) { seenMedia.add(clean); videos.push(clean); }
  }
  return videos;
}

async function fetchAuthenticated(url, returnFinalUrl = false) {
  const cookie = await getSessionCookie();
  const headers = { 'User-Agent': 'Mozilla/5.0', ...(cookie ? { Cookie: cookie } : {}) };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { redirect: 'follow', signal: controller.signal, headers });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const finalUrl = res.url || url;

  // If redirected to login page the session has expired — clear and retry once without auth
  if (/userlogin\/login/i.test(finalUrl) || /members\/login/i.test(finalUrl) || /ctl00_ContentPlaceHolder1_txtLoginEmail/i.test(html)) {
    clearSessionCookie();
    const controller2 = new AbortController();
    const timer2 = setTimeout(() => controller2.abort(), REQUEST_TIMEOUT_MS);
    let res2;
    try {
      res2 = await fetch(url, { redirect: 'follow', signal: controller2.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!res2.ok) throw new Error(`HTTP ${res2.status}`);
    } finally {
      clearTimeout(timer2);
    }
    const html2 = await res2.text();
    return returnFinalUrl ? { html: html2, finalUrl: res2.url || url } : html2;
  }

  return returnFinalUrl ? { html, finalUrl } : html;
}

async function fetchProfileMeta(uid) {
  const cached = metaCache.get(uid);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.data;

  const profileUrl = `${REDVELVET_BASE}/escorts/escorts_details.aspx?userid=${uid}`;
  const { html, finalUrl } = await fetchAuthenticated(profileUrl, true);
  const parsed = parseProfileDetails(html, finalUrl);

  const areaEntry = parsed.area
    ? await buildRedvelvetAreaHashMap().then(m => findAreaEntryByName(m, parsed.area, '2')).catch(() => null)
    : null;

  const data = {
    uid: parsed.uid || uid,
    name: parsed.name,
    area: parsed.area,
    areaUrl: areaEntry?.url || '',
    thumbUrl: parsed.images[0] || '',
    profileUrl: finalUrl,
    phone: parsed.phone,
    age: parsed.age,
    bust: parsed.bust,
    tags: parsed.tags,
    // store for use by fetchRedvelvetProfileDetails
    _parsed: { images: parsed.images, videoPageUrl: parsed.videoPageUrl, rawPageUrl: parsed.rawPageUrl },
  };

  metaCache.set(String(uid), { data, fetchedAt: Date.now() });
  return data;
}

async function fetchRedvelvetProfileDetails(profileUrl) {
  // Extract uid from URL so we can check/store caches by uid
  const uidMatch = profileUrl.match(/\/(\d+)(?:[/?#]|$)/) || profileUrl.match(/userid=(\d+)/i);
  const uid = uidMatch ? uidMatch[1] : null;

  if (uid) {
    const cached = detailCache.get(uid);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.data;
  }

  // Use meta cache if available to avoid re-fetching the profile page
  let meta;
  if (uid) {
    try { meta = await fetchProfileMeta(uid); } catch { meta = null; }
  }

  let parsed, finalUrl, areaEntry;
  if (meta) {
    parsed = meta._parsed;
    finalUrl = meta.profileUrl;
    areaEntry = meta.areaUrl ? { url: meta.areaUrl } : null;
  } else {
    const result = await fetchAuthenticated(profileUrl, true);
    finalUrl = result.finalUrl;
    parsed = parseProfileDetails(result.html, finalUrl);
    areaEntry = parsed.area
      ? await buildRedvelvetAreaHashMap().then(m => findAreaEntryByName(m, parsed.area, '2')).catch(() => null)
      : null;
  }

  // Fetch images and videos (on-demand only, not during search)
  const [videosFromPage, rawImages] = await Promise.all([
    parsed.videoPageUrl
      ? fetchAuthenticated(parsed.videoPageUrl).then(vhtml => parseVideoPage(vhtml)).catch(() => [])
      : Promise.resolve([]),
    parsed.rawPageUrl
      ? fetchAuthenticated(parsed.rawPageUrl).then(rhtml => parseRawPage(rhtml)).catch(() => [])
      : Promise.resolve([]),
  ]);

  const profile = meta
    ? { provider: 'redvelvet', uid: meta.uid, name: meta.name, area: meta.area, areaUrl: meta.areaUrl, thumbUrl: meta.thumbUrl, profileUrl: finalUrl, phone: meta.phone, age: meta.age, bust: meta.bust, tags: meta.tags }
    : { provider: 'redvelvet', uid: parsed.uid, name: parsed.name, area: parsed.area, areaUrl: areaEntry?.url || '', thumbUrl: parsed.images[0] || '', profileUrl: finalUrl, phone: parsed.phone, age: parsed.age, bust: parsed.bust, tags: parsed.tags };

  const seenImages = new Set(parsed.images);
  const allImages = [...parsed.images];
  for (const url of rawImages) {
    if (!seenImages.has(url)) { seenImages.add(url); allImages.push(url); }
  }

  const result = { profile, directImages: allImages, videos: videosFromPage };
  if (uid) detailCache.set(uid, { data: result, fetchedAt: Date.now() });
  return result;
}

async function handleRedvelvetProfileDetails(req, res, serverBase) {
  const incoming = new URL(req.url, serverBase);
  const rawId = (incoming.searchParams.get('id') || '').trim();

  if (!rawId || !/^\d+$/.test(rawId)) {
    send(res, 400, JSON.stringify({ error: 'Missing or invalid id param (must be numeric)' }), {
      'Content-Type': 'application/json; charset=utf-8',
    });
    return;
  }

  const profileUrl = `${REDVELVET_BASE}/escorts/escorts_details.aspx?userid=${rawId}`;

  try {
    const result = await fetchRedvelvetProfileDetails(profileUrl);
    send(res, 200, JSON.stringify(result), {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
  } catch (err) {
    send(res, 502, JSON.stringify({ error: err.message }), {
      'Content-Type': 'application/json; charset=utf-8',
    });
  }
}

async function fetchProfileAgeAndBust(uid) {
  try {
    const meta = await fetchProfileMeta(uid);
    return { age: meta.age, bust: meta.bust };
  } catch {
    return null;
  }
}

module.exports = { fetchProfileMeta, fetchRedvelvetProfileDetails, handleRedvelvetProfileDetails, fetchProfileAgeAndBust };
