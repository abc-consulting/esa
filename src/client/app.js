import { IMAGE_RELAY_BASE_URL, STORAGE_KEYS } from './modules/config.js';
import { dom } from './modules/dom.js';
import {
  parseJsonStorage,
  setStorageScopedValue,
  readSelectedProvider,
  saveSelectedProviderToStorage,
} from './modules/storage.js';
import {
  extractUidFromUrl,
  extractSubId,
  normalizeGalleryImageUrl,
  getProfileUrlByProvider,
  extractPicNum,
} from './modules/url-utils.js';
import {
  fetchEsaImagesFromProfile,
  fetchEsaProfilesByNickname,
  fetchEsaProfilesByArea,
} from './modules/providers/esa-service.js';
import {
  fetchRedvelvetProfilesByNickname as fetchRedvelvetProfilesByNicknameService,
  fetchRedvelvetProfilesByArea as fetchRedvelvetProfilesByAreaService,
  fetchRedvelvetImagesFromProfile as fetchRedvelvetImagesFromProfileService,
} from './modules/providers/redvelvet-service.js';
import { debounce } from './modules/common-utils.js';
import {
  initFavorites,
  loadFavorites,
  isFavorite,
  toggleFavorite,
  renderFavoritesPanel,
} from './modules/favorites.js';

const {
  searchBtn,
  filterBar,
  filterInput,
  filterChips,
  siteSelect,
  status,
  contentLayout,
  profilesContainer,
  imagesContainer,
  profileDetailsContainer,
  areaDropdownWrap,
  areaDropdownBtn,
  areaDropdownPanel,
  tagDropdownWrap,
  tagDropdownBtn,
  tagDropdownPanel,
} = dom;

// ─── STATE ────────────────────────────────────────────────────────────────

let subIdArray        = [];
let profileLinks      = [];
let galleryImageUrls  = [];
let subIdPicCounts    = new Map();
let failedImagesBySubId = new Map();
let activeProvider    = 'esa';
let filterKeyword     = '';
let activeTags         = new Set();
let tagProfileSets     = new Map();
let tagProfileObjects  = new Map();
let activeAreas        = new Set();
let areaProfileSets    = new Map();
let areaProfileObjects = new Map();

// ─── STATUS ───────────────────────────────────────────────────────────────

function setStatus(msg, isError = false) {
  if (!status) return;
  status.innerHTML = msg;
  status.className = isError ? 'error' : '';
}

// ─── STORAGE HELPERS ──────────────────────────────────────────────────────

function persistLastSearch(type, value) {
  const cleanValue = String(value || '').trim();
  if (!cleanValue) return;
  setStorageScopedValue(STORAGE_KEYS.lastSearch, activeProvider, {
    provider: activeProvider,
    type,
    value: cleanValue,
    at: Date.now(),
  });
}

function saveSelectedProvider(provider) {
  saveSelectedProviderToStorage(provider);
  activeProvider = provider;
}

function getCurrentProvider() {
  return siteSelect?.value === 'redvelvet' ? 'redvelvet' : 'esa';
}

function restoreLastSearch() {
  const stored = parseJsonStorage(STORAGE_KEYS.lastSearch, null);
  const last = (stored && typeof stored === 'object' && !Array.isArray(stored))
    ? (stored[activeProvider] || null)
    : stored;
  if (!last?.type || !last?.value) return;

  if (last.type === 'area') {
    document.getElementById('areaInput').value = last.value;
    doAreaSearch();
    return;
  }

  document.getElementById('searchInput').value = last.value;
  doSearch();
}

// ─── CLEAR HELPERS ────────────────────────────────────────────────────────

function clearProfilesContainer() {
  profilesContainer.innerHTML = '';
}

function clearProfiles() {
  clearProfilesContainer();
  profileLinks = [];
  filterKeyword = '';
  activeTags.clear();
  tagProfileSets.clear();
  tagProfileObjects.clear();
  activeAreas.clear();
  areaProfileSets.clear();
  areaProfileObjects.clear();
  if (filterInput) filterInput.value = '';
  if (filterChips) filterChips.innerHTML = '';
  if (filterBar) filterBar.style.display = 'none';
}

