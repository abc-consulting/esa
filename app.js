// ─── CONFIGURATION ────────────────────────────────────────────────────────

const BASE_URL = 'https://www.esa.co.za';
const PROXY    = 'https://corsproxy.io/?';
const STORAGE_KEYS = {
  favorites: 'esa.favorites',
  lastSearch: 'esa.lastSearch',
};

// ─── DOM REFERENCES ───────────────────────────────────────────────────────

const searchBtn               = document.getElementById('searchBtn');
const profilesContainer       = document.getElementById('profiles-container');
const imagesContainer         = document.getElementById('images-container');
const profileDetailsContainer = document.getElementById('profile-details-container');

// ─── STATE ────────────────────────────────────────────────────────────────

let subIdArray   = [];
let profileLinks = [];
let galleryImageUrls = [];
let subIdPicCounts = new Map();
let failedImagesBySubId = new Map();
let favorites = [];

// ─── STATUS ───────────────────────────────────────────────────────────────

function setStatus(msg, isError = false) {
  const el = document.getElementById('status');
  el.innerHTML = msg;
  el.className = isError ? 'error' : '';
}

function parseJsonStorage(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJsonStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore storage failures (private mode/quota).
  }
}

function extractUidFromUrl(url) {
  if (!url) return '';
  const match = String(url).match(/[?&]uid=(\d+)/i);
  return match ? match[1] : '';
}

function loadFavorites() {
  const stored = parseJsonStorage(STORAGE_KEYS.favorites, []);
  favorites = Array.isArray(stored) ? stored.filter(f => f?.uid) : [];
}

function saveFavorites() {
  writeJsonStorage(STORAGE_KEYS.favorites, favorites);
}

function isFavorite(uid) {
  return favorites.some(f => f.uid === uid);
}

function persistLastSearch(type, value) {
  const cleanValue = String(value || '').trim();
  if (!cleanValue) return;
  writeJsonStorage(STORAGE_KEYS.lastSearch, {
    type,
    value: cleanValue,
    at: Date.now(),
  });
}

function renderFavoritesPanel() {
  const container = document.getElementById('favorites-container');
  if (!container) return;

  if (favorites.length === 0) {
    container.innerHTML = '<div class="favorites-empty">No favorites yet.</div>';
    return;
  }

  const list = document.createElement('div');
  list.className = 'favorites-list';

  favorites.forEach(favorite => {
    const row = document.createElement('div');
    row.className = 'favorite-item';

    const openBtn = document.createElement('button');
    openBtn.className = 'favorite-link';
    openBtn.title = `Load profile ${favorite.uid}`;
    openBtn.addEventListener('click', () => {
      document.getElementById('searchInput').value = favorite.uid;
      persistLastSearch('uid', favorite.uid);
      fetchImagesFromProfile(favorite.uid);
    });

    const avatar = document.createElement('img');
    avatar.className = 'favorite-avatar';
    avatar.alt = `${favorite.name || 'Profile'} thumbnail`;
    avatar.src = favorite.thumbUrl || '';
    avatar.onerror = function () {
      this.style.display = 'none';
    };

    const label = document.createElement('span');
    label.className = 'favorite-label';
    label.textContent = favorite.area
      ? `${favorite.name || 'Profile'} (${favorite.area})`
      : `${favorite.name || 'Profile'} (${favorite.uid})`;

    openBtn.append(avatar, label);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'favorite-remove-x';
    removeBtn.textContent = '×';
    removeBtn.title = `Remove ${favorite.name || favorite.uid}`;
    removeBtn.addEventListener('click', () => {
      favorites = favorites.filter(f => f.uid !== favorite.uid);
      saveFavorites();
      renderFavoritesPanel();
      const activeUid = extractUidFromUrl(document.querySelector('.profile-details-name')?.href || '');
      if (activeUid && activeUid === favorite.uid) {
        const btn = document.getElementById('favorite-toggle-btn');
        if (btn) btn.textContent = 'Add To Favorites';
      }
    });

    row.append(openBtn, removeBtn);
    list.appendChild(row);
  });

  container.innerHTML = '';
  container.appendChild(list);
}

