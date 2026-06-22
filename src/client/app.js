import { IMAGE_RELAY_BASE_URL, STORAGE_KEYS } from './modules/config.js';
import { dom } from './modules/dom.js';
import {
  parseJsonStorage,
  writeJsonStorage,
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
  redvelvetDetailFilters,
  ageMinInput,
  ageMaxInput,
  bandSelect,
  cupSelect,
  sizeMinBtn,
  sizeMinPanel,
  sizeMaxBtn,
  sizeMaxPanel,
} = dom;

// ─── STATE ────────────────────────────────────────────────────────────────

let subIdArray        = [];
let profileLinks      = [];
let galleryImageUrls  = [];
let subIdPicCounts    = new Map();
let failedImagesBySubId = new Map();
let activeProvider    = 'esa';
let filterKeyword     = '';
let activeTags   = new Set();
let excludedTags = new Set();
let activeAreas  = new Set();
let excludedAreas = new Set();
let detailCache        = new Map();
let ageMin = null, ageMax = null, selectedBand = null, selectedCup = '', sizeMinVol = null, sizeMaxVol = null;

// ─── BUST SIZE HELPERS ────────────────────────────────────────────────────

const CUP_INDEX = { A: 1, B: 2, C: 3, D: 4, DD: 5, E: 6, F: 7, G: 8, H: 9 };
const CHIP_COLLAPSE_THRESHOLD = 3;

function parseBust(str) {
  const m = String(str || '').trim().match(/^(\d+)\s*(A|B|C|DD|D|E|F|G|H)$/i);
  if (!m) return null;
  return { band: parseInt(m[1]), cup: m[2].toUpperCase() };
}

function bustVolumeGroup(band, cup) {
  const idx = CUP_INDEX[String(cup).toUpperCase()];
  return idx ? (band / 2) + idx : null;
}

const SIZE_LEVELS = [
  { vol: 15, label: '28A',  sisters: [] },
  { vol: 16, label: '30A',  sisters: ['28B'] },
  { vol: 17, label: '32A',  sisters: ['30B', '28C'] },
  { vol: 18, label: '34A',  sisters: ['32B', '30C', '28D'] },
  { vol: 19, label: '34B',  sisters: ['32C', '30D', '28DD', '36A'] },
  { vol: 20, label: '34C',  sisters: ['32D', '30DD', '36B', '38A'] },
  { vol: 21, label: '34D',  sisters: ['32DD', '36C', '38B', '40A'] },
  { vol: 22, label: '34DD', sisters: ['36D', '38C', '40B', '42A'] },
  { vol: 23, label: '36DD', sisters: ['38D', '40C', '42B', '44A'] },
  { vol: 24, label: '34E',  sisters: ['36E', '38D', '40C', '42B', '44A'] },
  { vol: 25, label: '36E',  sisters: ['38DD', '40D', '42C', '44B'] },
  { vol: 26, label: '38E',  sisters: ['40DD', '42D', '44C'] },
  { vol: 27, label: '40E',  sisters: ['42DD', '44D'] },
  { vol: 28, label: '42E',  sisters: ['44DD'] },
  { vol: 29, label: '34F',  sisters: ['36F', '44E'] },
  { vol: 30, label: '36F',  sisters: ['38E', '40F'] },
  { vol: 31, label: '38F',  sisters: ['40E', '42F'] },
  { vol: 32, label: '40F',  sisters: ['42E', '44F'] },
  { vol: 33, label: '34G',  sisters: ['36G', '44F'] },
  { vol: 34, label: '36G',  sisters: ['38F', '40G'] },
  { vol: 35, label: '38G',  sisters: ['40F', '42G'] },
  { vol: 36, label: '40G',  sisters: ['42F', '44G'] },
  { vol: 37, label: '34H',  sisters: ['36H', '44G'] },
  { vol: 38, label: '36H',  sisters: ['38G', '40H'] },
  { vol: 39, label: '38H',  sisters: ['40G', '42H'] },
  { vol: 40, label: '40H',  sisters: ['42G', '44H'] },
  { vol: 41, label: '42H',  sisters: ['44G'] },
  { vol: 42, label: '44H',  sisters: [] },
];

// ─── DETAIL CACHE ─────────────────────────────────────────────────────────

async function ensureDetailCache(profiles) {
  const relayBase = IMAGE_RELAY_BASE_URL.replace(/\/$/, '');
  const missing = profiles.filter(p => p.provider === 'redvelvet' && !detailCache.has(p.uid));
  if (!missing.length) return;
  let done = 0;
  await Promise.all(missing.map(async p => {
    try {
      const res = await fetch(`${relayBase}/redvelvet-profile-details?id=${encodeURIComponent(p.uid)}`);
      if (res.ok) {
        const data = await res.json();
        if (data?.profile) detailCache.set(p.uid, data.profile);
      }
    } catch { /* skip */ }
    done++;
    setStatus(`Loading details… ${done}/${missing.length}`);
  }));
  setStatus('');
}

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

function persistFilters() {
  writeJsonStorage(STORAGE_KEYS.rvFilters, {
    activeTags:   [...activeTags],
    excludedTags: [...excludedTags],
    activeAreas:  [...activeAreas],
    excludedAreas:[...excludedAreas],
    ageMin, ageMax, selectedBand, selectedCup, sizeMinVol, sizeMaxVol,
    at: Date.now(),
  });
}