function clearImages() {
  imagesContainer.innerHTML = '';
  failedImagesBySubId = new Map();
  renderFailedImagesPanel();
}

function exitProfileView() {
  contentLayout?.classList.remove('has-profile');
}

function clearProfileDetails() {
  profileDetailsContainer.innerHTML = '';
}

// ─── FAILED IMAGES PANEL ──────────────────────────────────────────────────

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

  exitProfileView();
  clearProfiles();
  clearImages();
  clearProfileDetails();
  subIdArray = [];
  document.getElementById('selected-output').style.display = 'none';
  setStatus('<span class="spinner"></span>Fetching results…');
  searchBtn.disabled = true;

  persistLastSearch(/^\d+$/.test(query) ? 'uid' : 'nickname', query);

  if (activeProvider === 'redvelvet') {
    if (/^https?:\/\/.*\/escorts\/escorts_details\//i.test(query)) {
      await fetchRedvelvetImagesFromProfile(query);
      return;
    }

    if (/^\d+$/.test(query)) {
      await fetchImagesFromProfile(query);
    } else {
      await fetchRedvelvetProfilesByNickname(query);
    }
    return;
  }

  if (/^\d+$/.test(query)) {
    await fetchImagesFromProfile(query);
  } else {
    await fetchProfilesByNickname(query);
  }
}

async function doAreaSearch() {
  const area = document.getElementById('areaInput').value.trim();
  if (!area) return;
  exitProfileView();
  persistLastSearch('area', area);
  fetchProfilesByArea(area);
}

// ─── PROFILE FETCHING ─────────────────────────────────────────────────────

async function fetchImagesFromProfile(uid) {
  if (activeProvider === 'redvelvet') {
    await fetchRedvelvetImagesFromProfile(uid);
    return;
  }

  const esaResult = await fetchEsaImagesFromProfile(uid, { setStatus, searchBtn });
  if (!esaResult) return;

  renderProfileDetails(esaResult.profile);
  processImages(esaResult.images, esaResult.galleryUrls, esaResult.subIds);
}

async function fetchProfilesByNickname(nickname) {
  clearProfiles();
  profileLinks = await fetchEsaProfilesByNickname(nickname, { setStatus, searchBtn });
  renderProfileCards();
}

async function fetchProfilesByArea(area) {
  clearImages();
  clearProfiles();
  clearProfileDetails();

  const header = document.createElement('h2');
  header.className   = 'area-name';
  header.textContent = area;
  profilesContainer.appendChild(header);

  profileLinks = await fetchEsaProfilesByArea(area, { setStatus, searchBtn });
  renderProfileCards();
}

async function fetchRedvelvetProfilesByNickname(nickname) {
  clearImages();
  clearProfiles();
  clearProfileDetails();
  profileLinks = await fetchRedvelvetProfilesByNicknameService(nickname, { setStatus, searchBtn });
  renderProfileCards();
}

async function fetchRedvelvetProfilesByArea(area) {
  clearImages();
  clearProfiles();
  clearProfileDetails();
  profileLinks = await fetchRedvelvetProfilesByAreaService(area, { setStatus, searchBtn });
  renderProfileCards();
}

function syncTagCheckboxes() {
  if (!tagDropdownPanel) return;
  tagDropdownPanel.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.checked = activeTags.has(cb.value);
  });
}

function syncAreaCheckboxes() {
  if (!areaDropdownPanel) return;
  areaDropdownPanel.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.checked = activeAreas.has(cb.value);
  });
}

function makeChip(label, onRemove) {
  const chip = document.createElement('span');
  chip.className = 'filter-chip';
  chip.textContent = label;
  const x = document.createElement('button');
  x.className = 'filter-chip-remove';
  x.textContent = '×';
  x.addEventListener('click', onRemove);
  chip.appendChild(x);
  return chip;
}

function updateFilterChips() {
  if (!filterChips) return;
  filterChips.innerHTML = '';
  activeTags.forEach(tag => filterChips.appendChild(makeChip(tag, () => toggleRedvelvetTag(tag))));
  activeAreas.forEach(area => filterChips.appendChild(makeChip(area, () => toggleRedvelvetArea(area))));
  const hasChips = activeTags.size > 0 || activeAreas.size > 0;
  if (filterBar) filterBar.style.display = hasChips ? 'flex' : 'none';
  syncTagCheckboxes();
  syncAreaCheckboxes();
}

