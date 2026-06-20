import { BASE_URL } from '../config.js';
import {
  normalizeGalleryImageUrl,
  extractGalleryUrlsFromHtml,
  extractSubIdsFromHtml,
} from '../url-utils.js';
import { fetchViaProxy } from '../http.js';

function mapEsaAnchorToCard(anchor) {
  const href = anchor.getAttribute('href') || '';
  const uidMatch = href.match(/[?&]uid=(\d+)/i);
  if (!uidMatch) return null;

  const uid = uidMatch[1];
  const rawTitle = anchor.getAttribute('title') || anchor.textContent.trim();
  const label = rawTitle.replace(/escorts in cape town\s*:?\s*/i, '').trim();
  const [name = '', area = ''] = label.split(':').map(s => s.trim());

  const rawThumb = anchor.querySelector('img')?.getAttribute('src') || '';
  const thumbUrl = rawThumb.startsWith('http')
    ? rawThumb
    : (rawThumb.startsWith('/') ? `${BASE_URL}${rawThumb}` : rawThumb);

  const profileUrl = href.startsWith('http') ? href : `${BASE_URL}${href}`;

  return {
    provider: 'esa',
    uid,
    name: name || `UID ${uid}`,
    area,
    profileUrl,
    thumbUrl,
  };
}

async function fetchEsaProfiles(galleryUrl, deps, pageNumber = 1, collected = []) {
  const { setStatus, searchBtn } = deps;

  setStatus(`<span class="spinner"></span>Fetching page ${pageNumber}...`);

  const doc = await fetchViaProxy(
    `${galleryUrl}&page=${pageNumber}`,
    (err) => {
      setStatus(`Error: ${err.message}`, true);
      console.error(err);
    },
    () => {
      if (searchBtn) searchBtn.disabled = false;
    },
  );

  if (!doc) return collected;

  const pageCards = Array.from(doc.querySelectorAll('a[href^="/escorts/viewEscort.php"]'))
    .filter(a => a.getAttribute('href').includes('city=Cape+Town') && a.querySelector('img'))
    .map(mapEsaAnchorToCard)
    .filter(Boolean);
  collected.push(...pageCards);

  const hasNextPage = Array.from(doc.querySelectorAll('a'))
    .some(a => a.textContent.trim() === 'Next »');

  if (!hasNextPage) {
    setStatus('');
    return collected;
  }

  return fetchEsaProfiles(galleryUrl, deps, pageNumber + 1, collected);
}

export async function fetchEsaImagesFromProfile(uid, deps) {
  const { setStatus, searchBtn } = deps;

  const url = `${BASE_URL}/escorts/viewEscort.php?uid=${encodeURIComponent(uid)}`;
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

  const h1 = doc.querySelector('h1');
  const h1Anchor = h1?.querySelector('a');
  const telAnchor = doc.querySelector('a[href^="tel:"]');
  const bodyText = doc.body?.textContent ?? '';
  const ageMatch = bodyText.match(/Age:\s*(\d+)/);
  const thumbEl = doc.querySelector('img.photo, img.thumb-v, img[data-original*="/client/gallery/srv.php"], img[src*="/client/gallery/srv.php"]');
  const thumbRaw = thumbEl?.getAttribute('data-original') || thumbEl?.getAttribute('src') || '';
  const thumbUrl = normalizeGalleryImageUrl(thumbRaw);

  const profile = {
    provider: 'esa',
    uid,
    name: doc.querySelector('h2')?.textContent.trim() ?? '',
    area: h1?.textContent.trim() ?? '',
    areaUrl: h1Anchor ? BASE_URL + h1Anchor.getAttribute('href') : '',
    thumbUrl,
    profileUrl: url,
    phone: telAnchor?.textContent.trim() ?? '',
    age: ageMatch?.[1] ?? '',
  };

  const html = doc.documentElement?.outerHTML ?? '';
  const allHtmlGalleryUrls = extractGalleryUrlsFromHtml(html);
  const allHtmlSubIds = extractSubIdsFromHtml(html);

  return {
    profile,
    images: Array.from(doc.querySelectorAll('img')),
    galleryUrls: allHtmlGalleryUrls,
    subIds: allHtmlSubIds,
  };
}

export async function fetchEsaProfilesByNickname(nickname, deps) {
  const url = `${BASE_URL}/gallery.php?sp%5Bnickname%5D=${encodeURIComponent(nickname)}`;
  return fetchEsaProfiles(url, deps);
}

export async function fetchEsaProfilesByArea(area, deps) {
  const url = `${BASE_URL}/gallery.php?&sp[city]=Cape+Town&sp[area]=${encodeURIComponent(area)}`;
  return fetchEsaProfiles(url, deps);
}
