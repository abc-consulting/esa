'use strict';

const { ESA_BASE_URL, ESA_GALLERY_URL } = require('../constants');
const { fetchText, send } = require('../utils/http');
const { groupProfilesByPhone } = require('../utils/groups');

const MAX_PAGES = 50;

function parseEsaProfileCards(html) {
  const cards = [];
  const seen = new Set();

  // Each card is wrapped in a div with class ad-preview or ad-preview2
  const cardRe = /<div class="ad-preview\d?">([\s\S]*?)<\/div>\s*<\/div>/gi;
  let card;
  while ((card = cardRe.exec(html)) !== null) {
    const block = card[1];

    // UID from any viewEscort href in the block
    const uidMatch = block.match(/\/escorts\/viewEscort\.php\?[^"]*uid=(\d+)/i);
    if (!uidMatch) continue;
    const uid = uidMatch[1];
    if (seen.has(uid)) continue;
    seen.add(uid);

    const href = block.match(/href="(\/escorts\/viewEscort\.php\?[^"]+)"/i)?.[1] || '';
    const profileUrl = href ? `${ESA_BASE_URL}${href}` : `${ESA_BASE_URL}/escorts/viewEscort.php?uid=${uid}`;

    // Name from header anchor text
    const headerMatch = block.match(/ad-preview-header[^>]*>[\s\S]*?<a[^>]*>([^<]+)<\/a>/i);
    const name = headerMatch ? headerMatch[1].trim() : `UID ${uid}`;

    // Area from footer anchor text
    const footerMatch = block.match(/ad-preview-footer[^>]*>[\s\S]*?<a[^>]*>([^<]+)<\/a>/i);
    const area = footerMatch ? footerMatch[1].trim() : '';

    // Thumbnail: prefer data-original, fall back to src
    const dataOrigMatch = block.match(/data-original="([^"]+)"/i);
    const srcMatch      = block.match(/<img[^>]+src="([^"]+)"/i);
    const rawThumb      = dataOrigMatch?.[1] || srcMatch?.[1] || '';
    const thumbUrl      = rawThumb.startsWith('http')
      ? rawThumb
      : rawThumb.startsWith('/')
        ? `${ESA_BASE_URL}${rawThumb}`
        : rawThumb;

    const phoneMatch = block.match(/href="tel:([^"]+)"/i);
    const phone = phoneMatch ? phoneMatch[1].trim() : '';

    cards.push({ provider: 'esa', uid, name, area, profileUrl, thumbUrl, phone });
  }

  return cards;
}

async function fetchEsaProfiles(galleryUrl) {
  const collected = [];
  const seen = new Set();

  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${galleryUrl}&page=${page}`;
    let html;
    try {
      html = await fetchText(url);
    } catch (err) {
      if (page === 1) throw err;
      break;
    }

    const cards = parseEsaProfileCards(html);
    for (const card of cards) {
      if (!seen.has(card.uid)) {
        seen.add(card.uid);
        collected.push(card);
      }
    }

    if (!html.includes('Next »')) break;
  }

  return collected;
}

async function handleEsaProfilesByNickname(req, res) {
  const urlObj = new URL(req.url, `http://localhost`);
  const nickname = urlObj.searchParams.get('nickname') || '';
  if (!nickname) {
    send(res, 400, JSON.stringify({ error: 'nickname required' }), { 'Content-Type': 'application/json; charset=utf-8' });
    return;
  }

  try {
    const url = `${ESA_GALLERY_URL}?sp%5Bnickname%5D=${encodeURIComponent(nickname)}&sp[city]=Cape+Town`;
    const profiles = await fetchEsaProfiles(url);
    const groups = groupProfilesByPhone(profiles);
    send(res, 200, JSON.stringify({ count: profiles.length, groups }), {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
  } catch (err) {
    send(res, 502, JSON.stringify({ error: err.message }), { 'Content-Type': 'application/json; charset=utf-8' });
  }
}

async function handleEsaProfilesByArea(req, res) {
  const urlObj = new URL(req.url, `http://localhost`);
  const area = urlObj.searchParams.get('area') || '';
  if (!area) {
    send(res, 400, JSON.stringify({ error: 'area required' }), { 'Content-Type': 'application/json; charset=utf-8' });
    return;
  }

  try {
    const url = `${ESA_GALLERY_URL}?sp[city]=Cape+Town&sp[area]=${encodeURIComponent(area)}`;
    const profiles = await fetchEsaProfiles(url);
    const groups = groupProfilesByPhone(profiles);
    send(res, 200, JSON.stringify({ count: profiles.length, groups }), {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
  } catch (err) {
    send(res, 502, JSON.stringify({ error: err.message }), { 'Content-Type': 'application/json; charset=utf-8' });
  }
}

module.exports = { fetchEsaProfiles, handleEsaProfilesByNickname, handleEsaProfilesByArea };