function toggleFavorite(profile) {
  const uid = profile?.uid || extractUidFromUrl(profile?.profileUrl);
  if (!uid) return;

  if (isFavorite(uid)) {
    favorites = favorites.filter(f => f.uid !== uid);
  } else {
    favorites.unshift({
      uid,
      name: profile.name || `UID ${uid}`,
      area: profile.area || '',
      thumbUrl: profile.thumbUrl || '',
      profileUrl: profile.profileUrl || `${BASE_URL}/escorts/viewEscort.php?uid=${uid}`,
      savedAt: Date.now(),
    });
  }

  saveFavorites();
  renderFavoritesPanel();

  const btn = document.getElementById('favorite-toggle-btn');
  if (btn) btn.textContent = isFavorite(uid) ? 'Remove Favorite' : 'Add To Favorites';
}

function restoreLastSearch() {
  const last = parseJsonStorage(STORAGE_KEYS.lastSearch, null);
  if (!last?.type || !last?.value) return;

  if (last.type === 'area') {
    document.getElementById('areaInput').value = last.value;
    doAreaSearch();
    return;
  }

  document.getElementById('searchInput').value = last.value;
  doSearch();
}

// ─── HELPERS ──────────────────────────────────────────────────────────────

/**
 * Extract a subId from an image src string.
 * Tries several URL patterns used by ESA:
 *   1. ?subid=123 or &subid=123
 *   2. ?picset_id=123
 *   3. Picset-like numeric path segment in known image paths
 *
 * Note: profile uid is not a reliable picset subId and must be ignored.
 */
function extractSubId(src) {
  if (!src) return null;

  const normalized = src.replace(/&amp;/gi, '&').trim();

  const explicitMatch = normalized.match(/[?&](subid|picset_id|picsetid)=(\d+)/i);
  if (explicitMatch) {
    return explicitMatch[2];
  }

  // Only allow a path-based numeric fallback for known picset image hosts/paths.
  if (/picserver\.php/i.test(normalized) || /\/picsets?\//i.test(normalized)) {
    const pathMatch = normalized.match(/\/(\d{4,})(?:[\/\.]|$)/);
    if (pathMatch) return pathMatch[1];
  }

  return null;
}

/**
 * Fetch a URL through the CORS proxy and return a parsed DOM document.
 * Calls onError(err) on failure and onFinally() in either case.
 */
async function fetchViaProxy(url, onError, onFinally) {
  try {
    const response = await fetch(PROXY + encodeURIComponent(url));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const html = await response.text();
    if (!html) throw new Error('Empty response from proxy.');

    return new DOMParser().parseFromString(html, 'text/html');
  } catch (err) {
    onError(err);
  } finally {
    onFinally();
  }
}

// ─── CLEAR HELPERS ────────────────────────────────────────────────────────

function clearProfiles() {
  profilesContainer.innerHTML = '';
  profileLinks = [];
}

function clearImages() {
  imagesContainer.innerHTML = '';
  failedImagesBySubId = new Map();
  renderFailedImagesPanel();
}

function clearProfileDetails() {
  profileDetailsContainer.innerHTML = '';
}

function ensureFailedImagesContainer() {
  let container = document.getElementById('failed-images-container');
  if (container) return container;

  container = document.createElement('div');
  container.id = 'failed-images-container';

  const statusEl = document.getElementById('status');
  if (statusEl?.parentNode) {
    statusEl.parentNode.insertBefore(container, statusEl.nextSibling);
  }

  return container;
}