function applyFilters() {
  exitProfileView();
  clearImages();
  clearProfileDetails();
  clearProfilesContainer();

  const hasTags  = activeTags.size > 0;
  const hasAreas = activeAreas.size > 0;

  if (!hasTags && !hasAreas) {
    profileLinks = [];
    renderProfileCards();
    setStatus('');
    return;
  }

  let tagUids = null;
  if (hasTags) {
    const tagSetsArray = [...tagProfileSets.values()];
    tagUids = tagSetsArray.reduce((acc, set) => new Set([...acc].filter(uid => set.has(uid))), tagSetsArray[0]);
  }

  let areaUids = null;
  if (hasAreas) {
    areaUids = new Set();
    for (const set of areaProfileSets.values()) for (const uid of set) areaUids.add(uid);
  }

  let finalUids;
  if (tagUids && areaUids) {
    finalUids = new Set([...tagUids].filter(uid => areaUids.has(uid)));
  } else {
    finalUids = tagUids || areaUids;
  }

  const allProfileObjects = new Map();
  for (const m of areaProfileObjects.values()) for (const [uid, p] of m) allProfileObjects.set(uid, p);
  for (const m of tagProfileObjects.values()) for (const [uid, p] of m) allProfileObjects.set(uid, p);

  profileLinks = [...finalUids].map(uid => allProfileObjects.get(uid)).filter(Boolean);

  const parts = [];
  if (hasTags)  parts.push([...activeTags].join(' + '));
  if (hasAreas) parts.push('areas: ' + [...activeAreas].join(', '));
  setStatus(`Found ${profileLinks.length} profile${profileLinks.length === 1 ? '' : 's'} matching: ${parts.join(' | ')}`);
  renderProfileCards();
}

