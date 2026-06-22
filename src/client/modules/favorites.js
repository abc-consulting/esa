import { IMAGE_RELAY_BASE_URL, STORAGE_KEYS } from './config.js';
import { dom } from './dom.js';
import { parseJsonStorage, writeJsonStorage } from './storage.js';
import { getProfileUrlByProvider, extractUidFromUrl } from './url-utils.js';
import { findGroupForProfile } from './profile-groups.js';

let favorites = [];

// Injected by app.js at startup to avoid circular imports.
let _cb = {
  getActiveProvider: () => 'esa',
  saveSelectedProvider: () => {},
  persistLastSearch: () => {},
  onLoadProfile: () => {},
  siteSelect: null,
};

export function initFavorites(callbacks) {
  _cb = { ..._cb, ...callbacks };
}

function relayBase() {
  return IMAGE_RELAY_BASE_URL.replace(/\/$/, '');
}

function fromLocalStorage() {
  const stored = parseJsonStorage(STORAGE_KEYS.favorites, null);
  let list = [];
  if (Array.isArray(stored)) {
    list = stored;
  } else if (stored && typeof stored === 'object') {
    list = Object.values(stored).flatMap(v => Array.isArray(v) ? v : []).filter(Boolean);
  }
  return Array.isArray(list)
    ? list.filter(f => f?.uid).map(f => ({ ...f, provider: f.provider || 'esa' }))
    : [];
}

function toLocalStorage() {
  const grouped = favorites.reduce((acc, f) => {
    const p = f.provider || 'esa';
    if (!acc[p]) acc[p] = [];
    acc[p].push(f);
    return acc;
  }, {});
  writeJsonStorage(STORAGE_KEYS.favorites, grouped);
}

async function pushToServer() {
  const grouped = favorites.reduce((acc, f) => {
    const p = f.provider || 'esa';
    if (!acc[p]) acc[p] = [];
    acc[p].push(f);
    return acc;
  }, {});
  try {
    await fetch(`${relayBase()}/favorites`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(grouped),
    });
  } catch { /* best-effort */ }
}

export async function loadFavorites() {
  // Try server first; fall back to localStorage.
  try {
    const res = await fetch(`${relayBase()}/favorites`);
    if (res.ok) {
      const stored = await res.json();
      let list = [];
      if (Array.isArray(stored)) {
        list = stored;
      } else if (stored && typeof stored === 'object') {
        list = Object.values(stored).flatMap(v => Array.isArray(v) ? v : []).filter(Boolean);
      }
      favorites = list.filter(f => f?.uid).map(f => ({ ...f, provider: f.provider || 'esa' }))
        .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
      toLocalStorage();
      return;
    }
  } catch { /* fall through */ }
  favorites = fromLocalStorage().sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
}

export function saveFavorites() {
  toLocalStorage();
  pushToServer();
}

export function isFavorite(uid) {
  const activeProvider = _cb.getActiveProvider();
  return favorites.some(f => f.uid === uid && (f.provider || 'esa') === activeProvider);
}

function isFavoriteExact(provider, uid) {
  return favorites.some(f => f.uid === String(uid) && (f.provider || 'esa') === provider);
}

export function toggleFavorite(profile) {
  const uid = profile?.uid || extractUidFromUrl(profile?.profileUrl);
  if (!uid) return;
  const provider = profile?.provider || _cb.getActiveProvider();

  const adding = !isFavoriteExact(provider, uid);

  // Collect all profiles to toggle: this profile + any group members
  const group = findGroupForProfile(provider, uid);
  const targets = group
    ? group.members.map(m => ({ provider: m.provider, uid: m.uid, name: m.name, area: m.area, thumbUrl: m.thumbUrl, profileUrl: m.profileUrl }))
    : [profile];

  if (adding) {
    targets.forEach(p => {
      if (!isFavoriteExact(p.provider, p.uid)) {
        favorites.unshift({
          provider: p.provider,
          uid: String(p.uid),
          name: p.name || `UID ${p.uid}`,
          area: p.area || '',
          thumbUrl: p.thumbUrl || '',
          profileUrl: p.profileUrl || getProfileUrlByProvider(p.provider, p.uid),
          savedAt: Date.now(),
        });
      }
    });
  } else {
    targets.forEach(p => {
      favorites = favorites.filter(f => !(f.uid === String(p.uid) && (f.provider || 'esa') === p.provider));
    });
  }

  saveFavorites();
  renderFavoritesPanel();

  const btn = document.getElementById('favorite-toggle-btn');
  if (btn) {
    const faved = isFavoriteExact(provider, uid);
    btn.textContent = faved ? '★' : '☆';
    btn.title = faved ? 'Remove from favorites' : 'Add to favorites';
  }
}

