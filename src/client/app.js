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
} from './modules/url-utils.js';
import {
  fetchEsaImagesFromProfile,
  fetchEsaProfilesByNickname,
} from './modules/providers/esa-service.js';
import {
  fetchRedvelvetProfilesByNickname as fetchRedvelvetProfilesByNicknameService,
  fetchRedvelvetProfilesByArea as fetchRedvelvetProfilesByAreaService,
} from './modules/providers/redvelvet-service.js';
import { debounce } from './modules/common-utils.js';
import {
  initFavorites,
  loadFavorites,
  isFavorite,
  toggleFavorite,
  renderFavoritesPanel,
} from './modules/favorites.js';
import {
  initGroups,
  findGroupForProfile,
  createGroup,
  addToGroup,
  removeFromGroup,
  mergeGroups,
  getGroupMembers,
  setGroupLinkType,
  setPairLinkType,
  getPairLinkType,
} from './modules/profile-groups.js';

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

let profileLinks      = [];
let galleryImageUrls  = [];
let failedImages      = new Set();
let activeProvider    = 'esa';
let filterKeyword     = '';
let activeTags   = new Set();
let excludedTags = new Set();
let activeAreas  = new Set();
let excludedAreas = new Set();
let detailCache        = new Map();
let ageMin = null, ageMax = null, selectedBand = null, selectedCup = '', sizeMinVol = null, sizeMaxVol = null;
let pendingLinkSource  = null;
const dismissedSuggestions = new Set();

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
  const missing = profiles.filter(p => p.provider === 'redvelvet' && !detailCache.has(`${p.provider}:${p.uid}`));
  if (!missing.length) return;
  let done = 0;
  await Promise.all(missing.map(async p => {
    try {
      const res = await fetch(`${relayBase}/redvelvet-profile-details?id=${encodeURIComponent(p.uid)}`);
      if (res.ok) {
        const data = await res.json();
        if (data?.profile) detailCache.set(`${p.provider}:${p.uid}`, data.profile);
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
  if (activeProvider === 'redvelvet') {
    runRedvelvetSearch();
  } else {
    runEsaSearch();
  }
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
  failedImages = new Set();
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

  if (failedImages.size === 0) {
    container.innerHTML = '';
    return;
  }

  const details = document.createElement('details');
  details.className = 'failed-images-details';

  const summary = document.createElement('summary');
  summary.textContent = `Failed images: ${failedImages.size}`;
  details.appendChild(summary);

  const list = document.createElement('ul');
  Array.from(failedImages).forEach(url => {
    const item = document.createElement('li');
    const link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = url.split('?')[0].split('/').pop() || url;
    item.appendChild(link);
    list.appendChild(item);
  });
  details.appendChild(list);

  container.innerHTML = '';
  container.appendChild(details);
}

function recordFailedImage(url) {
  if (!url) return;
  failedImages.add(url);
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
  document.getElementById('selected-output').style.display = 'none';
  setStatus('<span class="spinner"></span>Fetching results…');
  searchBtn.disabled = true;

  persistLastSearch(/^\d+$/.test(query) ? 'uid' : 'nickname', query);

  if (activeProvider === 'redvelvet') {
    if (/^https?:\/\/.*\/escorts\/escorts_details\//i.test(query)) {
      await fetchImagesFromProfile({ provider: 'redvelvet', profileUrl: query });
      return;
    }

    if (/^\d+$/.test(query)) {
      await fetchImagesFromProfile({ provider: 'redvelvet', uid: query });
    } else {
      await fetchRedvelvetProfilesByNickname(query);
    }
    return;
  }

  if (/^\d+$/.test(query)) {
    await fetchImagesFromProfile({ provider: 'esa', uid: query });
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

  if (activeProvider === 'esa') {
    if (!activeAreas.has(area)) {
      activeAreas.add(area);
      updateFilterChips();
    }
    document.getElementById('areaInput').value = '';
    persistLastSearch('area', area);
    runEsaSearch();
    return;
  }
}

// ─── PROFILE FETCHING ─────────────────────────────────────────────────────

async function fetchSingleProfileData(item) {
  const cacheKey = `${item.provider}:${item.uid}`;
  const cached = detailCache.get(cacheKey);
  if (cached) return { profile: cached, images: cached.images || [], videos: cached.videos || [] };

  const relayBase = IMAGE_RELAY_BASE_URL.replace(/\/$/, '');
  if (item.provider === 'redvelvet') {
    const uid = /^\d+$/.test(String(item.uid || ''))
      ? String(item.uid)
      : extractUidFromUrl(String(item.profileUrl || ''));
    if (!uid) throw new Error('Could not determine profile ID.');
    const res = await fetch(`${relayBase}/redvelvet-profile-details?id=${encodeURIComponent(uid)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    if (data.profile) detailCache.set(cacheKey, { ...data.profile, images: data.images || [], videos: data.videos || [] });
    return data;
  } else {
    const data = await fetchEsaImagesFromProfile(item.uid, { setStatus: () => {}, searchBtn: { disabled: false } });
    if (!data) throw new Error('Failed to fetch ESA profile.');
    if (data.profile) detailCache.set(cacheKey, { ...data.profile, images: data.images || [], videos: data.videos || [] });
    return data;
  }
}

function suggestPhoneLinks(item, profileForPhone) {
  if (!profileForPhone?.phone) return;
  const myKey = `${profileForPhone.provider}:${profileForPhone.uid}`;
  const seenKeys = new Set([myKey]);
  const peers = [];

  const inSameGroup = (p) => {
    const ga = findGroupForProfile(profileForPhone.provider, profileForPhone.uid);
    const gb = findGroupForProfile(p.provider, p.uid);
    return ga && gb && ga.id === gb.id;
  };

  for (const ref of (item.profiles_with_same_number || [])) {
    const k = `${ref.provider}:${ref.uid}`;
    if (seenKeys.has(k)) continue;
    const pairKey = [myKey, k].sort().join('|');
    if (dismissedSuggestions.has(pairKey)) continue;
    const p = profileLinks.find(x => x.uid === ref.uid && x.provider === ref.provider) || ref;
    if (inSameGroup(p)) continue;
    seenKeys.add(k);
    peers.push(p);
  }

  const myPhone = normalizePhone(profileForPhone.phone);
  if (myPhone.length >= 7) {
    for (const [key, cached] of detailCache) {
      if (seenKeys.has(key)) continue;
      if (normalizePhone(cached.phone) !== myPhone) continue;
      const pairKey = [myKey, key].sort().join('|');
      if (dismissedSuggestions.has(pairKey) || inSameGroup(cached)) continue;
      seenKeys.add(key);
      peers.push(cached);
    }
  }

  if (peers.length > 0) showPhoneLinkModal(profileForPhone, peers);
}

async function fetchImagesFromProfile(item, { single = false } = {}) {
  if (single) {
    clearProfileDetails();
    clearImages();
  }

  const group = !single && findGroupForProfile(item.provider, item.uid);

  if (group && group.members.length >= 2) {
    renderMergedProfileDetails(group, item);
    profileDetailsContainer.scrollIntoView({ behavior: 'smooth' });
    return;
  }

  const relayBase = IMAGE_RELAY_BASE_URL.replace(/\/$/, '');
  let data;

  const cacheKey = `${item.provider}:${item.uid}`;
  const cachedProfile = detailCache.get(cacheKey);

  if (cachedProfile) {
    data = { profile: cachedProfile, images: cachedProfile.images || [], videos: cachedProfile.videos || [] };
  } else if (item.provider === 'redvelvet' || activeProvider === 'redvelvet') {
    const uid = /^\d+$/.test(String(item.uid || ''))
      ? String(item.uid)
      : extractUidFromUrl(String(item.profileUrl || ''));
    if (!uid) { setStatus('Could not determine profile ID.', true); return; }

    setStatus('<span class="spinner"></span>Fetching profile…');
    searchBtn.disabled = true;
    try {
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
    if (data.profile) detailCache.set(cacheKey, { ...data.profile, images: data.images || [], videos: data.videos || [] });
  } else {
    data = await fetchEsaImagesFromProfile(item.uid, { setStatus, searchBtn });
    if (!data) return;
    if (data.profile) detailCache.set(cacheKey, { ...data.profile, images: data.images || [], videos: data.videos || [] });
  }

  const onAreaClickRv = p => fetchRedvelvetProfilesByArea(p.area);
  const onAreaClickEsa = p => {
    activeAreas.clear(); excludedAreas.clear();
    activeAreas.add(p.area);
    updateFilterChips(); runEsaSearch();
  };
  renderProfileDetails(data.profile, {
    onAreaClick: (item.provider === 'redvelvet' || activeProvider === 'redvelvet') ? onAreaClickRv : onAreaClickEsa,
    onTagClick: data.profile?.provider === 'redvelvet' ? tag => { toggleRedvelvetTag(tag); runRedvelvetSearch(); } : null,
  });

  suggestPhoneLinks(item, data.profile);

  // Render venue section for any non-profile group peers
  if (data.profile) {
    const g = findGroupForProfile(data.profile.provider, data.profile.uid);
    if (g) {
      const venueMembers = g.members
        .filter(m => !(m.provider === data.profile.provider && String(m.uid) === String(data.profile.uid)))
        .map(m => ({ member: m, type: getPairLinkType(g, data.profile.provider, data.profile.uid, m.provider, m.uid) }))
        .filter(({ type }) => type !== 'profile');
      if (venueMembers.length > 0) renderVenueSection(venueMembers, data.profile.provider);
    }
  }

  galleryImageUrls = data.images || [];
  const videos     = data.videos || [];
  const totalCount = galleryImageUrls.length + videos.length;
  setStatus(`Found ${totalCount} media item${totalCount === 1 ? '' : 's'}.`);
  profileDetailsContainer.scrollIntoView({ behavior: 'smooth' });
  setTimeout(() => renderImages(videos), (item.provider === 'redvelvet' || activeProvider === 'redvelvet') ? 300 : 500);
}

const LINK_TYPES = ['profile', 'venue', 'unknown', 'unrelated'];
const LINK_TYPE_LABELS = { profile: 'Same profile', venue: 'Venue', unknown: 'Unknown', unrelated: 'Unrelated' };

function showPhoneLinkModal(currentProfile, peers, opts = {}) {
  const existing = document.getElementById('phone-link-modal');
  if (existing) existing.remove();

  const relayBase = IMAGE_RELAY_BASE_URL.replace(/\/$/, '');
  const myKey = `${currentProfile.provider}:${currentProfile.uid}`;

  // Track selected link type per peer — pre-populate from existing pairs if provided
  const peerTypes = new Map(peers.map(p => {
    const initial = opts.existingGroup
      ? getPairLinkType(opts.existingGroup, currentProfile.provider, currentProfile.uid, p.provider, p.uid)
      : 'unknown';
    return [`${p.provider}:${p.uid}`, initial];
  }));

  const overlay = document.createElement('div');
  overlay.id = 'phone-link-modal';
  overlay.className = 'phone-link-modal';

  const box = document.createElement('div');
  box.className = 'phone-link-modal-box';

  const title = document.createElement('div');
  title.className = 'phone-link-modal-title';
  title.textContent = opts.existingGroup ? 'Manage linked profiles' : 'Same phone number detected';
  box.appendChild(title);

  const subtitle = document.createElement('div');
  subtitle.className = 'phone-link-modal-subtitle';
  subtitle.textContent = `${currentProfile.name}${currentProfile.phone ? ' · ' + currentProfile.phone : ''}`;
  box.appendChild(subtitle);

  const peerList = document.createElement('div');
  peerList.className = 'phone-link-peer-list';

  peers.forEach(peer => {
    const peerKey = `${peer.provider}:${peer.uid}`;
    const row = document.createElement('div');
    row.className = 'phone-link-peer-row';

    const thumb = document.createElement('img');
    thumb.className = 'phone-link-peer-thumb';
    const thumbSrc = peer.thumbUrl && /^https?:\/\//i.test(peer.thumbUrl)
      ? `${relayBase}/image?url=${encodeURIComponent(peer.thumbUrl)}`
      : peer.thumbUrl || '';
    thumb.src = thumbSrc || 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="100%" height="100%" fill="%23334155"/></svg>';
    thumb.alt = peer.name || '';

    const info = document.createElement('div');
    info.className = 'phone-link-peer-info';
    const peerName = document.createElement('div');
    peerName.className = 'phone-link-peer-name';
    peerName.textContent = peer.name || `UID ${peer.uid}`;
    const peerArea = document.createElement('div');
    peerArea.className = 'phone-link-peer-area';
    peerArea.textContent = peer.area || (peer.provider === 'redvelvet' ? 'RV' : 'ESA');
    info.append(peerName, peerArea);

    const badge = document.createElement('button');
    badge.className = 'link-type-badge';
    const updateBadge = () => {
      const type = peerTypes.get(peerKey);
      badge.textContent = LINK_TYPE_LABELS[type];
      badge.dataset.type = type;
    };
    updateBadge();
    badge.addEventListener('click', () => {
      const cur = peerTypes.get(peerKey);
      const next = LINK_TYPES[(LINK_TYPES.indexOf(cur) + 1) % LINK_TYPES.length];
      peerTypes.set(peerKey, next);
      updateBadge();
    });

    row.append(thumb, info, badge);

    if (opts.existingGroup) {
      const removeBtn = document.createElement('button');
      removeBtn.textContent = '✕';
      removeBtn.title = 'Remove from group';
      removeBtn.style.cssText = 'background:none;border:none;color:#f87171;cursor:pointer;font-size:0.9rem;padding:0 4px;flex-shrink:0;';
      removeBtn.addEventListener('click', () => {
        removeFromGroup(opts.existingGroup.id, peer.provider, peer.uid);
        row.remove();
        if (opts.onUpdate) opts.onUpdate();
        renderProfileCards();
      });
      row.appendChild(removeBtn);
    }

    peerList.appendChild(row);
  });
  box.appendChild(peerList);

  const footer = document.createElement('div');
  footer.className = 'phone-link-modal-footer';

  const confirmBtn = document.createElement('button');
  confirmBtn.className = 'phone-link-confirm-btn';
  confirmBtn.textContent = 'Save';
  confirmBtn.addEventListener('click', () => {
    overlay.remove();
    if (opts.existingGroup) {
      peers.forEach(peer => {
        const type = peerTypes.get(`${peer.provider}:${peer.uid}`);
        setPairLinkType(opts.existingGroup.id, currentProfile.provider, currentProfile.uid, peer.provider, peer.uid, type);
      });
      if (opts.onUpdate) opts.onUpdate();
    } else {
      peers.forEach(peer => {
        const peerKey = `${peer.provider}:${peer.uid}`;
        const type = peerTypes.get(peerKey);
        const pk = [myKey, peerKey].sort().join('|');
        if (type === 'unrelated') {
          dismissedSuggestions.add(pk);
        } else {
          confirmLink(currentProfile, peer, type);
        }
      });
    }
    renderProfileCards();
  });

  const secondaryBtn = document.createElement('button');
  secondaryBtn.className = 'phone-link-dismiss-btn';
  if (opts.existingGroup) {
    secondaryBtn.textContent = 'Add another';
    secondaryBtn.addEventListener('click', () => {
      overlay.remove();
      pendingLinkSource = currentProfile;
      renderProfileCards();
    });
  } else {
    secondaryBtn.textContent = 'Dismiss all';
    secondaryBtn.addEventListener('click', () => {
      overlay.remove();
      peers.forEach(peer => {
        const peerKey = `${peer.provider}:${peer.uid}`;
        dismissedSuggestions.add([myKey, peerKey].sort().join('|'));
      });
    });
  }

  footer.append(confirmBtn, secondaryBtn);
  box.appendChild(footer);
  overlay.appendChild(box);

  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
}

async function fetchProfilesByNickname(nickname) {
  clearProfiles();
  profileLinks = await fetchEsaProfilesByNickname(nickname, { setStatus, searchBtn });
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
  exitProfileView();
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

async function runEsaSearch() {
  exitProfileView();
  clearImages();
  clearProfileDetails();
  clearProfilesContainer();

  const hasIncludes = activeAreas.size > 0;
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
  };

  setStatus('<span class="spinner"></span>Searching…');
  searchBtn.disabled = true;
  const relayBase = IMAGE_RELAY_BASE_URL.replace(/\/$/, '');
  try {
    const res = await fetch(`${relayBase}/esa-search`, {
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


// ─── PROFILE GROUPS ───────────────────────────────────────────────────────

function normalizePhone(raw) {
  return String(raw || '').replace(/\D/g, '');
}

function cancelLinkPickMode() {
  pendingLinkSource = null;
  const banner = document.getElementById('link-pick-banner');
  if (banner) banner.remove();
  renderProfileCards();
}

function enrichWithPhone(profile) {
  if (profile.phone) return profile;
  const cached = detailCache.get(`${profile.provider}:${profile.uid}`);
  return cached?.phone ? { ...profile, phone: cached.phone } : profile;
}

function confirmLink(profileA, profileB, linkType = 'unknown') {
  const a = enrichWithPhone(profileA);
  const b = enrichWithPhone(profileB);

  const groupA = findGroupForProfile(a.provider, a.uid);
  const groupB = findGroupForProfile(b.provider, b.uid);

  let groupId;
  if (groupA && groupB) {
    if (groupA.id !== groupB.id) mergeGroups(groupA.id, groupB.id);
    groupId = groupA.id;
  } else if (groupA) {
    addToGroup(groupA.id, b);
    groupId = groupA.id;
  } else if (groupB) {
    addToGroup(groupB.id, a);
    groupId = groupB.id;
  } else {
    groupId = createGroup(a, b, linkType);
  }

  if (groupId) setPairLinkType(groupId, a.provider, a.uid, b.provider, b.uid, linkType);

  cancelLinkPickMode();
}

// ─── RENDERING ────────────────────────────────────────────────────────────


function cardClickHandler(item) {
  fetchImagesFromProfile(item);
}

const CARD_PLACEHOLDER = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="320" height="220"><rect width="100%" height="100%" fill="%23f3f3f3"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="%23777" font-size="16">No Image</text></svg>';

function buildProfileCard(item, index, { onClickExtra, onProfileClick } = {}) {
  const relayBase = IMAGE_RELAY_BASE_URL.replace(/\/$/, '');
  const toCardImageUrl = (url) => (url && /^https?:\/\//i.test(url)) ? `${relayBase}/image?url=${encodeURIComponent(url)}` : url;
  const buildFallback = (card) => (card?.provider === 'redvelvet' && card?.uid) ? 'https://redvelvet.co.za/Assets/images/noimage.png' : '';

  const uid      = item.uid;
  const namePart = item.name || `UID ${uid}`;
  const areaPart = item.area || '';
  const imgSrc   = toCardImageUrl(item.thumbUrl || buildFallback(item)) || CARD_PLACEHOLDER;

  const wrapper = document.createElement('div');
  wrapper.className = 'profile-card';
  wrapper.style.animationDelay = `${index * 50}ms`;
  wrapper.title = `Click to load images for uid ${uid}`;
  wrapper.addEventListener('click', () => {
    if (onClickExtra) onClickExtra();
    if (onProfileClick) onProfileClick(item);
  });

  const img = document.createElement('img');
  img.src = imgSrc; img.alt = `${namePart} ${areaPart}`.trim(); img.className = 'profile-thumb';

  const name = document.createElement('div');
  name.className = 'profile-name'; name.textContent = namePart;

  const number = document.createElement('div');
  number.className = 'profile-number'; number.textContent = areaPart;

  wrapper.append(img, name, number);

  const sameNumberCount = (item.profiles_with_same_number || []).length;
  if (sameNumberCount > 0) {
    const bubble = document.createElement('span');
    bubble.className = 'profile-card-same-number';
    bubble.textContent = sameNumberCount + 1;
    bubble.title = `${sameNumberCount + 1} profiles share this number`;
    wrapper.appendChild(bubble);
  }

  const group = findGroupForProfile(item.provider, item.uid);
  if (group) {
    const badge = document.createElement('span');
    badge.className = 'profile-card-linked';
    if (sameNumberCount > 0) badge.style.right = '32px';
    const type = group.linkType || 'unknown';
    badge.title = `Linked (${type}) with ${group.members.length - 1} other profile${group.members.length > 2 ? 's' : ''}`;
    badge.textContent = '🔗';
    wrapper.appendChild(badge);
  }

  if (pendingLinkSource) {
    const srcKey = `${pendingLinkSource.provider}:${pendingLinkSource.uid}`;
    const thisKey = `${item.provider}:${item.uid}`;
    if (srcKey !== thisKey) {
      const overlay = document.createElement('div');
      overlay.className = 'profile-card-link-overlay';
      const btn = document.createElement('button');
      btn.textContent = 'Link this';
      btn.addEventListener('click', e => {
        e.stopPropagation();
        confirmLink(pendingLinkSource, item);
      });
      overlay.appendChild(btn);
      wrapper.appendChild(overlay);
    }
  }

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
    drawerList.appendChild(buildProfileCard(item, index, {
      onClickExtra: closeProfilesDrawer,
      onProfileClick: cardClickHandler,
    }));
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

  if (pendingLinkSource) {
    const banner = document.createElement('div');
    banner.id = 'link-pick-banner';
    banner.className = 'link-pick-banner';
    const msg = document.createElement('span');
    msg.textContent = `Pick a profile to link with ${pendingLinkSource.name} — or cancel`;
    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', cancelLinkPickMode);
    banner.append(msg, cancelBtn);
    profilesContainer.appendChild(banner);
  }

  const kw = filterKeyword.toLowerCase();
  const filteredProfiles = profileLinks
    .filter(profile => profile.name.toLowerCase().includes(kw) || profile.area.toLowerCase().includes(kw));

  if (filteredProfiles.length > 0 && filterBar) filterBar.style.display = 'flex';

  filteredProfiles.forEach((item, index) => {
    if (!item.uid) return;
    profilesContainer.appendChild(buildProfileCard(item, index, { onProfileClick: cardClickHandler }));
  });

  syncMobileDrawer(filteredProfiles);
}


function renderProfileDetails(profile, { onAreaClick, onTagClick, skipClear = false } = {}) {
  if (!skipClear) clearProfileDetails();
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
  areaBtn.disabled = !areaTarget || !onAreaClick;
  if (areaTarget && onAreaClick) {
    areaBtn.addEventListener('click', () => onAreaClick(profile));
  }

  const favoriteBtn = document.createElement('button');
  favoriteBtn.id        = 'favorite-toggle-btn';
  favoriteBtn.className = 'favorite-star-btn';
  favoriteBtn.textContent = isFavorite(profile.uid) ? '★' : '☆';
  favoriteBtn.title = isFavorite(profile.uid) ? 'Remove from favorites' : 'Add to favorites';
  favoriteBtn.addEventListener('click', () => toggleFavorite(profile));

  const existingGroup = findGroupForProfile(profile.provider, profile.uid);
  const linkBtn = document.createElement('button');
  linkBtn.className = existingGroup ? 'profile-link-btn is-linked' : 'profile-link-btn';

  const updateLinkBtn = () => {
    const g = findGroupForProfile(profile.provider, profile.uid);
    if (g) {
      const count = g.members.length;
      const peers = g.members.filter(m => !(m.provider === profile.provider && String(m.uid) === String(profile.uid)));
      const types = [...new Set(peers.map(m => getPairLinkType(g, profile.provider, profile.uid, m.provider, m.uid)))];
      const typeLabel = types.length === 1 ? types[0] : types.join('/');
      linkBtn.textContent = `Linked (${count}) · ${typeLabel}`;
      linkBtn.className = 'profile-link-btn is-linked';
      linkBtn.title = peers.map(m => {
        const t = getPairLinkType(g, profile.provider, profile.uid, m.provider, m.uid);
        return `${m.name} (${m.provider === 'redvelvet' ? 'RV' : 'ESA'}) · ${t}`;
      }).join(', ');
    } else {
      linkBtn.textContent = 'Link profile';
      linkBtn.className = 'profile-link-btn';
      linkBtn.title = 'Link this profile with another';
    }
  };
  updateLinkBtn();

  linkBtn.addEventListener('click', () => {
    const g = findGroupForProfile(profile.provider, profile.uid);
    if (g) {
      const peers = g.members.filter(m => !(m.provider === profile.provider && String(m.uid) === String(profile.uid)));
      showPhoneLinkModal(profile, peers, { existingGroup: g, onUpdate: updateLinkBtn });
    } else {
      pendingLinkSource = profile;
      renderProfileCards();
    }
  });

  actionsRow.append(areaBtn, favoriteBtn, linkBtn);
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
    const phoneRow = document.createElement('div');
    phoneRow.className = 'profile-phone-row';

    const phoneLink = document.createElement('a');
    phoneLink.className   = 'profile-details-meta profile-details-phone';
    phoneLink.href        = `tel:${profile.phone}`;
    phoneLink.textContent = profile.phone;

    const digits   = profile.phone.replace(/\D/g, '');
    const waNumber = digits.startsWith('0') ? '27' + digits.slice(1) : digits;
    const waText   = `Hi ${profile.name}\n\nI saw your profile on ${profile.profileUrl}\n\nI wanted to know what services you offer, and what the prices are.`;

    const callBtn = document.createElement('a');
    callBtn.className = 'phone-action-btn call-btn';
    callBtn.href      = `tel:${profile.phone}`;
    callBtn.title     = 'Call';
    callBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M6.62 10.79c1.44 2.83 3.76 5.15 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.24.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"/></svg>`;

    const waBtn = document.createElement('a');
    waBtn.className = 'phone-action-btn whatsapp-btn';
    waBtn.href      = `https://wa.me/${waNumber}?text=${encodeURIComponent(waText)}`;
    waBtn.target    = '_blank';
    waBtn.rel       = 'noopener noreferrer';
    waBtn.title     = 'Message on WhatsApp';
    waBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>`;

    phoneRow.append(phoneLink, callBtn, waBtn);
    rightCol.appendChild(phoneRow);
  }

  if (profile.tags?.length && onTagClick) {
    const tagsWrap = document.createElement('div');
    tagsWrap.className = 'profile-tags';
    profile.tags.forEach(tag => {
      const chip = document.createElement('span');
      chip.className   = 'profile-tag';
      chip.textContent = tag;
      chip.style.cursor = 'pointer';
      chip.addEventListener('click', () => onTagClick(tag));
      tagsWrap.appendChild(chip);
    });
    rightCol.appendChild(tagsWrap);
  }

  card.append(leftCol, rightCol);
  profileDetailsContainer.appendChild(card);

  // Show FAB now that has-profile is active
  if (isMobile()) {
    const kw = filterKeyword.toLowerCase();
    const filteredProfiles = profileLinks.filter(p => p.name.toLowerCase().includes(kw) || p.area.toLowerCase().includes(kw));
    syncMobileDrawer(filteredProfiles);
  }
}

function renderVenueSection(members, currentProvider) {
  const relayBase = IMAGE_RELAY_BASE_URL.replace(/\/$/, '');

  // Cluster members that are "same person" with each other into single rows.
  const used = new Set();
  const rows = [];
  for (let i = 0; i < members.length; i++) {
    if (used.has(i)) continue;
    const clusterMembers = [members[i]];
    used.add(i);
    for (let j = i + 1; j < members.length; j++) {
      if (used.has(j)) continue;
      const ga = findGroupForProfile(members[i].member.provider, members[i].member.uid);
      const gb = findGroupForProfile(members[j].member.provider, members[j].member.uid);
      if (ga && gb && ga.id === gb.id) {
        const t = getPairLinkType(ga, members[i].member.provider, members[i].member.uid, members[j].member.provider, members[j].member.uid);
        if (t === 'profile') { clusterMembers.push(members[j]); used.add(j); }
      }
    }
    // Representative for thumbnail/name: same provider as current, else first
    const rep = clusterMembers.find(m => m.member.provider === currentProvider) || clusterMembers[0];
    rows.push({ rep, clusterMembers, type: rep.type });
  }

  const venueSection = document.createElement('div');
  venueSection.className = 'venue-section';

  const venueHeader = document.createElement('button');
  venueHeader.className = 'venue-section-header';
  const labelTypes = [...new Set(rows.map(r => r.type))].join('/');
  venueHeader.innerHTML = `<span class="venue-section-label">${labelTypes} · ${rows.length} profile${rows.length > 1 ? 's' : ''}</span><span class="venue-section-chevron">›</span>`;

  const venueList = document.createElement('div');
  venueList.className = 'venue-section-list';
  venueList.style.display = 'none';

  rows.forEach(({ rep, clusterMembers }) => {
    const { member } = rep;
    const row = document.createElement('button');
    row.className = 'venue-section-member';
    const thumbSrc = member.thumbUrl && /^https?:\/\//i.test(member.thumbUrl)
      ? `${relayBase}/image?url=${encodeURIComponent(member.thumbUrl)}`
      : member.thumbUrl || '';
    const thumb = document.createElement('img');
    thumb.className = 'venue-section-thumb';
    thumb.src = thumbSrc || 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="100%" height="100%" fill="%23334155"/></svg>';
    thumb.alt = member.name || '';
    const info = document.createElement('span');
    const provLabels = [...new Set(clusterMembers.map(m => m.member.provider === 'redvelvet' ? 'RV' : 'ESA'))].join('/');
    info.textContent = `${member.name} (${provLabels})`;
    row.append(thumb, info);
    row.addEventListener('click', () => {
      const primary = clusterMembers.find(m => m.member.provider === currentProvider) || clusterMembers[0];
      // Single provider cluster: open directly. Multi-provider: let group branch render tabs.
      const isSingleProvider = new Set(clusterMembers.map(m => m.member.provider)).size === 1;
      fetchImagesFromProfile(primary.member, { single: isSingleProvider });
    });
    venueList.appendChild(row);
  });

  venueHeader.addEventListener('click', () => {
    const open = venueList.style.display !== 'none';
    venueList.style.display = open ? 'none' : '';
    venueHeader.classList.toggle('open', !open);
  });

  venueSection.append(venueHeader, venueList);
  profileDetailsContainer.appendChild(venueSection);
}

function renderMergedProfileDetails(group, clickedItem) {
  clearProfileDetails();
  clearImages();
  contentLayout?.classList.add('has-profile');

  const relayBase = IMAGE_RELAY_BASE_URL.replace(/\/$/, '');
  const toRelayImageUrl = (url) => `${relayBase}/image?url=${encodeURIComponent(url)}`;
  const toDisplayImageUrl = (url) => /^https?:\/\//i.test(url) ? toRelayImageUrl(url) : url;

  // ── Split members into "same person" tabs vs venue/other ─────────────────
  // Primary = the member matching the clicked item (or first member)
  const primaryMember = group.members.find(
    m => m.provider === clickedItem.provider && String(m.uid) === String(clickedItem.uid)
  ) || group.members[0];

  const tabMembers = [primaryMember];
  const venueMembers = [];

  group.members.forEach(m => {
    if (m.provider === primaryMember.provider && String(m.uid) === String(primaryMember.uid)) return;
    const type = getPairLinkType(group, primaryMember.provider, primaryMember.uid, m.provider, m.uid);
    if (type === 'profile') {
      tabMembers.push(m);
    } else {
      venueMembers.push({ member: m, type });
    }
  });

  // ── Tab bar ──────────────────────────────────────────────────────────────
  const tabBar = document.createElement('div');
  tabBar.className = 'merged-tab-bar';

  const unlinkBtn = document.createElement('button');
  unlinkBtn.className = 'merged-tab-unlink';
  unlinkBtn.textContent = 'Unlink all';
  unlinkBtn.title = 'Remove this group — profiles remain, just unlinked';
  unlinkBtn.addEventListener('click', () => {
    const members = [...group.members];
    members.forEach(m => removeFromGroup(group.id, m.provider, m.uid));
    renderProfileCards();
    clearProfileDetails();
    clearImages();
    contentLayout?.classList.remove('has-profile');
  });

  tabMembers.forEach((m, i) => {
    const tab = document.createElement('button');
    tab.className = 'merged-tab' + (i === 0 ? ' active' : '');
    const prov = m.provider === 'redvelvet' ? 'RV' : 'ESA';
    tab.textContent = `${m.name} (${prov})`;
    tab.addEventListener('click', () => switchTab(i));
    tabBar.appendChild(tab);
  });

  tabBar.appendChild(unlinkBtn);
  profileDetailsContainer.appendChild(tabBar);

  // ── Venue section (collapsed by default) ─────────────────────────────────
  if (venueMembers.length > 0) {
    renderVenueSection(venueMembers, primaryMember.provider);
  }

  // Gallery wrapper per tab member — populated lazily on first activation
  const galleryWrappers = tabMembers.map((m, i) => {
    const wrapper = document.createElement('div');
    wrapper.className = 'merged-gallery-pane' + (i === 0 ? ' active' : '');
    wrapper.style.display = i === 0 ? '' : 'none';
    wrapper.dataset.loaded = 'false';
    imagesContainer.appendChild(wrapper);
    return wrapper;
  });

  // ── Switch tab: lazy-load on first visit ─────────────────────────────────
  const switchTab = async (index) => {
    tabBar.querySelectorAll('.merged-tab').forEach((t, i) => t.classList.toggle('active', i === index));
    galleryWrappers.forEach((w, i) => {
      w.style.display = i === index ? '' : 'none';
      w.classList.toggle('active', i === index);
    });

    const existingCard = profileDetailsContainer.querySelector('.profile-details-card');
    if (existingCard) existingCard.remove();

    const member = tabMembers[index];
    const wrapper = galleryWrappers[index];

    // Check if already loaded
    const cacheKey = `${member.provider}:${member.uid}`;
    let result = detailCache.get(cacheKey);

    if (!result) {
      setStatus('<span class="spinner"></span>Fetching profile…');
      searchBtn.disabled = true;
      try {
        const data = await fetchSingleProfileData(member);
        result = { ...data.profile, images: data.images || [], videos: data.videos || [] };
        detailCache.set(cacheKey, result);
      } catch (err) {
        setStatus(`Error: ${err.message}`, true);
        searchBtn.disabled = false;
        const errEl = document.createElement('p');
        errEl.style.cssText = 'color:#f87171;padding:12px;';
        errEl.textContent = `Could not load profile: ${err.message}`;
        profileDetailsContainer.appendChild(errEl);
        galleryImageUrls = [];
        return;
      }
      searchBtn.disabled = false;
    }

    // Populate gallery wrapper if not yet done
    if (wrapper.dataset.loaded === 'false') {
      wrapper.dataset.loaded = 'true';
      const images = result.images || [];
      const videos = result.videos || [];
      const profileName = (result.name || 'profile').replace(/[\\/:*?"<>|]/g, '_');
      let slot = 0;

      images.forEach((url, idx) => {
        const img = document.createElement('img');
        img.alt = 'gallery image';
        img.src = toDisplayImageUrl(url);
        img.className = 'masonry-img';
        img.style.animationDelay = `${slot * 60}ms`;
        img.dataset.sourceUrl = url;
        const filename = `${profileName}_${String(idx + 1).padStart(3, '0')}${inferImageExt(url)}`;
        img.onerror = function () {
          recordFailedImage(this.dataset.sourceUrl || this.currentSrc || '');
          this.closest('.masonry-item')?.remove() ?? this.remove();
        };
        wrapper.appendChild(wrapImageInItem(img, toRelayImageUrl(url), filename));
        slot++;
      });

      videos.forEach((url, idx) => {
        const relayUrl = toRelayImageUrl(url);
        const item = document.createElement('div');
        item.className = 'masonry-item';
        const video = document.createElement('video');
        video.controls = true; video.preload = 'metadata'; video.loop = true;
        video.className = 'masonry-img';
        video.style.animationDelay = `${slot * 60}ms`;
        const source = document.createElement('source');
        source.src = relayUrl; source.type = 'video/mp4';
        video.appendChild(source);
        const filename = `${profileName}_video_${String(idx + 1).padStart(2, '0')}.mp4`;
        const dlBtn = document.createElement('a');
        dlBtn.className = 'img-download-btn'; dlBtn.title = 'Download video';
        dlBtn.textContent = '⬇'; dlBtn.href = relayUrl; dlBtn.download = filename;
        item.append(video, dlBtn);
        wrapper.appendChild(item);
        slot++;
      });
    }

    galleryImageUrls = result.images || [];
    const total = galleryImageUrls.length + (result.videos?.length || 0);
    setStatus(`Found ${total} media item${total === 1 ? '' : 's'}.`);

    renderProfileDetails(result, {
      skipClear: true,
      onAreaClick: p => {
        if (p.provider === 'redvelvet') {
          fetchRedvelvetProfilesByArea(p.area);
        } else {
          activeAreas.clear(); excludedAreas.clear();
          activeAreas.add(p.area);
          updateFilterChips(); runEsaSearch();
        }
      },
      onTagClick: result.provider === 'redvelvet'
        ? tag => { toggleRedvelvetTag(tag); runRedvelvetSearch(); }
        : null,
    });

    // Suggest phone links for newly loaded profiles
    suggestPhoneLinks(member, result);

    renderDownloadAllBtn(relayBase, toRelayImageUrl);
  };

  switchTab(0);
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
    const activeGallery = imagesContainer.querySelector('.merged-gallery-pane.active');
    const items = [...(activeGallery || imagesContainer).querySelectorAll('.masonry-item')];
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

// ─── REDVELVET DROPDOWNS ──────────────────────────────────────────────────

const TAG_GROUPS = { Race: ['Asian', 'Black', 'Coloured', 'Indian', 'White'] };
const TAG_GROUP_MAP = new Map();
for (const [group, labels] of Object.entries(TAG_GROUPS))
  for (const label of labels) TAG_GROUP_MAP.set(label, group);

// Current search input for the area panel — updated each time the panel is populated.
let _areaSearchInput = null;
let _tagSearchInput  = null;

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

// Wire the dropdown button/outside-click listeners exactly once.
let dropdownButtonsWired = false;
function initDropdownButtons() {
  if (dropdownButtonsWired) return;
  dropdownButtonsWired = true;

  areaDropdownBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = areaDropdownPanel.style.display === 'block';
    areaDropdownPanel.style.display = open ? 'none' : 'block';
    if (!open && _areaSearchInput) {
      _areaSearchInput.value = '';
      areaDropdownPanel.querySelectorAll('.tag-option').forEach(r => r.style.display = '');
      _areaSearchInput.focus();
    }
  });
  document.addEventListener('click', (e) => {
    if (!areaDropdownWrap.contains(e.target)) areaDropdownPanel.style.display = 'none';
  });

  tagDropdownBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = tagDropdownPanel.style.display === 'block';
    tagDropdownPanel.style.display = open ? 'none' : 'block';
    if (!open && _tagSearchInput) {
      _tagSearchInput.value = '';
      tagDropdownPanel.querySelectorAll('.tag-option, .tag-group-header').forEach(r => r.style.display = '');
      _tagSearchInput.focus();
    }
  });
  document.addEventListener('click', (e) => {
    if (!tagDropdownWrap.contains(e.target)) tagDropdownPanel.style.display = 'none';
  });
}

let redvelvetDropdownsReady = false;

async function initRedvelvetDropdowns() {
  initDropdownButtons();
  if (redvelvetDropdownsReady) return;
  redvelvetDropdownsReady = true;
  const relayBase = IMAGE_RELAY_BASE_URL.replace(/\/$/, '');

  try {
    const res = await fetch(`${relayBase}/redvelvet-areas?cityBucket=2`);
    if (res.ok) {
      const data = await res.json();
      areaDropdownPanel.innerHTML = '';
      _areaSearchInput = addPanelSearch(areaDropdownPanel, 'Search areas…');
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

  try {
    const res = await fetch(`${relayBase}/redvelvet-tags?`);
    if (res.ok) {
      const data = await res.json();
      tagDropdownPanel.innerHTML = '';
      _tagSearchInput = addPanelSearch(tagDropdownPanel, 'Search tags…');

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

function showEsaDropdowns() {
  if (areaDropdownWrap) areaDropdownWrap.style.display = '';
  if (tagDropdownWrap) tagDropdownWrap.style.display = 'none';
  if (redvelvetDetailFilters) redvelvetDetailFilters.style.display = 'none';
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

let esaDropdownsReady = false;

async function initEsaDropdowns() {
  initDropdownButtons();
  if (esaDropdownsReady) return;
  const relayBase = IMAGE_RELAY_BASE_URL.replace(/\/$/, '');

  try {
    const res = await fetch(`${relayBase}/esa-areas`);
    if (!res.ok) return;
    const data = await res.json();
    if (!data.areas?.length) return;

    areaDropdownPanel.innerHTML = '';
    _areaSearchInput = addPanelSearch(areaDropdownPanel, 'Search areas…');
    data.areas.forEach(area => {
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
      row.addEventListener('click', () => { clearTimeout(clickTimer); clickTimer = setTimeout(() => { toggleRedvelvetArea(area); runEsaSearch(); }, 220); });
      row.addEventListener('dblclick', () => { clearTimeout(clickTimer); excludeRedvelvetArea(area); runEsaSearch(); });
      areaDropdownPanel.appendChild(row);
    });
    esaDropdownsReady = true;
  } catch { /* silent */ }
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
  } else {
    showEsaDropdowns();
    initEsaDropdowns().then(async () => {
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
      showEsaDropdowns();
      initEsaDropdowns().then(async () => {
        const didFilter = await restoreFilters();
        if (!didFilter) restoreLastSearch();
      });
    }
  });
}

initFavorites({
  getActiveProvider: () => activeProvider,
  saveSelectedProvider,
  persistLastSearch,
  siteSelect: dom.siteSelect,
  onLoadProfile: (provider, favorite) => {
    fetchImagesFromProfile(favorite);
  },
});

(async () => {
  await Promise.all([loadFavorites(), initGroups()]);
  renderFavoritesPanel();
  if (activeProvider !== 'redvelvet') restoreLastSearch();
})();