async function restoreFilters() {
  const saved = parseJsonStorage(STORAGE_KEYS.rvFilters, null);
  if (!saved) return false;

  // Only restore filters if they are more recent than the last nickname/area search
  const lastSearch = parseJsonStorage(STORAGE_KEYS.lastSearch, null);
  const lastSearchAt = (lastSearch && typeof lastSearch === 'object' && !Array.isArray(lastSearch))
    ? (lastSearch[activeProvider]?.at ?? 0)
    : (lastSearch?.at ?? 0);
  if (lastSearchAt > (saved.at ?? 0)) return false;

  activeTags.clear();
  excludedTags.clear();
  activeAreas.clear();
  excludedAreas.clear();

  (saved.activeTags   || []).forEach(t => activeTags.add(t));
  (saved.excludedTags || []).forEach(t => excludedTags.add(t));
  (saved.activeAreas  || []).forEach(a => activeAreas.add(a));
  (saved.excludedAreas|| []).forEach(a => excludedAreas.add(a));

  ageMin       = saved.ageMin       ?? null;
  ageMax       = saved.ageMax       ?? null;
  selectedBand = saved.selectedBand ?? null;
  selectedCup  = saved.selectedCup  ?? '';
  sizeMinVol   = saved.sizeMinVol   ?? null;
  sizeMaxVol   = saved.sizeMaxVol   ?? null;

  // Restore UI inputs
  if (ageMinInput && ageMin !== null) ageMinInput.value = ageMin;
  if (ageMaxInput && ageMax !== null) ageMaxInput.value = ageMax;
  if (bandSelect  && selectedBand)    bandSelect.value  = selectedBand;
  if (cupSelect   && selectedCup)     cupSelect.value   = selectedCup;

  // Restore size dropdown button labels and selected states
  if (sizeMinVol !== null && sizeMinBtn && sizeMinPanel) {
    const level = SIZE_LEVELS.find(l => l.vol === sizeMinVol);
    if (level) {
      sizeMinBtn.textContent = `≥ ${level.label} ▾`;
      sizeMinPanel.querySelectorAll('.size-option').forEach(r => {
        if (Number(r.dataset.vol) === sizeMinVol) r.classList.add('selected');
      });
    }
  }
  if (sizeMaxVol !== null && sizeMaxBtn && sizeMaxPanel) {
    const level = SIZE_LEVELS.find(l => l.vol === sizeMaxVol);
    if (level) {
      sizeMaxBtn.textContent = `≤ ${level.label} ▾`;
      sizeMaxPanel.querySelectorAll('.size-option').forEach(r => {
        if (Number(r.dataset.vol) === sizeMaxVol) r.classList.add('selected');
      });
    }
  }

  const hasFilters = activeTags.size > 0 || activeAreas.size > 0 ||
                     excludedTags.size > 0 || excludedAreas.size > 0;
  if (!hasFilters) return false;

  updateFilterChips();
  runRedvelvetSearch();
  return true;
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
  const sidebar = document.getElementById('profiles-sidebar-sticky');
  if (sidebar) sidebar.scrollTop = 0;
}

function clearProfiles() {
  clearProfilesContainer();
  profileLinks = [];
  filterKeyword = '';
  ageMin = null; ageMax = null;
  selectedBand = null; selectedCup = ''; sizeMinVol = null; sizeMaxVol = null;
  if (ageMinInput) ageMinInput.value = '';
  if (ageMaxInput) ageMaxInput.value = '';
  if (bandSelect) bandSelect.value = '';
  if (cupSelect) cupSelect.value = '';
  if (sizeMinBtn) { sizeMinBtn.textContent = 'Min size ▾'; sizeMinPanel.querySelectorAll('.size-option').forEach(r => r.classList.remove('selected')); }
  if (sizeMaxBtn) { sizeMaxBtn.textContent = 'Max size ▾'; sizeMaxPanel.querySelectorAll('.size-option').forEach(r => r.classList.remove('selected')); }
  activeTags.clear();
  excludedTags.clear();
  activeAreas.clear();
  excludedAreas.clear();
  if (filterInput) filterInput.value = '';
  if (filterChips) filterChips.innerHTML = '';
  if (filterBar) filterBar.style.display = 'none';
  const chipBar = document.getElementById('filter-chips-bar');
  if (chipBar) chipBar.style.display = 'none';
}

function clearImages() {
  imagesContainer.innerHTML = '';
  failedImagesBySubId = new Map();
  renderFailedImagesPanel();
  document.getElementById('download-all-btn')?.remove();
}

function exitProfileView() {
  contentLayout?.classList.remove('has-profile');
  document.getElementById('profiles-fab').style.display = 'none';
  closeProfilesDrawer();
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

  if (activeProvider === 'redvelvet') {
    if (!activeAreas.has(area)) {
      activeAreas.add(area);
      updateFilterChips();
    }
    document.getElementById('areaInput').value = '';
    persistLastSearch('area', area);
    runRedvelvetSearch();
    return;
  }

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
  tagDropdownPanel.querySelectorAll('.tag-option').forEach(row => {
    const v = row.dataset.value;
    row.dataset.state = activeTags.has(v) ? 'included' : excludedTags.has(v) ? 'excluded' : 'neutral';
    const box = row.querySelector('.tag-checkbox');
    if (box) box.textContent = activeTags.has(v) ? '✓' : excludedTags.has(v) ? '×' : '';
  });
}