function renderFailedImagesPanel() {
  const container = ensureFailedImagesContainer();
  if (!container) return;

  const totalFailed = Array.from(failedImagesBySubId.values())
    .reduce((sum, urls) => sum + urls.size, 0);

  if (totalFailed === 0) {
    container.innerHTML = '';
    return;
  }

  const details = document.createElement('details');
  details.className = 'failed-images-details';

  const summary = document.createElement('summary');
  summary.textContent = `Failed images: ${totalFailed}`;
  details.appendChild(summary);

  const groups = Array.from(failedImagesBySubId.entries());
  groups.sort((a, b) => {
    if (a[0] === 'unknown') return 1;
    if (b[0] === 'unknown') return -1;
    return Number(a[0]) - Number(b[0]);
  });

  groups.forEach(([subId, urls]) => {
    const groupWrap = document.createElement('details');
    groupWrap.className = 'failed-images-group';

    const groupTitle = document.createElement('summary');
    const label = subId === 'unknown' ? 'Unknown subId' : `subId ${subId}`;
    groupTitle.textContent = `${label} (${urls.size})`;
    groupWrap.appendChild(groupTitle);

    const list = document.createElement('ul');
    const sortedUrls = Array.from(urls).sort((a, b) => {
      const aNum = extractPicNum(a) ?? Number.MAX_SAFE_INTEGER;
      const bNum = extractPicNum(b) ?? Number.MAX_SAFE_INTEGER;
      return aNum - bNum;
    });

    sortedUrls.forEach(url => {
      const item = document.createElement('li');
      const link = document.createElement('a');
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      const picNum = extractPicNum(url);
      link.textContent = picNum ? `picnum ${picNum}` : 'picnum unknown';
      item.appendChild(link);
      list.appendChild(item);
    });

    groupWrap.appendChild(list);
    details.appendChild(groupWrap);
  });

  container.innerHTML = '';
  container.appendChild(details);
}

function recordFailedImage(url) {
  if (!url) return;

  const subId = extractSubId(url) || 'unknown';
  if (!failedImagesBySubId.has(subId)) {
    failedImagesBySubId.set(subId, new Set());
  }
  failedImagesBySubId.get(subId).add(url);

  renderFailedImagesPanel();
}

// ─── SEARCH ENTRY POINTS ──────────────────────────────────────────────────

async function doSearch() {
  const query = document.getElementById('searchInput').value.trim();
  if (!query) {
    setStatus('Please enter a search term.', true);
    return;
  }

  clearProfiles();
  clearImages();
  clearProfileDetails();
  subIdArray = [];
  document.getElementById('selected-output').style.display = 'none';
  setStatus('<span class="spinner"></span>Fetching results…');
  searchBtn.disabled = true;

  persistLastSearch(/^\d+$/.test(query) ? 'uid' : 'nickname', query);

  if (/^\d+$/.test(query)) {
    await fetchImagesFromProfile(query);
  } else {
    await fetchProfilesByNickname(query);
  }
}

async function doAreaSearch() {
  const area = document.getElementById('areaInput').value.trim();
  if (!area) return;
  persistLastSearch('area', area);
  fetchProfilesByArea(area);
}

// ─── PROFILE FETCHING ─────────────────────────────────────────────────────

async function fetchImagesFromProfile(uid) {
  const url = `${BASE_URL}/escorts/viewEscort.php?uid=${encodeURIComponent(uid)}`;
  const doc = await fetchViaProxy(
    url,
    (err) => { setStatus(`Error: ${err.message}`, true); console.error(err); },
    ()    => { setStatus(''); searchBtn.disabled = false; },
  );

  if (!doc) return;

  const h1        = doc.querySelector('h1');
  const h1Anchor  = h1?.querySelector('a');
  const telAnchor = doc.querySelector('a[href^="tel:"]');
  const bodyText  = doc.body?.textContent ?? '';
  const ageMatch  = bodyText.match(/Age:\s*(\d+)/);
  const thumbEl = doc.querySelector('img.photo, img.thumb-v, img[data-original*="/client/gallery/srv.php"], img[src*="/client/gallery/srv.php"]');
  const thumbRaw = thumbEl?.getAttribute('data-original') || thumbEl?.getAttribute('src') || '';
  const thumbUrl = normalizeGalleryImageUrl(thumbRaw);

  const profile = {
    uid,
    name:    doc.querySelector('h2')?.textContent.trim() ?? '',
    area:    h1?.textContent.trim() ?? '',
    areaUrl: h1Anchor ? BASE_URL + h1Anchor.getAttribute('href') : '',
    thumbUrl,
    profileUrl: url,
    phone:   telAnchor?.textContent.trim() ?? '',
    age:     ageMatch?.[1] ?? '',
  };

  renderProfileDetails(profile);

  const html = doc.documentElement?.outerHTML ?? '';
  const allHtmlGalleryUrls = extractGalleryUrlsFromHtml(html);
  const allHtmlSubIds = extractSubIdsFromHtml(html);
  // Scan all images and combine with full-page URL and subId extraction.
  processImages(Array.from(doc.querySelectorAll('img')), allHtmlGalleryUrls, allHtmlSubIds);
}

