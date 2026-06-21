'use strict';

const { fetchText, send } = require('../utils/http');
const { decodeHtmlEntities, stripTags } = require('../utils/html');
const { findAreaEntryByName, buildRedvelvetAreaHashMap } = require('./areas');
const { URL } = require('url');

const REDVELVET_BASE = 'https://redvelvet.co.za';

function toAbsolute(src) {
  if (!src) return '';
  if (/^https?:\/\//i.test(src)) return src;
  if (src.startsWith('//')) return `https:${src}`;
  return `${REDVELVET_BASE}${src.startsWith('/') ? '' : '/'}${src}`;
}

function attr(html, tag, attrName) {
  const re = new RegExp(`<${tag}\\b[^>]*\\s${attrName}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i');
  const m = html.match(re);
  return m ? decodeHtmlEntities(m[2]) : '';
}

function parseProfileDetails(html, profileUrl) {
  // Name and area from URL segments
  const urlMatch = profileUrl.match(/\/escorts\/escorts_details\/([^/]+)\/([^/]+)\/(\d+)/i);
  const pathId   = urlMatch?.[3] || profileUrl.match(/\/(\d+)(?:\/?$)/)?.[1] || '';
  const nameFromUrl = urlMatch ? decodeURIComponent(urlMatch[1]).replace(/\+/g, ' ').trim() : '';
  const areaFromUrl = urlMatch ? decodeURIComponent(urlMatch[2]).replace(/\+/g, ' ').trim() : '';

  // Name/area fallback from h1
  const h1Match = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  const h1Text  = h1Match ? stripTags(decodeHtmlEntities(h1Match[1])).trim() : '';
  const nameFromH1 = h1Text.split(/\bin\b/i)[0].trim();
  const areaFromH1 = (h1Text.match(/\bin\s+(.+)$/i)?.[1] || '').trim();

  const name = nameFromUrl || nameFromH1 || `Profile ${pathId}`;
  const area = areaFromUrl || areaFromH1;

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

  // Images from /uploadimages/
  const imgPattern = /<img\b[^>]*src="([^"]*\/uploadimages\/[^"]+)"/gi;
  const images = [];
  const seenImgs = new Set();
  let im;
  while ((im = imgPattern.exec(html)) !== null) {
    const abs = toAbsolute(decodeHtmlEntities(im[1]));
    if (abs && !seenImgs.has(abs)) { seenImgs.add(abs); images.push(abs); }
  }

  return { pathId, name, area, age, bust, phone, tags, images };
}

async function fetchRedvelvetProfileDetails(profileUrl) {
  const html = await fetchText(profileUrl);
  const parsed = parseProfileDetails(html, profileUrl);

  // Resolve area URL server-side
  let areaUrl = '';
  if (parsed.area) {
    try {
      const areaMap = await buildRedvelvetAreaHashMap();
      const entry = findAreaEntryByName(areaMap, parsed.area, '2');
      if (entry) areaUrl = entry.url;
    } catch { /* non-fatal */ }
  }

  const profile = {
    provider: 'redvelvet',
    uid: parsed.pathId,
    name: parsed.name,
    area: parsed.area,
    areaUrl,
    thumbUrl: parsed.images[0] || '',
    profileUrl,
    phone: parsed.phone,
    age: parsed.age,
    bust: parsed.bust,
    tags: parsed.tags,
  };

  return { profile, directImages: parsed.images };
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
      'Cache-Control': 'public, max-age=300',
    });
  } catch (err) {
    send(res, 502, JSON.stringify({ error: err.message }), {
      'Content-Type': 'application/json; charset=utf-8',
    });
  }
}

module.exports = { fetchRedvelvetProfileDetails, handleRedvelvetProfileDetails };