async function toggleRedvelvetTag(tag) {
  if (activeTags.has(tag)) {
    activeTags.delete(tag);
    tagProfileSets.delete(tag);
    tagProfileObjects.delete(tag);
    updateFilterChips();
    applyFilters();
    return;
  }

  activeTags.add(tag);
  setStatus('<span class="spinner"></span>Fetching profiles…');
  searchBtn.disabled = true;
  const relayBase = IMAGE_RELAY_BASE_URL.replace(/\/$/, '');
  try {
    const res = await fetch(`${relayBase}/redvelvet-tag-profiles?tag=${encodeURIComponent(tag)}&cityBucket=2`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const profiles = data.profiles || [];
    tagProfileSets.set(tag, new Set(profiles.map(p => p.uid)));
    const byUid = new Map();
    profiles.forEach(p => byUid.set(p.uid, p));
    tagProfileObjects.set(tag, byUid);
  } catch (err) {
    activeTags.delete(tag);
    setStatus(`Error: ${err.message}`, true);
    searchBtn.disabled = false;
    return;
  }
  searchBtn.disabled = false;
  updateFilterChips();
  applyFilters();
}

async function toggleRedvelvetArea(area) {
  if (activeAreas.has(area)) {
    activeAreas.delete(area);
    areaProfileSets.delete(area);
    areaProfileObjects.delete(area);
    updateFilterChips();
    applyFilters();
    return;
  }

  activeAreas.add(area);
  setStatus('<span class="spinner"></span>Fetching profiles…');
  searchBtn.disabled = true;
  const relayBase = IMAGE_RELAY_BASE_URL.replace(/\/$/, '');
  try {
    const res = await fetch(`${relayBase}/redvelvet-area-profiles?name=${encodeURIComponent(area)}&cityBucket=2`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const profiles = data.profiles || [];
    areaProfileSets.set(area, new Set(profiles.map(p => p.uid)));
    const byUid = new Map();
    profiles.forEach(p => byUid.set(p.uid, p));
    areaProfileObjects.set(area, byUid);
  } catch (err) {
    activeAreas.delete(area);
    setStatus(`Error: ${err.message}`, true);
    searchBtn.disabled = false;
    return;
  }
  searchBtn.disabled = false;
  updateFilterChips();
  applyFilters();
}

async function fetchRedvelvetImagesFromProfile(uidOrId) {
  const redvelvetResult = await fetchRedvelvetImagesFromProfileService(uidOrId, { setStatus, searchBtn });
  if (!redvelvetResult) return;

  renderProfileDetails(redvelvetResult.profile);

  subIdArray       = [];
  subIdPicCounts   = new Map();
  galleryImageUrls = redvelvetResult.directImages;

  const directCount = galleryImageUrls.length;
  setStatus(`Found ${directCount} RedVelvet image${directCount === 1 ? '' : 's'}.`);
  profileDetailsContainer.scrollIntoView({ behavior: 'smooth' });
  setTimeout(renderImages, 300);
}

// ─── RENDERING ────────────────────────────────────────────────────────────

function renderProfileCards() {
  clearProfilesContainer();

  const filteredProfiles = profileLinks.filter(profile => {
    return profile.name.includes(filterKeyword) || profile.area.includes(filterKeyword);
  });

  const CARD_PLACEHOLDER = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="320" height="220"><rect width="100%" height="100%" fill="%23f3f3f3"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="%23777" font-size="16">No Image</text></svg>';
  const relayBase = IMAGE_RELAY_BASE_URL.replace(/\/$/, '');
  const toRelayImageUrl = (url) => `${relayBase}/image?url=${encodeURIComponent(url)}`;
  const toCardImageUrl = (url) => {
    if (!url || !/^https?:\/\//i.test(url)) return url;
    return toRelayImageUrl(url);
  };

  const buildCardFallbackThumb = (card) => {
    if ((card?.provider || 'esa') !== 'redvelvet') return '';
    if (!card?.uid) return '';
    return 'https://redvelvet.co.za/Assets/images/noimage.png';
  };

  if (filteredProfiles.length > 0 && filterBar) filterBar.style.display = 'flex';

  filteredProfiles.forEach((item, index) => {
    const uid = item.uid;
    if (!uid) return;

    const namePart   = item.name || `UID ${uid}`;
    const numberPart = item.area || '';
    const imgSrc     = toCardImageUrl(item.thumbUrl || buildCardFallbackThumb(item)) || CARD_PLACEHOLDER;
    const provider   = item.provider || 'esa';

    const wrapper = document.createElement('div');
    wrapper.className = 'profile-card';
    wrapper.style.animationDelay = `${index * 50}ms`;
    wrapper.title = `Click to load images for uid ${uid}`;
    if (provider === 'redvelvet') {
      wrapper.addEventListener('click', () => fetchRedvelvetImagesFromProfile(item.profileUrl));
    } else {
      wrapper.addEventListener('click', () => fetchImagesFromProfile(uid));
    }

    const img = document.createElement('img');
    img.src       = imgSrc;
    img.alt       = `${namePart} ${numberPart}`.trim();
    img.className = 'profile-thumb';

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
  contentLayout?.classList.add('has-profile');

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
  const areaTarget = profile.areaUrl || profile.area;
  areaBtn.disabled = !areaTarget;
  if (areaTarget) {
    areaBtn.addEventListener('click', () => fetchProfilesByArea(areaTarget));
  }

  const favoriteBtn = document.createElement('button');
  favoriteBtn.id        = 'favorite-toggle-btn';
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

  if (profile.bust) {
    const bust = document.createElement('span');
    bust.className   = 'profile-details-meta';
    bust.textContent = `Bust: ${profile.bust}`;
    card.appendChild(bust);
  }

  if (profile.phone) {
    const phone = document.createElement('a');
    phone.className   = 'profile-details-meta profile-details-phone';
    phone.href        = `tel:${profile.phone}`;
    phone.textContent = profile.phone;
    card.appendChild(phone);
  }

  if (profile.tags?.length) {
    const tagsWrap = document.createElement('div');
    tagsWrap.className = 'profile-tags';
    profile.tags.forEach(tag => {
      const chip = document.createElement('span');
      chip.className   = 'profile-tag';
      chip.textContent = tag;
      chip.style.cursor = 'pointer';
      chip.addEventListener('click', () => toggleRedvelvetTag(tag));
      tagsWrap.appendChild(chip);
    });
    card.appendChild(tagsWrap);
  }

  profileDetailsContainer.appendChild(card);
}

function renderImages() {
  clearImages();

  const relayBase = IMAGE_RELAY_BASE_URL.replace(/\/$/, '');
  const toRelayImageUrl = (url) => `${relayBase}/image?url=${encodeURIComponent(url)}`;
  const toDisplayImageUrl = (url) => {
    if (!/^https?:\/\//i.test(url)) return url;
    return toRelayImageUrl(url);
  };

  let slot = 0;

  galleryImageUrls.forEach(url => {
    const img = document.createElement('img');
    img.alt       = 'gallery image';
    img.src       = toDisplayImageUrl(url);
    img.className = 'masonry-img';
    img.style.animationDelay = `${slot * 60}ms`;
    img.dataset.sourceUrl = url;
    img.onerror = function () {
      recordFailedImage(this.dataset.sourceUrl || this.currentSrc || '');
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
      img.alt       = `subId ${id} pic ${i}`;
      img.src       = toDisplayImageUrl(mediumSrc);
      img.className = 'masonry-img';
      img.style.animationDelay = `${slot * 60}ms`;
      img.dataset.sourceUrl = mediumSrc;
      img.onerror = function () {
        const sourceUrl = this.dataset.sourceUrl || '';
        const smallSource = sourceUrl.replace('size=medium', 'size=small');
        if (sourceUrl.includes('size=medium')) {
          this.dataset.sourceUrl = smallSource;
          this.src = toDisplayImageUrl(smallSource);
        } else {
          recordFailedImage(sourceUrl || this.currentSrc || '');
          this.remove();
        }
      };
      imagesContainer.appendChild(img);
      slot++;
    }
  });
}

// ─── IMAGE PROCESSING ─────────────────────────────────────────────────────

function processImages(imgs, extraCandidates = [], extraSubIds = []) {
  const seenSubIds     = new Set();
  const seenGalleryUrls = new Set();
  subIdArray       = [];
  galleryImageUrls = [];
  subIdPicCounts   = new Map();

  const processCandidate = (candidate) => {
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
        subIdPicCounts.set(id, Math.max(subIdPicCounts.get(id) || 0, picNum));
      }
    }
  };

  imgs.forEach(img => {
    const srcset = img.getAttribute('srcset') ?? '';
    const srcsetUrls = srcset
      .split(',')
      .map(part => part.trim().split(/\s+/)[0])
      .filter(Boolean);

    [
      img.getAttribute('data-original') ?? '',
      img.getAttribute('src') ?? '',
      img.getAttribute('data-src') ?? '',
      ...srcsetUrls,
    ].forEach(processCandidate);
  });

  extraCandidates.forEach(processCandidate);

  extraSubIds.forEach(id => {
    if (id && !seenSubIds.has(id)) {
      seenSubIds.add(id);
      subIdArray.push(id);
    }
  });

  const directCount    = galleryImageUrls.length;
  const generatedCount = subIdArray.reduce((sum, id) => {
    return sum + Math.max(1, Math.min(subIdPicCounts.get(id) || 6, 30));
  }, 0);
  const totalCount = directCount + generatedCount;
  setStatus(`Found ${directCount} direct gallery image${directCount === 1 ? '' : 's'} and ${generatedCount} generated image${generatedCount === 1 ? '' : 's'} (${totalCount} total).`);

  profileDetailsContainer.scrollIntoView({ behavior: 'smooth' });
  setTimeout(renderImages, 500);
}

// ─── REDVELVET DROPDOWNS ──────────────────────────────────────────────────

let redvelvetDropdownsReady = false;

async function initRedvelvetDropdowns() {
  if (redvelvetDropdownsReady) return;
  redvelvetDropdownsReady = true;
  const relayBase = IMAGE_RELAY_BASE_URL.replace(/\/$/, '');

  // Areas multi-select
  try {
    const res = await fetch(`${relayBase}/redvelvet-areas?cityBucket=2`);
    if (res.ok) {
      const data = await res.json();
      areaDropdownPanel.innerHTML = '';
      (data.areas || []).forEach(area => {
        const row = document.createElement('label');
        row.className = 'tag-option';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.value = area;
        cb.addEventListener('change', () => toggleRedvelvetArea(area));
        row.append(cb, document.createTextNode(` ${area}`));
        areaDropdownPanel.appendChild(row);
      });
    }
  } catch { /* silent */ }

  areaDropdownBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = areaDropdownPanel.style.display === 'block';
    areaDropdownPanel.style.display = open ? 'none' : 'block';
  });

  document.addEventListener('click', (e) => {
    if (!areaDropdownWrap.contains(e.target)) {
      areaDropdownPanel.style.display = 'none';
    }
  });

  // Tags multi-select
  try {
    const res = await fetch(`${relayBase}/redvelvet-tags?`);
    if (res.ok) {
      const data = await res.json();
      tagDropdownPanel.innerHTML = '';
      (data.tags || []).forEach(({ label }) => {
        const row = document.createElement('label');
        row.className = 'tag-option';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.value = label;
        cb.addEventListener('change', () => toggleRedvelvetTag(label));
        row.append(cb, document.createTextNode(` ${label}`));
        tagDropdownPanel.appendChild(row);
      });
    }
  } catch { /* silent */ }

  tagDropdownBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = tagDropdownPanel.style.display === 'block';
    tagDropdownPanel.style.display = open ? 'none' : 'block';
  });

  document.addEventListener('click', (e) => {
    if (!tagDropdownWrap.contains(e.target)) {
      tagDropdownPanel.style.display = 'none';
    }
  });
}