async function fetchProfilesByNickname(nickname) {
  clearProfiles();
  const url = `${BASE_URL}/gallery.php?sp%5Bnickname%5D=${encodeURIComponent(nickname)}`;
  await processProfiles(url);
}

async function fetchProfilesByArea(area) {
  clearImages();
  clearProfiles();
  clearProfileDetails();

  const header = document.createElement('h2');
  header.className   = 'area-name';
  header.textContent = area;
  profilesContainer.appendChild(header);

  const url = `${BASE_URL}/gallery.php?&sp[city]=Cape+Town&sp[area]=${encodeURIComponent(area)}`;
  await processProfiles(url);
}

// ─── GALLERY PAGINATION ───────────────────────────────────────────────────

async function processProfiles(galleryUrl, pageNumber = 1) {
  setStatus(`<span class="spinner"></span>Fetching page ${pageNumber}…`);

  const doc = await fetchViaProxy(
    `${galleryUrl}&page=${pageNumber}`,
    (err) => { setStatus(`Error: ${err.message}`, true); console.error(err); },
    ()    => { searchBtn.disabled = false; },
  );

  if (!doc) return;

  const pageLinks = Array.from(doc.querySelectorAll('a[href^="/escorts/viewEscort.php"]'))
    .filter(a => a.getAttribute('href').includes('city=Cape+Town') && a.querySelector('img'));
  profileLinks.push(...pageLinks);

  const hasNextPage = Array.from(doc.querySelectorAll('a'))
    .some(a => a.textContent.trim() === 'Next »');

  if (hasNextPage) {
    await processProfiles(galleryUrl, pageNumber + 1);
  } else {
    setStatus('');
    renderProfileCards();
  }
}

// ─── RENDERING ────────────────────────────────────────────────────────────

function renderProfileCards() {
  profileLinks.forEach((a, index) => {
    const href     = a.getAttribute('href');
    const uidMatch = href.match(/uid=(\d+)/);
    if (!uidMatch) return;

    const uid      = uidMatch[1];
    const rawTitle = a.getAttribute('title') || a.textContent.trim();
    const label    = rawTitle.replace(/escorts in cape town\s*:?\s*/i, '').trim();
    const [namePart = '', numberPart = ''] = label.split(':').map(s => s.trim());

    const wrapper = document.createElement('div');
    wrapper.className = 'profile-card';
    wrapper.style.animationDelay = `${index * 50}ms`;

    const img = document.createElement('img');
    img.src          = a.querySelector('img').getAttribute('src') || '';
    img.alt          = label;
    img.title        = `Click to load images for uid ${uid}`;
    img.className    = 'profile-thumb';
    img.style.cursor = 'pointer';
    img.addEventListener('click', () => fetchImagesFromProfile(uid));

    const name = document.createElement('div');
    name.className   = 'profile-name';
    name.textContent = namePart;

    const number = document.createElement('div');
    number.className   = 'profile-number';
    number.textContent = numberPart;

    wrapper.append(img, name, number);
    profilesContainer.appendChild(wrapper);
  });
}