function syncAreaCheckboxes() {
  if (!areaDropdownPanel) return;
  areaDropdownPanel.querySelectorAll('.tag-option').forEach(row => {
    const v = row.dataset.value;
    row.dataset.state = activeAreas.has(v) ? 'included' : excludedAreas.has(v) ? 'excluded' : 'neutral';
    const box = row.querySelector('.tag-checkbox');
    if (box) box.textContent = activeAreas.has(v) ? '✓' : excludedAreas.has(v) ? '×' : '';
  });
}

function makeChip(label, onRemove, excluded = false) {
  const chip = document.createElement('span');
  chip.className = excluded ? 'filter-chip filter-chip--exclude' : 'filter-chip';
  chip.textContent = (excluded ? '× ' : '') + label;
  const x = document.createElement('button');
  x.className = 'filter-chip-remove';
  x.textContent = '×';
  x.addEventListener('click', onRemove);
  chip.appendChild(x);
  return chip;
}

function renderChipGroup(set, makeChipFn, groupLabel, excluded) {
  if (set.size === 0) return;
  const items = [...set];
  if (items.length > CHIP_COLLAPSE_THRESHOLD) {
    const summary = document.createElement('span');
    summary.className = 'filter-chip filter-chip--summary' + (excluded ? ' filter-chip--exclude' : '');
    summary.textContent = `${groupLabel} (${items.length})`;
    summary.title = items.join(', ');
    summary.addEventListener('click', () => {
      const parent = summary.parentNode;
      const next = summary.nextSibling;
      parent.removeChild(summary);
      items.forEach(item => parent.insertBefore(makeChipFn(item), next));
    });
    filterChips.appendChild(summary);
  } else {
    items.forEach(item => filterChips.appendChild(makeChipFn(item)));
  }
}

function updateFilterChips() {
  if (!filterChips) return;
  filterChips.innerHTML = '';

  renderChipGroup(
    activeAreas,
    area => makeChip(area, () => { toggleRedvelvetArea(area); runRedvelvetSearch(); }),
    'areas', false
  );
  renderChipGroup(
    activeTags,
    tag => makeChip(tag, () => { toggleRedvelvetTag(tag); runRedvelvetSearch(); }),
    'tags', false
  );
  renderChipGroup(
    excludedAreas,
    area => makeChip(area, () => { excludeRedvelvetArea(area); runRedvelvetSearch(); }, true),
    '× areas', true
  );
  renderChipGroup(
    excludedTags,
    tag => makeChip(tag, () => { excludeRedvelvetTag(tag); runRedvelvetSearch(); }, true),
    '× tags', true
  );

  const hasChips = activeTags.size > 0 || activeAreas.size > 0 ||
                   excludedTags.size > 0 || excludedAreas.size > 0;
  const chipBar = document.getElementById('filter-chips-bar');
  if (chipBar) chipBar.style.display = hasChips ? 'flex' : 'none';

  syncTagCheckboxes();
  syncAreaCheckboxes();
}