function showRedvelvetDropdowns() {
  if (areaDropdownWrap) areaDropdownWrap.style.display = '';
  if (tagDropdownWrap) tagDropdownWrap.style.display = '';
}

function hideRedvelvetDropdowns() {
  if (areaDropdownWrap) areaDropdownWrap.style.display = 'none';
  if (tagDropdownWrap) tagDropdownWrap.style.display = 'none';
}

// ─── EVENT WIRING ─────────────────────────────────────────────────────────

function renderFilterChip() {
  if (!filterChips) return;
  filterChips.innerHTML = '';
  if (!filterKeyword) return;
  const chip = document.createElement('span');
  chip.className = 'filter-chip';
  chip.textContent = filterKeyword;
  const x = document.createElement('button');
  x.className = 'filter-chip-remove';
  x.textContent = '×';
  x.addEventListener('click', () => {
    filterKeyword = '';
    filterInput.value = '';
    renderFilterChip();
    renderProfileCards();
  });
  chip.appendChild(x);
  filterChips.appendChild(chip);
}

const handleFilterInput = debounce((ev) => {
  filterKeyword = ev.target.value;
  renderFilterChip();
  renderProfileCards();
}, 300);

filterInput.addEventListener('input', handleFilterInput);

document.getElementById('searchInput')
  .addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });

