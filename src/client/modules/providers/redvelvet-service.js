import { IMAGE_RELAY_BASE_URL, REDVELVET_BASE_URL, PROXY } from '../config.js';
import { fetchViaProxy } from '../http.js';

let capeTownAreaSetCache = null;

function normalizeAreaKey(value) {
  return String(value || '')
    .replace(/\+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

async function getCapeTownAreaSet() {
  if (capeTownAreaSetCache) return capeTownAreaSetCache;

  const relayBase = IMAGE_RELAY_BASE_URL.replace(/\/$/, '');
  if (!relayBase) return null;

  try {
    const response = await fetch(`${relayBase}/redvelvet-areas?cityBucket=2`);
    if (!response.ok) return null;
    const payload = await response.json();
    const areas = Array.isArray(payload?.areas) ? payload.areas : [];
    capeTownAreaSetCache = new Set(areas.map(normalizeAreaKey).filter(Boolean));
    return capeTownAreaSetCache;
  } catch {
    return null;
  }
}

async function filterCardsToCapeTown(cards) {
  const areaSet = await getCapeTownAreaSet();
  if (!areaSet || areaSet.size === 0) return cards;

  return cards.filter((card) => areaSet.has(normalizeAreaKey(card?.area || '')));
}

function parseRedvelvetProfileLink(href) {
  const absolute = href.startsWith('http') ? href : `${REDVELVET_BASE_URL}${href}`;
  const match = absolute.match(/\/escorts\/escorts_details\/([^/]+)\/([^/]+)\/(\d+)(?:\/?|$)/i);
  if (!match) return null;

  const name = decodeURIComponent(match[1]).replace(/\+/g, ' ');
  const area = decodeURIComponent(match[2]).replace(/\+/g, ' ');
  const uid = match[3];
  return { uid, name, area, profileUrl: absolute };
}

function toAbsoluteRedvelvetUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';

  try {
    if (raw.startsWith('//')) {
      return new URL(`https:${raw}`).toString();
    }
    return new URL(raw, `${REDVELVET_BASE_URL}/`).toString();
  } catch {
    if (/^https?:\/\//i.test(raw)) return raw;
    if (raw.startsWith('//')) return `https:${raw}`;
    return `${REDVELVET_BASE_URL}${raw.startsWith('/') ? '' : '/'}${raw}`;
  }
}

function extractRedvelvetThumbFromAnchor(anchor) {
  if (!anchor) return '';
  const image = anchor.querySelector('img');
  if (!image) return '';

  const candidates = [
    image.getAttribute('src'),
    image.getAttribute('data-src'),
    image.getAttribute('data-original'),
    image.getAttribute('data-lazy-src'),
  ];

  const picked = candidates.find(Boolean) || '';
  return toAbsoluteRedvelvetUrl(picked);
}

async function fetchRedvelvetProfilesPage(url, filterQuery, deps, options = {}) {
  const { setStatus, searchBtn } = deps;
  const { clearStatus = true } = options;

  const doc = await fetchViaProxy(
    url,
    (err) => {
      setStatus(`Error: ${err.message}`, true);
      console.error(err);
    },
    () => {
      if (searchBtn) searchBtn.disabled = false;
    },
  );
  if (!doc) return [];

  const cards = collectRedvelvetCardsFromDoc(doc, filterQuery, options);

  if (clearStatus) setStatus('');
  return cards;
}

function collectPagerTargets(doc) {
  if (!doc) return [];

  const targets = new Set();
  const links = Array.from(doc.querySelectorAll('a[href^="javascript:__doPostBack"]'));

  links.forEach((link) => {
    const href = link.getAttribute('href') || '';
    const match = href.match(/__doPostBack\('([^']+)'/i);
    if (!match) return;
    const target = match[1] || '';
    if (!target.toLowerCase().includes('datapager')) return;
    targets.add(target);
  });

  return Array.from(targets);
}

function buildPostbackFormFromDoc(doc, eventTarget) {
  const params = new URLSearchParams();

  Array.from(doc.querySelectorAll('input[type="hidden"][name]')).forEach((input) => {
    const name = input.getAttribute('name') || '';
    if (!name) return;
    params.set(name, input.getAttribute('value') || '');
  });

  params.set('__EVENTTARGET', eventTarget || '');
  params.set('__EVENTARGUMENT', '');
  return params;
}

async function fetchRedvelvetAreaAllPages(areaUrl, deps) {
  const { setStatus, searchBtn } = deps;

  const firstDoc = await fetchViaProxy(
    areaUrl,
    (err) => {
      setStatus(`Error: ${err.message}`, true);
      console.error(err);
    },
    () => {
      if (searchBtn) searchBtn.disabled = false;
    },
  );
  if (!firstDoc) return [];

  const byUid = new Map();
  const pageFingerprints = new Set();
  const seenTargets = new Set();
  const queue = [];

  const addCards = (doc) => {
    const cards = collectRedvelvetCardsFromDoc(doc, '', { filterBy: 'area' });
    cards.forEach((card) => {
      const key = String(card.uid || '').trim();
      if (!key || byUid.has(key)) return;
      byUid.set(key, card);
    });

    const fingerprint = cards
      .slice(0, 20)
      .map((c) => String(c.uid || '').trim())
      .filter(Boolean)
      .join(',');
    if (fingerprint) pageFingerprints.add(fingerprint);
  };

  const enqueueTargets = (doc) => {
    collectPagerTargets(doc).forEach((target) => {
      if (seenTargets.has(target)) return;
      seenTargets.add(target);
      queue.push({ target, doc });
    });
  };

  addCards(firstDoc);
  enqueueTargets(firstDoc);

  const MAX_POSTBACK_PAGES = 25;
  let traversed = 0;

  while (queue.length > 0 && traversed < MAX_POSTBACK_PAGES) {
    const next = queue.shift();
    if (!next?.target || !next?.doc) continue;

    traversed += 1;
    setStatus(`<span class="spinner"></span>Searching RedVelvet area pages (${traversed + 1})...`);

    // Intentional direct fetch with POST — fetchViaProxy only supports GET.
    const body = buildPostbackFormFromDoc(next.doc, next.target);
    let response;
    try {
      response = await fetch(`${PROXY}${encodeURIComponent(areaUrl)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
    } catch {
      continue;
    }

    if (!response.ok) continue;

    const html = await response.text();
    if (!html) continue;

    const pageDoc = new DOMParser().parseFromString(html, 'text/html');
    const beforeCount = pageFingerprints.size;
    addCards(pageDoc);
    enqueueTargets(pageDoc);

    // Stop if repeated pages dominate and no new page fingerprint is seen.
    if (pageFingerprints.size === beforeCount && traversed > 10) {
      break;
    }
  }

  setStatus('');
  if (searchBtn) searchBtn.disabled = false;
  return Array.from(byUid.values());
}

function collectRedvelvetCardsFromDoc(doc, filterQuery = '', options = {}) {
  if (!doc) return [];

  const cards = [];
  const byUid = new Set();
  const queryLower = String(filterQuery || '').trim().toLowerCase();
  const filterBy = options.filterBy || 'name';

  Array.from(doc.querySelectorAll('a[href*="/escorts/escorts_details/"]')).forEach(a => {
    const href = a.getAttribute('href') || '';
    const parsed = parseRedvelvetProfileLink(href);
    if (!parsed) return;

    if (queryLower) {
      const haystack = filterBy === 'area'
        ? parsed.area.toLowerCase()
        : parsed.name.toLowerCase();
      if (!haystack.includes(queryLower)) {
        return;
      }
    }

    const uidKey = String(parsed.uid || '').trim();
    if (!uidKey) return;
    if (byUid.has(uidKey)) return;
    byUid.add(uidKey);

    cards.push({
      provider: 'redvelvet',
      uid: parsed.uid,
      name: parsed.name,
      area: parsed.area,
      profileUrl: parsed.profileUrl,
      thumbUrl: extractRedvelvetThumbFromAnchor(a),
    });
  });

  return cards;
}

async function fetchRedvelvetQuickSearch(nickname, deps) {
  const searchUrl = `${REDVELVET_BASE_URL}/search/search`;
  const query = String(nickname || '').trim();
  if (!query) return [];

  // Step 1: load form and capture ASP.NET state fields.
  const formDoc = await fetchViaProxy(searchUrl, () => {}, () => {});
  if (!formDoc) return [];

  const read = (id) => formDoc.getElementById(id)?.getAttribute('value') || '';
  const params = new URLSearchParams();
  params.set('__EVENTTARGET', '');
  params.set('__EVENTARGUMENT', '');
  params.set('__VIEWSTATE', read('__VIEWSTATE'));
  params.set('__VIEWSTATEGENERATOR', read('__VIEWSTATEGENERATOR'));
  params.set('ctl00$ContentPlaceHolder1$HiddenField1', read('ctl00_ContentPlaceHolder1_HiddenField1') || 'detail');
  params.set('ctl00$ContentPlaceHolder1$txtSearch', query);
  params.set('ctl00$ContentPlaceHolder1$Button1', 'Search');
  params.set('ctl00$ContentPlaceHolder1$xxxx_ClientState', read('ctl00_ContentPlaceHolder1_xxxx_ClientState') || '::::::');
  params.set('ctl00$ContentPlaceHolder1$CascadingDropDown2_ClientState', read('ctl00_ContentPlaceHolder1_CascadingDropDown2_ClientState') || '::::::');
  params.set('hiddenInputToUpdateATBuffer_CommonToolkitScripts', '0');

  // Step 2: submit quick-search form through proxy — intentional direct POST.
  const response = await fetch(`${PROXY}${encodeURIComponent(searchUrl)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  if (!response.ok) return [];

  const html = await response.text();
  if (!html) return [];

  const resultDoc = new DOMParser().parseFromString(html, 'text/html');
  return collectRedvelvetCardsFromDoc(resultDoc, query, { filterBy: 'name' });
}

async function resolveRedvelvetAreaUrl(area, deps) {
  const normalizedArea = String(area || '').trim().toLowerCase();
  if (!normalizedArea) return '';

  const relayBase = IMAGE_RELAY_BASE_URL.replace(/\/$/, '');
  if (relayBase) {
    try {
      const response = await fetch(`${relayBase}/redvelvet-area?name=${encodeURIComponent(area)}`);
      if (response.ok) {
        const payload = await response.json();
        if (payload?.url) return payload.url;
      }
    } catch {
      // Fall back to client-side lookup below.
    }
  }

  const doc = await fetchViaProxy(`${REDVELVET_BASE_URL}/search/search`, () => {}, () => {});
  if (!doc) return '';

  const links = Array.from(doc.querySelectorAll('a[href*="/escorts/escorts_in_area/"]'));
  const exactMatch = links.find(link => {
    const text = (link.textContent || '')
      .replace(/\s+\d+\s*$/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    return text === normalizedArea;
  });

  if (!exactMatch) return '';

  const href = exactMatch.getAttribute('href') || '';
  return href.startsWith('http') ? href : `${REDVELVET_BASE_URL}${href}`;
}

export async function fetchRedvelvetProfilesByNickname(nickname, deps) {
  const { setStatus, searchBtn } = deps;
  setStatus('<span class="spinner"></span>Searching RedVelvet profiles...');

  // Prefer the site search endpoint first.
  try {
    const quickSearchCards = await fetchRedvelvetQuickSearch(nickname, deps);
    if (quickSearchCards.length > 0) {
      const filteredQuickSearchCards = await filterCardsToCapeTown(quickSearchCards);
      setStatus('');
      if (searchBtn) searchBtn.disabled = false;
      return filteredQuickSearchCards;
    }
  } catch {
    // Fall back to listing scans below.
  }

  // RedVelvet nickname matches are often spread across city pages.
  const sources = [
    `${REDVELVET_BASE_URL}/escorts`,
    `${REDVELVET_BASE_URL}/capetownescorts`,
    `${REDVELVET_BASE_URL}/johannesburgescorts`,
    `${REDVELVET_BASE_URL}/durbanescorts`,
    `${REDVELVET_BASE_URL}/pretoriaescorts`,
  ];

  const all = [];
  const seen = new Set();

  for (let i = 0; i < sources.length; i++) {
    setStatus(`<span class="spinner"></span>Searching RedVelvet profiles (${i + 1}/${sources.length})...`);
    const cards = await fetchRedvelvetProfilesPage(sources[i], nickname, deps, { clearStatus: false, filterBy: 'name' });

    cards.forEach(card => {
      const key = String(card.uid || '').trim();
      if (!key || seen.has(key)) return;
      seen.add(key);
      all.push(card);
    });
  }

  const filteredAll = await filterCardsToCapeTown(all);
  setStatus('');
  return filteredAll;
}

export async function fetchRedvelvetProfilesByArea(area, deps) {
  const { setStatus } = deps;
  setStatus('<span class="spinner"></span>Searching RedVelvet area...');

  const rawArea = String(area || '').trim();
  if (/^https?:\/\/.*\/escorts\/escorts_in_area\//i.test(rawArea)) {
    return fetchRedvelvetAreaAllPages(rawArea, deps);
  }

  const cityMap = {
    'cape town': '/capetownescorts',
    'johannesburg': '/johannesburgescorts',
    'durban': '/durbanescorts',
    'pretoria': '/pretoriaescorts',
  };

  const normalized = rawArea.toLowerCase();
  const cityPath = cityMap[normalized];

  try {
    const directAreaUrl = await resolveRedvelvetAreaUrl(rawArea, deps);
    if (directAreaUrl) {
      return fetchRedvelvetAreaAllPages(directAreaUrl, deps);
    }
  } catch {
    // Fall through to existing city/general listing behavior.
  }

  if (cityPath) {
    return fetchRedvelvetProfilesPage(`${REDVELVET_BASE_URL}${cityPath}`, '', deps);
  }

  return fetchRedvelvetProfilesPage(`${REDVELVET_BASE_URL}/escorts`, rawArea, deps, { filterBy: 'area' });
}

export async function fetchRedvelvetImagesFromProfile(uidOrId, deps) {
  const { setStatus, searchBtn } = deps;

  const isUrl = /^https?:\/\//i.test(uidOrId);
  const url = isUrl
    ? uidOrId
    : `${REDVELVET_BASE_URL}/escorts/escorts_details.aspx?userid=${encodeURIComponent(uidOrId)}`;

  const doc = await fetchViaProxy(
    url,
    (err) => {
      setStatus(`Error: ${err.message}`, true);
      console.error(err);
    },
    () => {
      setStatus('');
      if (searchBtn) searchBtn.disabled = false;
    },
  );
  if (!doc) return null;

  const h1Text = doc.querySelector('h1')?.textContent?.replace(/\s+/g, ' ').trim() || '';
  const title = h1Text.replace(/^\s+|\s+$/g, '');
  const areaFromTitle = (title.match(/\bin\s+(.+)$/i)?.[1] || '').trim();
  const areaFromUrl = (() => {
    const match = url.match(/\/escorts\/escorts_details\/[^/]+\/([^/]+)\/(\d+)(?:\/|$)/i);
    return match ? decodeURIComponent(match[1]).replace(/\+/g, ' ').trim() : '';
  })();
  const nameFromTitle = (title.split(/\bin\b/i)[0] || '').trim();
  const normalizedArea = areaFromUrl || areaFromTitle;
  const areaUrl = normalizedArea ? await resolveRedvelvetAreaUrl(normalizedArea, deps) : '';
  const phone = Array.from(doc.querySelectorAll('a')).map(a => a.textContent?.trim() || '')
    .find(t => /\d{3}\s*\d{3}/.test(t)) || '';

  const pathId = url.match(/\/(\d+)(?:\/?$)/)?.[1] || String(uidOrId).replace(/\D+/g, '');
  const images = Array.from(doc.querySelectorAll('img[src*="/uploadimages/"]'))
    .map(img => img.getAttribute('src') || '')
    .filter(Boolean)
    .map(src => (src.startsWith('http') ? src : `${REDVELVET_BASE_URL}${src}`));

  const directImages = Array.from(new Set(images));
  const profile = {
    provider: 'redvelvet',
    uid: pathId,
    name: nameFromTitle || `Profile ${pathId}`,
    area: normalizedArea,
    areaUrl,
    thumbUrl: directImages[0] || '',
    profileUrl: url,
    phone,
    age: '',
  };

  return { profile, directImages };
}