async function runRedvelvetSearch() {
  exitProfileView();
  clearImages();
  clearProfileDetails();
  clearProfilesContainer();

  const hasIncludes = activeTags.size > 0 || activeAreas.size > 0;
  if (!hasIncludes) {
    persistFilters();
    profileLinks = [];
    renderProfileCards();
    setStatus('');
    return;
  }

  persistFilters();
  const body = {
    areas: { included: [...activeAreas], excluded: [...excludedAreas] },
    tags:  { included: [...activeTags],  excluded: [...excludedTags]  },
    cityBucket: '2',
  };
  const hasBust = selectedBand || selectedCup || sizeMinVol !== null || sizeMaxVol !== null;
  if (ageMin || ageMax) body.age = { min: ageMin, max: ageMax };
  if (hasBust) body.bust = { band: selectedBand, cup: selectedCup, range: { min: sizeMinVol, max: sizeMaxVol } };

  setStatus('<span class="spinner"></span>Searching…');
  searchBtn.disabled = true;
  const relayBase = IMAGE_RELAY_BASE_URL.replace(/\/$/, '');
  try {
    const res = await fetch(`${relayBase}/redvelvet-search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    profileLinks = data.profiles || [];
    setStatus(`Found ${profileLinks.length} profile${profileLinks.length === 1 ? '' : 's'}.`);
  } catch (err) {
    setStatus(`Error: ${err.message}`, true);
  }
  searchBtn.disabled = false;
  renderProfileCards();
}

function toggleRedvelvetTag(tag) {
  if (activeTags.has(tag)) {
    activeTags.delete(tag);
  } else if (excludedTags.has(tag)) {
    excludedTags.delete(tag);
  } else {
    activeTags.add(tag);
  }
  updateFilterChips();
}

function excludeRedvelvetTag(tag) {
  if (excludedTags.has(tag)) {
    excludedTags.delete(tag);
  } else {
    activeTags.delete(tag);
    excludedTags.add(tag);
  }
  updateFilterChips();
}

function toggleRedvelvetArea(area) {
  if (activeAreas.has(area)) {
    activeAreas.delete(area);
  } else if (excludedAreas.has(area)) {
    excludedAreas.delete(area);
  } else {
    activeAreas.add(area);
  }
  updateFilterChips();
}

function excludeRedvelvetArea(area) {
  if (excludedAreas.has(area)) {
    excludedAreas.delete(area);
  } else {
    activeAreas.delete(area);
    excludedAreas.add(area);
  }
  updateFilterChips();
}

async function fetchRedvelvetImagesFromProfile(uidOrId) {
  // Extract numeric UID from URL or use as-is if already numeric
  const uid = /^\d+$/.test(String(uidOrId)) ? String(uidOrId) : extractUidFromUrl(String(uidOrId));
  if (!uid) {
    setStatus('Could not determine profile ID.', true);
    return;
  }

  setStatus('<span class="spinner"></span>Fetching profile…');
  searchBtn.disabled = true;

  let data;
  try {
    const relayBase = IMAGE_RELAY_BASE_URL.replace(/\/$/, '');
    const res = await fetch(`${relayBase}/redvelvet-profile-details?id=${encodeURIComponent(uid)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
    if (data.error) throw new Error(data.error);
  } catch (err) {
    setStatus(`Error: ${err.message}`, true);
    searchBtn.disabled = false;
    return;
  }

  searchBtn.disabled = false;
  renderProfileDetails(data.profile);

  subIdArray       = [];
  subIdPicCounts   = new Map();
  galleryImageUrls = data.directImages || [];

  const totalCount = galleryImageUrls.length + (data.videos?.length || 0);
  setStatus(`Found ${totalCount} RedVelvet media item${totalCount === 1 ? '' : 's'}.`);
  profileDetailsContainer.scrollIntoView({ behavior: 'smooth' });
  setTimeout(() => renderImages(data.videos || []), 300);
}

// ─── RENDERING ────────────────────────────────────────────────────────────

const CARD_PLACEHOLDER = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="320" height="220"><rect width="100%" height="100%" fill="%23f3f3f3"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="%23777" font-size="16">No Image</text></svg>';

function buildProfileCard(item, index, onClickExtra) {
  const relayBase = IMAGE_RELAY_BASE_URL.replace(/\/$/, '');
  const toCardImageUrl = (url) => (url && /^https?:\/\//i.test(url)) ? `${relayBase}/image?url=${encodeURIComponent(url)}` : url;
  const buildFallback = (card) => ((card?.provider || 'esa') === 'redvelvet' && card?.uid) ? 'https://redvelvet.co.za/Assets/images/noimage.png' : '';

  const uid      = item.uid;
  const namePart = item.name || `UID ${uid}`;
  const areaPart = item.area || '';
  const imgSrc   = toCardImageUrl(item.thumbUrl || buildFallback(item)) || CARD_PLACEHOLDER;
  const provider = item.provider || 'esa';

  const wrapper = document.createElement('div');
  wrapper.className = 'profile-card';
  wrapper.style.animationDelay = `${index * 50}ms`;
  wrapper.title = `Click to load images for uid ${uid}`;
  wrapper.addEventListener('click', () => {
    if (onClickExtra) onClickExtra();
    if (provider === 'redvelvet') fetchRedvelvetImagesFromProfile(item.profileUrl);
    else fetchImagesFromProfile(uid);
  });

  const img = document.createElement('img');
  img.src = imgSrc; img.alt = `${namePart} ${areaPart}`.trim(); img.className = 'profile-thumb';

  const name = document.createElement('div');
  name.className = 'profile-name'; name.textContent = namePart;

  const number = document.createElement('div');
  number.className = 'profile-number'; number.textContent = areaPart;

  wrapper.append(img, name, number);
  return wrapper;
}

function isMobile() { return window.innerWidth <= 600; }

function syncMobileDrawer(filteredProfiles) {
  const fab        = document.getElementById('profiles-fab');
  const drawerList = document.getElementById('profiles-drawer-list');
  const fabCount   = document.getElementById('profiles-fab-count');
  if (!fab || !drawerList) return;

  const hasProfile = contentLayout?.classList.contains('has-profile');

  if (filteredProfiles.length > 0 && isMobile() && hasProfile) {
    fab.style.display = 'flex';
    fabCount.textContent = filteredProfiles.length;
  } else {
    fab.style.display = 'none';
  }

  drawerList.innerHTML = '';
  filteredProfiles.forEach((item, index) => {
    if (!item.uid) return;
    drawerList.appendChild(buildProfileCard(item, index, closeProfilesDrawer));
  });
}

function openProfilesDrawer() {
  document.getElementById('profiles-drawer').style.display = 'flex';
  document.getElementById('drawerFilterInput').focus();
}

function closeProfilesDrawer() {
  document.getElementById('profiles-drawer').style.display = 'none';
}

function renderProfileCards() {
  clearProfilesContainer();

  const filteredProfiles = profileLinks
    .filter(profile => profile.name.includes(filterKeyword) || profile.area.includes(filterKeyword));

  if (filteredProfiles.length > 0 && filterBar) filterBar.style.display = 'flex';

  filteredProfiles.forEach((item, index) => {
    if (!item.uid) return;
    profilesContainer.appendChild(buildProfileCard(item, index, null));
  });

  syncMobileDrawer(filteredProfiles);
}

function renderProfileDetails(profile) {
  clearProfileDetails();
  contentLayout?.classList.add('has-profile');

  const card = document.createElement('div');
  card.className = 'profile-details-card';

  // ── Left column: avatar + name + actions ──────────────────────────────
  const leftCol = document.createElement('div');
  leftCol.className = 'profile-details-left';

  const thumbSrc = profile.thumbUrl || '';
  if (thumbSrc) {
    const relayBase = IMAGE_RELAY_BASE_URL.replace(/\/$/, '');
    const avatar = document.createElement('img');
    avatar.className = 'profile-details-avatar';
    avatar.src = `${relayBase}/image?url=${encodeURIComponent(thumbSrc)}`;
    avatar.alt = profile.name;
    leftCol.appendChild(avatar);
  }

  const nameActionsCol = document.createElement('div');
  nameActionsCol.className = 'profile-details-name-col';

  const nameLink = document.createElement('a');
  nameLink.className   = 'profile-details-name';
  nameLink.textContent = profile.name;
  nameLink.href        = profile.profileUrl || '#';
  nameLink.target      = '_blank';
  nameLink.rel         = 'noopener noreferrer';
  nameActionsCol.appendChild(nameLink);

  const actionsRow = document.createElement('div');
  actionsRow.className = 'profile-details-actions';

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
  favoriteBtn.className = 'favorite-star-btn';
  favoriteBtn.textContent = isFavorite(profile.uid) ? '★' : '☆';
  favoriteBtn.title = isFavorite(profile.uid) ? 'Remove from favorites' : 'Add to favorites';
  favoriteBtn.addEventListener('click', () => toggleFavorite(profile));

  actionsRow.append(areaBtn, favoriteBtn);
  nameActionsCol.appendChild(actionsRow);
  leftCol.appendChild(nameActionsCol);

  // ── Right column: meta details + tags ────────────────────────────────
  const rightCol = document.createElement('div');
  rightCol.className = 'profile-details-right';

  if (profile.age) {
    const age = document.createElement('span');
    age.className   = 'profile-details-meta';
    age.textContent = `Age: ${profile.age}`;
    rightCol.appendChild(age);
  }

  if (profile.bust) {
    const bust = document.createElement('span');
    bust.className   = 'profile-details-meta';
    bust.textContent = `Bust: ${profile.bust}`;
    rightCol.appendChild(bust);
  }

  if (profile.phone) {
    const phone = document.createElement('a');
    phone.className   = 'profile-details-meta profile-details-phone';
    phone.href        = `tel:${profile.phone}`;
    phone.textContent = profile.phone;
    rightCol.appendChild(phone);
  }

  if (profile.tags?.length) {
    const tagsWrap = document.createElement('div');
    tagsWrap.className = 'profile-tags';
    profile.tags.forEach(tag => {
      const chip = document.createElement('span');
      chip.className   = 'profile-tag';
      chip.textContent = tag;
      chip.style.cursor = 'pointer';
      chip.addEventListener('click', () => { toggleRedvelvetTag(tag); runRedvelvetSearch(); });
      tagsWrap.appendChild(chip);
    });
    rightCol.appendChild(tagsWrap);
  }

  card.append(leftCol, rightCol);
  profileDetailsContainer.appendChild(card);

  // Show FAB now that has-profile is active
  if (isMobile()) {
    const filteredProfiles = profileLinks.filter(p => p.name.includes(filterKeyword) || p.area.includes(filterKeyword));
    syncMobileDrawer(filteredProfiles);
  }
}

function makeDownloadBtn(relayUrl, filename) {
  const btn = document.createElement('a');
  btn.className = 'img-download-btn';
  btn.title = 'Download';
  btn.innerHTML = '&#8595;';
  btn.href = relayUrl;
  btn.download = filename;
  btn.addEventListener('click', e => e.stopPropagation());
  return btn;
}

function wrapImageInItem(img, relayUrl, filename) {
  const wrap = document.createElement('div');
  wrap.className = 'masonry-item';
  wrap.appendChild(img);
  wrap.appendChild(makeDownloadBtn(relayUrl, filename));
  return wrap;
}

function inferImageExt(url) {
  const path = url.split('?')[0];
  const match = path.match(/\.(\w{2,5})$/);
  const ext = match ? match[1].toLowerCase() : '';
  return ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif'].includes(ext) ? `.${ext}` : '.jpg';
}

function getProfileName() {
  const nameEl = profileDetailsContainer.querySelector('.profile-details-name');
  return nameEl ? nameEl.textContent.trim().replace(/[\\/:*?"<>|]/g, '_') : 'profile';
}

function renderDownloadAllBtn(relayBase, toRelayImageUrl) {
  const existing = document.getElementById('download-all-btn');
  if (existing) existing.remove();

  const btn = document.createElement('button');
  btn.id = 'download-all-btn';
  btn.textContent = 'Download All Images';
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    const items = [...imagesContainer.querySelectorAll('.masonry-item')];
    const profileName = getProfileName();
    const zip = new window.JSZip();
    const folder = zip.folder(profileName);
    let done = 0;

    const updateLabel = () => { btn.textContent = `Zipping… ${done}/${items.length}`; };
    updateLabel();

    await Promise.all(items.map(async (item, idx) => {
      const img = item.querySelector('img');
      if (!img) return;
      const sourceUrl = img.dataset.sourceUrl || img.src;
      const filename = `${String(idx + 1).padStart(3, '0')}${inferImageExt(sourceUrl)}`;
      try {
        const res = await fetch(toRelayImageUrl(sourceUrl));
        if (!res.ok) throw new Error();
        folder.file(filename, await res.blob());
      } catch { /* skip failed */ }
      done++;
      updateLabel();
    }));

    btn.textContent = 'Building zip…';
    const blob = await zip.generateAsync({ type: 'blob' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${profileName}.zip`;
    a.click();
    URL.revokeObjectURL(a.href);

    btn.disabled = false;
    btn.textContent = 'Download All Images';
  });

  imagesContainer.before(btn);
}

function renderImages(videos = []) {
  clearImages();

  const relayBase = IMAGE_RELAY_BASE_URL.replace(/\/$/, '');
  const toRelayImageUrl = (url) => `${relayBase}/image?url=${encodeURIComponent(url)}`;
  const toDisplayImageUrl = (url) => {
    if (!/^https?:\/\//i.test(url)) return url;
    return toRelayImageUrl(url);
  };

  const profileName = getProfileName();
  let slot = 0;

  galleryImageUrls.forEach((url, idx) => {
    const img = document.createElement('img');
    img.alt       = 'gallery image';
    img.src       = toDisplayImageUrl(url);
    img.className = 'masonry-img';
    img.style.animationDelay = `${slot * 60}ms`;
    img.dataset.sourceUrl = url;
    const filename = `${profileName}_${String(idx + 1).padStart(3, '0')}${inferImageExt(url)}`;
    img.onerror = function () {
      recordFailedImage(this.dataset.sourceUrl || this.currentSrc || '');
      this.closest('.masonry-item')?.remove() ?? this.remove();
    };
    imagesContainer.appendChild(wrapImageInItem(img, toRelayImageUrl(url), filename));
    slot++;
  });

  let subSlot = galleryImageUrls.length;
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
      const filename = `${profileName}_${String(subSlot + 1).padStart(3, '0')}.jpg`;
      img.onerror = function () {
        const sourceUrl = this.dataset.sourceUrl || '';
        const smallSource = sourceUrl.replace('size=medium', 'size=small');
        if (sourceUrl.includes('size=medium')) {
          this.dataset.sourceUrl = smallSource;
          this.src = toDisplayImageUrl(smallSource);
        } else {
          recordFailedImage(sourceUrl || this.currentSrc || '');
          this.closest('.masonry-item')?.remove() ?? this.remove();
        }
      };
      imagesContainer.appendChild(wrapImageInItem(img, toRelayImageUrl(mediumSrc), filename));
      slot++;
      subSlot++;
    }
  });

  // Videos (RedVelvet selfie videos from /selfies/up/)
  (videos || []).forEach((url, idx) => {
    const relayUrl = toRelayImageUrl(url);
    const item = document.createElement('div');
    item.className = 'masonry-item';
    const video = document.createElement('video');
    video.controls = true;
    video.preload = 'metadata';
    video.loop = true;
    video.className = 'masonry-img';
    video.style.animationDelay = `${slot * 60}ms`;
    const source = document.createElement('source');
    source.src = relayUrl;
    source.type = 'video/mp4';
    video.appendChild(source);
    const filename = `${profileName}_video_${String(idx + 1).padStart(2, '0')}.mp4`;
    const dlBtn = document.createElement('a');
    dlBtn.className = 'img-download-btn';
    dlBtn.title = 'Download video';
    dlBtn.textContent = '⬇';
    dlBtn.href = relayUrl;
    dlBtn.download = filename;
    item.appendChild(video);
    item.appendChild(dlBtn);
    imagesContainer.appendChild(item);
    slot++;
  });

  if (slot > 0) renderDownloadAllBtn(relayBase, toRelayImageUrl);
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

const TAG_GROUPS = { Race: ['Asian', 'Black', 'Coloured', 'Indian', 'White'] };
const TAG_GROUP_MAP = new Map();
for (const [group, labels] of Object.entries(TAG_GROUPS))
  for (const label of labels) TAG_GROUP_MAP.set(label, group);

let redvelvetDropdownsReady = false;

function addPanelSearch(panel, placeholder) {
  const si = document.createElement('input');
  si.type = 'text';
  si.placeholder = placeholder;
  si.className = 'panel-search';
  si.addEventListener('click', e => e.stopPropagation());
  si.addEventListener('input', () => {
    const q = si.value.toLowerCase();
    panel.querySelectorAll('.tag-option').forEach(row => {
      row.style.display = row.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
    panel.querySelectorAll('.tag-group-header').forEach(header => {
      const group = header.dataset.groupHeader;
      const labels = TAG_GROUPS[group] || [];
      const anyVisible = labels.some(lbl => {
        const row = panel.querySelector(`.tag-option[data-value="${CSS.escape(lbl)}"]`);
        return row && row.style.display !== 'none';
      });
      header.style.display = anyVisible ? '' : 'none';
    });
  });
  panel.appendChild(si);
  return si;
}

async function initRedvelvetDropdowns() {
  if (redvelvetDropdownsReady) return;
  redvelvetDropdownsReady = true;
  const relayBase = IMAGE_RELAY_BASE_URL.replace(/\/$/, '');

  // Areas multi-select
  let areaSearchInput;
  try {
    const res = await fetch(`${relayBase}/redvelvet-areas?cityBucket=2`);
    if (res.ok) {
      const data = await res.json();
      areaDropdownPanel.innerHTML = '';
      areaSearchInput = addPanelSearch(areaDropdownPanel, 'Search areas…');
      (data.areas || []).forEach(area => {
        const row = document.createElement('div');
        row.className = 'tag-option';
        row.dataset.value = area;
        row.dataset.state = 'neutral';
        const box = document.createElement('span');
        box.className = 'tag-checkbox';
        const label = document.createElement('span');
        label.textContent = area;
        row.append(box, label);
        let clickTimer;
        row.addEventListener('click', () => { clearTimeout(clickTimer); clickTimer = setTimeout(() => { toggleRedvelvetArea(area); runRedvelvetSearch(); }, 220); });
        row.addEventListener('dblclick', () => { clearTimeout(clickTimer); excludeRedvelvetArea(area); runRedvelvetSearch(); });
        areaDropdownPanel.appendChild(row);
      });
    }
  } catch { /* silent */ }

  areaDropdownBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = areaDropdownPanel.style.display === 'block';
    areaDropdownPanel.style.display = open ? 'none' : 'block';
    if (!open && areaSearchInput) {
      areaSearchInput.value = '';
      areaDropdownPanel.querySelectorAll('.tag-option').forEach(r => r.style.display = '');
      areaSearchInput.focus();
    }
  });

  document.addEventListener('click', (e) => {
    if (!areaDropdownWrap.contains(e.target)) {
      areaDropdownPanel.style.display = 'none';
    }
  });

  // Tags multi-select
  let tagSearchInput;
  try {
    const res = await fetch(`${relayBase}/redvelvet-tags?`);
    if (res.ok) {
      const data = await res.json();
      tagDropdownPanel.innerHTML = '';
      tagSearchInput = addPanelSearch(tagDropdownPanel, 'Search tags…');

      // Sort: grouped tags first (in group definition order), then rest alphabetically
      const groupOrder = Object.values(TAG_GROUPS).flat();
      const sorted = [...(data.tags || [])].sort((a, b) => {
        const ai = groupOrder.indexOf(a.label);
        const bi = groupOrder.indexOf(b.label);
        if (ai !== -1 && bi !== -1) return ai - bi;
        if (ai !== -1) return -1;
        if (bi !== -1) return 1;
        return a.label.localeCompare(b.label);
      });

      const insertedGroups = new Set();
      sorted.forEach(({ label }) => {
        const group = TAG_GROUP_MAP.get(label);
        if (group && !insertedGroups.has(group)) {
          insertedGroups.add(group);
          const header = document.createElement('div');
          header.className = 'tag-group-header';
          header.textContent = group;
          header.dataset.groupHeader = group;
          tagDropdownPanel.appendChild(header);
        }
        const row = document.createElement('div');
        row.className = 'tag-option';
        row.dataset.value = label;
        row.dataset.state = 'neutral';
        const box = document.createElement('span');
        box.className = 'tag-checkbox';
        const labelSpan = document.createElement('span');
        labelSpan.textContent = label;
        row.append(box, labelSpan);
        let clickTimer;
        row.addEventListener('click', () => { clearTimeout(clickTimer); clickTimer = setTimeout(() => { toggleRedvelvetTag(label); runRedvelvetSearch(); }, 220); });
        row.addEventListener('dblclick', () => { clearTimeout(clickTimer); excludeRedvelvetTag(label); runRedvelvetSearch(); });
        tagDropdownPanel.appendChild(row);
      });
    }
  } catch { /* silent */ }

  tagDropdownBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = tagDropdownPanel.style.display === 'block';
    tagDropdownPanel.style.display = open ? 'none' : 'block';
    if (!open && tagSearchInput) {
      tagSearchInput.value = '';
      tagDropdownPanel.querySelectorAll('.tag-option, .tag-group-header').forEach(r => r.style.display = '');
      tagSearchInput.focus();
    }
  });

  document.addEventListener('click', (e) => {
    if (!tagDropdownWrap.contains(e.target)) {
      tagDropdownPanel.style.display = 'none';
    }
  });
}

let sizeDropdownsReady = false;

function initSizeDropdowns() {
  if (sizeDropdownsReady) return;
  sizeDropdownsReady = true;

  function buildPanel(panel, btn, getVol, setVol, defaultLabel) {
    SIZE_LEVELS.forEach(({ vol, label, sisters }) => {
      const row = document.createElement('div');
      row.className = 'size-option';
      row.dataset.vol = vol;
      const primary = document.createElement('span');
      primary.className = 'size-label';
      primary.textContent = label;
      row.appendChild(primary);
      if (sisters.length) {
        const sub = document.createElement('span');
        sub.className = 'size-sisters';
        sub.textContent = sisters.join(' · ');
        row.appendChild(sub);
      }
      row.addEventListener('click', () => {
        const current = getVol();
        const next = current === vol ? null : vol;
        setVol(next);
        panel.querySelectorAll('.size-option').forEach(r => r.classList.remove('selected'));
        if (next !== null) row.classList.add('selected');
        btn.textContent = next !== null
          ? `${defaultLabel === 'Min size ▾' ? '≥' : '≤'} ${label} ▾`
          : defaultLabel;
        panel.style.display = 'none';
        applyDetailFilters();
        updateFilterByBtnState();
      });
      panel.appendChild(row);
    });

    btn.addEventListener('click', e => {
      e.stopPropagation();
      const open = panel.style.display === 'block';
      panel.style.display = open ? 'none' : 'block';
    });
    document.addEventListener('click', e => {
      if (!btn.parentElement.contains(e.target)) panel.style.display = 'none';
    });
  }

  buildPanel(
    sizeMinPanel, sizeMinBtn,
    () => sizeMinVol, v => { sizeMinVol = v; },
    'Min size ▾',
  );
  buildPanel(
    sizeMaxPanel, sizeMaxBtn,
    () => sizeMaxVol, v => { sizeMaxVol = v; },
    'Max size ▾',
  );
}

function showRedvelvetDropdowns() {
  if (areaDropdownWrap) areaDropdownWrap.style.display = '';
  if (tagDropdownWrap) tagDropdownWrap.style.display = '';
  if (redvelvetDetailFilters) redvelvetDetailFilters.style.display = 'flex';
  document.getElementById('areaInput').style.display = 'none';
  dom.areaBtn.style.display = 'none';
}

function hideRedvelvetDropdowns() {
  if (areaDropdownWrap) areaDropdownWrap.style.display = 'none';
  if (tagDropdownWrap) tagDropdownWrap.style.display = 'none';
  if (redvelvetDetailFilters) redvelvetDetailFilters.style.display = 'none';
  document.getElementById('areaInput').style.display = '';
  dom.areaBtn.style.display = '';
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

function applyDetailFilters() {
  ageMin = Number(ageMinInput.value) || null;
  ageMax = Number(ageMaxInput.value) || null;
  selectedBand = bandSelect.value ? parseInt(bandSelect.value) : null;
  selectedCup  = cupSelect.value || '';
  if (activeProvider === 'redvelvet') {
    runRedvelvetSearch();
  } else {
    renderProfileCards();
  }
}

document.getElementById('searchInput')
  .addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });

document.getElementById('areaInput')
  .addEventListener('keydown', e => { if (e.key === 'Enter') doAreaSearch(); });

dom.searchBtn.addEventListener('click', doSearch);
dom.areaBtn.addEventListener('click', doAreaSearch);

// ── Filter modals ─────────────────────────────────────────────────────────

function openModal(id) { document.getElementById(id).style.display = 'flex'; }
function closeModal(id) { document.getElementById(id).style.display = 'none'; }

function updateFilterByBtnState() {
  const ageActive = ageMin !== null || ageMax !== null;
  const bustActive = selectedBand !== null || selectedCup || sizeMinVol !== null || sizeMaxVol !== null;
  document.getElementById('ageFilterBtn').classList.toggle('active', ageActive);
  document.getElementById('bustFilterBtn').classList.toggle('active', bustActive);
}

document.getElementById('ageFilterBtn').addEventListener('click', () => openModal('age-modal'));
document.getElementById('bustFilterBtn').addEventListener('click', () => openModal('bust-modal'));

// Age modal
document.getElementById('ageApplyBtn').addEventListener('click', () => {
  applyDetailFilters();
  updateFilterByBtnState();
  closeModal('age-modal');
});
document.getElementById('ageClearBtn').addEventListener('click', () => {
  ageMinInput.value = '';
  ageMaxInput.value = '';
  applyDetailFilters();
  updateFilterByBtnState();
  closeModal('age-modal');
});
document.getElementById('age-modal').addEventListener('click', e => {
  if (e.target === e.currentTarget) { applyDetailFilters(); updateFilterByBtnState(); closeModal('age-modal'); }
});

// Bust modal
document.getElementById('bustApplyBtn').addEventListener('click', () => {
  applyDetailFilters();
  updateFilterByBtnState();
  closeModal('bust-modal');
});
document.getElementById('bustClearBtn').addEventListener('click', () => {
  bandSelect.value = '';
  cupSelect.value = '';
  sizeMinVol = null;
  sizeMaxVol = null;
  document.getElementById('sizeMinBtn').textContent = 'Min size ▾';
  document.getElementById('sizeMaxBtn').textContent = 'Max size ▾';
  document.getElementById('sizeMinPanel').querySelectorAll('.size-option').forEach(o => o.classList.remove('selected'));
  document.getElementById('sizeMaxPanel').querySelectorAll('.size-option').forEach(o => o.classList.remove('selected'));
  applyDetailFilters();
  updateFilterByBtnState();
  closeModal('bust-modal');
});
document.getElementById('bust-modal').addEventListener('click', e => {
  if (e.target === e.currentTarget) { applyDetailFilters(); updateFilterByBtnState(); closeModal('bust-modal'); }
});

// ── Mobile profiles FAB + drawer ──────────────────────────────────────────

document.getElementById('profiles-fab').addEventListener('click', openProfilesDrawer);
document.getElementById('profiles-drawer-close').addEventListener('click', closeProfilesDrawer);
document.getElementById('profiles-drawer').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeProfilesDrawer();
});

document.getElementById('drawerFilterInput').addEventListener('input', e => {
  const kw = e.target.value.toLowerCase();
  document.getElementById('profiles-drawer-list').querySelectorAll('.profile-card').forEach(card => {
    const text = card.textContent.toLowerCase();
    card.style.display = text.includes(kw) ? '' : 'none';
  });
});

window.addEventListener('resize', () => {
  const fab = document.getElementById('profiles-fab');
  if (!fab) return;
  if (!isMobile()) {
    fab.style.display = 'none';
    closeProfilesDrawer();
    // re-render cards into the sidebar on resize to desktop
    if (profileLinks.length > 0) renderProfileCards();
  } else if (profileLinks.length > 0) {
    renderProfileCards();
  }
});

activeProvider = readSelectedProvider();
if (siteSelect) {
  siteSelect.value = activeProvider;
  if (activeProvider === 'redvelvet') {
    showRedvelvetDropdowns();
    initSizeDropdowns();
    initRedvelvetDropdowns().then(async () => {
      const didFilter = await restoreFilters();
      if (!didFilter) restoreLastSearch();
    });
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
      initSizeDropdowns();
      initRedvelvetDropdowns().then(async () => {
        const didFilter = await restoreFilters();
        if (!didFilter) restoreLastSearch();
      });
    } else {
      hideRedvelvetDropdowns();
      restoreLastSearch();
    }
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
if (activeProvider !== 'redvelvet') restoreLastSearch();