function renderProfileDetails(profile) {
  clearProfileDetails();

  const card = document.createElement('div');
  card.className = 'profile-details-card';

  const name = document.createElement('a');
  name.className   = 'profile-details-name';
  name.textContent = profile.name;
  name.href        = profile.profileUrl || '#';
  name.target      = '_blank';
  name.rel         = 'noopener noreferrer';

  const areaBtn = document.createElement('button');
  areaBtn.className   = 'profile-details-area';
  areaBtn.textContent = profile.area;
  areaBtn.title       = 'Browse this area';
  areaBtn.disabled    = !profile.areaUrl;
  if (profile.areaUrl) {
    areaBtn.addEventListener('click', () => fetchProfilesByArea(profile.area));
  }

  const favoriteBtn = document.createElement('button');
  favoriteBtn.id = 'favorite-toggle-btn';
  favoriteBtn.className = 'profile-details-area';
  favoriteBtn.textContent = isFavorite(profile.uid) ? 'Remove Favorite' : 'Add To Favorites';
  favoriteBtn.addEventListener('click', () => toggleFavorite(profile));

  card.append(name, areaBtn, favoriteBtn);

  if (profile.age) {
    const age = document.createElement('span');
    age.className   = 'profile-details-meta';
    age.textContent = `Age: ${profile.age}`;
    card.appendChild(age);
  }

  if (profile.phone) {
    const phone = document.createElement('a');
    phone.className   = 'profile-details-meta profile-details-phone';
    phone.href        = `tel:${profile.phone}`;
    phone.textContent = profile.phone;
    card.appendChild(phone);
  }

  profileDetailsContainer.appendChild(card);
}

function renderImages() {
  clearImages();

  let slot = 0;
  galleryImageUrls.forEach(url => {
    const img = document.createElement('img');
    img.alt = 'gallery image';
    img.src = url;
    img.className = 'masonry-img';
    img.style.animationDelay = `${slot * 60}ms`;
    img.dataset.sourceUrl = url;
    img.onerror = function () {
      recordFailedImage(this.currentSrc || this.dataset.sourceUrl || '');
      this.remove();
    };
    imagesContainer.appendChild(img);
    slot++;
  });

  subIdArray.forEach(id => {
    const maxPics = Math.max(1, Math.min(subIdPicCounts.get(id) || 6, 30));
    for (let i = 1; i <= maxPics; i++) {
      const img = document.createElement('img');
      const mediumSrc = `https://goldmember.esa.co.za//picserver.php?type=picsets&subid=${id}&picnum=${i}&size=medium`;
      img.alt   = `subId ${id} pic ${i}`;
      img.src   = mediumSrc;
      img.className = 'masonry-img';
      img.style.animationDelay = `${slot * 60}ms`;
      img.dataset.sourceUrl = mediumSrc;
      img.onerror = function () {
        const smallSrc = img.src.replace('size=medium', 'size=small');
        if (this.src !== smallSrc) {
          this.src = smallSrc;
        } else {
          recordFailedImage(this.currentSrc || this.dataset.sourceUrl || '');
          this.remove();
        }
      };
      imagesContainer.appendChild(img);
      slot++;
    }
  });
}

// ─── IMAGE PROCESSING ─────────────────────────────────────────────────────

function normalizeGalleryImageUrl(url) {
  if (!url) return '';

  // Attributes from HTML can contain encoded ampersands.
  let normalized = url.replace(/&amp;/gi, '&').trim();
  if (!normalized) return '';

  if (/\/client\/gallery\/srv\.php/i.test(normalized)) {
    if (/[?&]size=thumb_blur\b/i.test(normalized)) {
      normalized = normalized.replace(/([?&]size=)thumb_blur\b/i, '$1medium');
    } else if (!/[?&]size=/i.test(normalized)) {
      normalized += (normalized.includes('?') ? '&' : '?') + 'size=medium';
    }
  }

  return normalized;
}