document.getElementById('areaInput')
  .addEventListener('keydown', e => { if (e.key === 'Enter') doAreaSearch(); });

dom.searchBtn.addEventListener('click', doSearch);
dom.areaBtn.addEventListener('click', doAreaSearch);
dom.filterBtn.addEventListener('click', renderProfileCards);

activeProvider = readSelectedProvider();
if (siteSelect) {
  siteSelect.value = activeProvider;
  if (activeProvider === 'redvelvet') {
    showRedvelvetDropdowns();
    initRedvelvetDropdowns();
  }
  siteSelect.addEventListener('change', () => {
    saveSelectedProvider(getCurrentProvider());
    exitProfileView();
    clearProfiles();
    clearImages();
    clearProfileDetails();
    loadFavorites();
    renderFavoritesPanel();
    if (activeProvider === 'redvelvet') {
      showRedvelvetDropdowns();
      initRedvelvetDropdowns();
    } else {
      hideRedvelvetDropdowns();
    }
    restoreLastSearch();
  });
}

initFavorites({
  getActiveProvider: () => activeProvider,
  saveSelectedProvider,
  persistLastSearch,
  siteSelect: dom.siteSelect,
  onLoadProfile: (provider, favorite) => {
    if (provider === 'redvelvet') {
      fetchRedvelvetImagesFromProfile(
        favorite.profileUrl || getProfileUrlByProvider('redvelvet', favorite.uid),
      );
    } else {
      fetchImagesFromProfile(favorite.uid);
    }
  },
});

loadFavorites();
renderFavoritesPanel();
restoreLastSearch();