export function renderFavoritesPanel() {
  const container = dom.favoritesContainer;
  if (!container) return;

  if (favorites.length === 0) {
    container.innerHTML = '<div class="favorites-empty">No favorites yet.</div>';
    return;
  }

  const list = document.createElement('div');
  list.className = 'favorites-list';

  // Track which uids have been rendered so grouped members are shown once.
  const rendered = new Set();

  favorites.forEach(favorite => {
    const favKey = `${favorite.provider}:${favorite.uid}`;
    if (rendered.has(favKey)) return;

    // Check if this favorite belongs to a group and all members are also favorited.
    const group = findGroupForProfile(favorite.provider, favorite.uid);
    const groupedMembers = group
      ? group.members.filter(m => isFavoriteExact(m.provider, m.uid))
      : [];
    const isGrouped = groupedMembers.length > 1;

    if (isGrouped) {
      groupedMembers.forEach(m => rendered.add(`${m.provider}:${m.uid}`));
      renderGroupedFavoriteRow(list, groupedMembers, group);
    } else {
      rendered.add(favKey);
      renderSingleFavoriteRow(list, favorite);
    }
  });

  container.innerHTML = '';
  container.appendChild(list);
}

function renderSingleFavoriteRow(list, favorite) {
  const row = document.createElement('div');
  const provider = favorite.provider || 'esa';
  row.className = `favorite-item favorite-item--${provider}`;

  const openBtn = buildFavoriteOpenBtn(favorite, provider);
  const removeBtn = buildRemoveBtn(favorite);

  row.append(openBtn, removeBtn);
  list.appendChild(row);
}

function renderGroupedFavoriteRow(list, members, group) {
  const row = document.createElement('div');
  row.className = 'favorite-item favorite-item--grouped';

  // Show the first member's avatar + all names as tabs inside a single row.
  const openBtn = document.createElement('button');
  openBtn.className = 'favorite-link';
  openBtn.title = 'Load linked profiles';

  const avatar = document.createElement('img');
  avatar.className = 'favorite-avatar';
  avatar.alt = members[0].name || 'Profile';
  avatar.src = members[0].thumbUrl || '';
  avatar.onerror = function () { this.style.display = 'none'; };

  const labelWrap = document.createElement('span');
  labelWrap.className = 'favorite-label';

  const linkBadge = document.createElement('span');
  linkBadge.className = 'favorite-link-badge';
  linkBadge.textContent = '🔗 ';

  const names = document.createElement('span');
  names.textContent = members
    .map(m => `${m.name || m.uid} (${m.provider === 'redvelvet' ? 'RV' : 'ESA'})`)
    .join(' · ');

  labelWrap.append(linkBadge, names);
  openBtn.append(avatar, labelWrap);

  openBtn.addEventListener('click', () => {
    // Open via the first member — fetchImagesFromProfile will detect the group.
    const first = members[0];
    _cb.onLoadProfile(first.provider, first);
  });

  const removeBtn = document.createElement('button');
  removeBtn.className = 'favorite-remove-x';
  removeBtn.textContent = '×';
  removeBtn.title = 'Remove all linked favorites';
  removeBtn.addEventListener('click', () => {
    members.forEach(m => {
      favorites = favorites.filter(f => !(f.uid === String(m.uid) && (f.provider || 'esa') === m.provider));
    });
    saveFavorites();
    renderFavoritesPanel();
  });

  row.append(openBtn, removeBtn);
  list.appendChild(row);
}

function buildFavoriteOpenBtn(favorite, provider) {
  const openBtn = document.createElement('button');
  openBtn.className = 'favorite-link';
  openBtn.title = `Load profile ${favorite.uid}`;
  openBtn.addEventListener('click', () => {
    const activeProvider = _cb.getActiveProvider();
    if ((favorite.provider || 'esa') !== activeProvider) {
      if (_cb.siteSelect) _cb.siteSelect.value = favorite.provider || 'esa';
      _cb.saveSelectedProvider(favorite.provider || 'esa');
      loadFavorites().then(() => renderFavoritesPanel());
    }
    dom.searchInput.value = favorite.uid;
    _cb.persistLastSearch('uid', favorite.uid);
    _cb.onLoadProfile(provider, favorite);
  });

  const avatar = document.createElement('img');
  avatar.className = 'favorite-avatar';
  avatar.alt = `${favorite.name || 'Profile'} thumbnail`;
  avatar.src = favorite.thumbUrl || '';
  avatar.onerror = function () { this.style.display = 'none'; };

  const label = document.createElement('span');
  label.className = 'favorite-label';
  label.textContent = favorite.area
    ? `${favorite.name || 'Profile'} (${favorite.area})`
    : `${favorite.name || 'Profile'} (${favorite.uid})`;

  openBtn.append(avatar, label);
  return openBtn;
}

function buildRemoveBtn(favorite) {
  const removeBtn = document.createElement('button');
  removeBtn.className = 'favorite-remove-x';
  removeBtn.textContent = '×';
  removeBtn.title = `Remove ${favorite.name || favorite.uid}`;
  removeBtn.addEventListener('click', () => {
    const activeProvider = _cb.getActiveProvider();
    favorites = favorites.filter(
      f => !(f.uid === favorite.uid && (f.provider || 'esa') === (favorite.provider || 'esa')),
    );
    saveFavorites();
    renderFavoritesPanel();
    const activeUid = extractUidFromUrl(document.querySelector('.profile-details-name')?.href || '');
    if (activeUid && activeUid === favorite.uid && (favorite.provider || 'esa') === activeProvider) {
      const btn = document.getElementById('favorite-toggle-btn');
      if (btn) { btn.textContent = '☆'; btn.title = 'Add to favorites'; }
    }
  });
  return removeBtn;
}