function extractGalleryUrlsFromHtml(html) {
  if (!html) return [];

  const found = new Set();
  const patterns = [
    /https?:\/\/userfiles\.esa\.co\.za\/client\/gallery\/srv\.php\?[^"'\s<)]+/gi,
    /https?:\\\/\\\/userfiles\.esa\.co\.za\\\/client\\\/gallery\\\/srv\.php\?[^"'\s<)]+/gi,
    /\/client\/gallery\/srv\.php\?[^"'\s<)]+/gi,
  ];

  patterns.forEach(pattern => {
    const matches = html.match(pattern) || [];
    matches.forEach(match => {
      let candidate = match.replace(/\\\//g, '/');
      if (candidate.startsWith('/client/gallery/srv.php')) {
        candidate = `https://userfiles.esa.co.za${candidate}`;
      }

      const normalized = normalizeGalleryImageUrl(candidate);
      if (/\/client\/gallery\/srv\.php/i.test(normalized)) {
        found.add(normalized);
      }
    });
  });

  return Array.from(found);
}

function extractSubIdsFromHtml(html) {
  if (!html) return [];

  const found = new Set();
  const patterns = [
    /(?:[?&]|\b)(?:subid|picset_id|picsetid)=(\d{4,})/gi,
    /(?:subid|picset_id|picsetid)%3D(\d{4,})/gi,
    /["'](?:subid|picset_id|picsetid)["']\s*:\s*["']?(\d{4,})/gi,
  ];

  patterns.forEach(pattern => {
    let match;
    while ((match = pattern.exec(html)) !== null) {
      found.add(match[1]);
    }
  });

  return Array.from(found);
}

function extractPicNum(src) {
  if (!src) return null;
  const normalized = src.replace(/&amp;/gi, '&').trim();
  const match = normalized.match(/[?&]picnum=(\d+)/i);
  return match ? Number(match[1]) : null;
}

function processImages(imgs, extraCandidates = [], extraSubIds = []) {
  const seenSubIds = new Set();
  const seenGalleryUrls = new Set();
  subIdArray = [];
  galleryImageUrls = [];
  subIdPicCounts = new Map();

  imgs.forEach(img => {
    const srcset = img.getAttribute('srcset') ?? '';
    const srcsetUrls = srcset
      .split(',')
      .map(part => part.trim().split(/\s+/)[0])
      .filter(Boolean);

    const candidates = [
      img.getAttribute('data-original') ?? '',
      img.getAttribute('src') ?? '',
      img.getAttribute('data-src') ?? '',
      ...srcsetUrls,
    ];

    candidates.forEach(candidate => {
      const normalized = normalizeGalleryImageUrl(candidate);
      if (/\/client\/gallery\/srv\.php/i.test(normalized) && !seenGalleryUrls.has(normalized)) {
        seenGalleryUrls.add(normalized);
        galleryImageUrls.push(normalized);
      }

      const id = extractSubId(normalized);
      if (id && !seenSubIds.has(id)) {
        seenSubIds.add(id);
        subIdArray.push(id);
      }

      if (id) {
        const picNum = extractPicNum(normalized);
        if (picNum) {
          const current = subIdPicCounts.get(id) || 0;
          subIdPicCounts.set(id, Math.max(current, picNum));
        }
      }
    });
  });

  extraCandidates.forEach(candidate => {
    const normalized = normalizeGalleryImageUrl(candidate);
    if (/\/client\/gallery\/srv\.php/i.test(normalized) && !seenGalleryUrls.has(normalized)) {
      seenGalleryUrls.add(normalized);
      galleryImageUrls.push(normalized);
    }

    const id = extractSubId(normalized);
    if (id && !seenSubIds.has(id)) {
      seenSubIds.add(id);
      subIdArray.push(id);
    }

    if (id) {
      const picNum = extractPicNum(normalized);
      if (picNum) {
        const current = subIdPicCounts.get(id) || 0;
        subIdPicCounts.set(id, Math.max(current, picNum));
      }
    }
  });

  extraSubIds.forEach(id => {
    if (id && !seenSubIds.has(id)) {
      seenSubIds.add(id);
      subIdArray.push(id);
    }
  });

  const directCount = galleryImageUrls.length;
  const generatedCount = subIdArray.reduce((sum, id) => {
    const n = Math.max(1, Math.min(subIdPicCounts.get(id) || 6, 30));
    return sum + n;
  }, 0);
  const totalCount = directCount + generatedCount;
  setStatus(`Found ${directCount} direct gallery image${directCount === 1 ? '' : 's'} and ${generatedCount} generated image${generatedCount === 1 ? '' : 's'} (${totalCount} total).`);

  // Scroll to the images section first, then render once the scroll has settled
  profileDetailsContainer.scrollIntoView({ behavior: 'smooth' });
  setTimeout(renderImages, 500);
}

// ─── EVENT LISTENERS ──────────────────────────────────────────────────────

document.getElementById('searchInput')
  .addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });

document.getElementById('areaInput')
  .addEventListener('keydown', e => { if (e.key === 'Enter') doAreaSearch(); });

loadFavorites();
renderFavoritesPanel();
restoreLastSearch();
