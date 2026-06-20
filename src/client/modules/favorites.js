import { STORAGE_KEYS } from './config.js';
import { dom } from './dom.js';
import { parseJsonStorage, writeJsonStorage } from './storage.js';
import { getProfileUrlByProvider, extractUidFromUrl } from './url-utils.js';

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

export function loadFavorites() {
  const stored = parseJsonStorage(STORAGE_KEYS.favorites, null);
  let list = [];

  // Backward compatibility: old storage format was a plain array.
  if (Array.isArray(stored)) {
    list = stored;
  } else if (stored && typeof stored === 'object') {
    list = Object.values(stored)
      .flatMap(value => Array.isArray(value) ? value : [])
      .filter(Boolean);
  }

  favorites = Array.isArray(list)
    ? list
      .filter(f => f?.uid)
      .map(f => ({ ...f, provider: f.provider || 'esa' }))
      .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0))
    : [];
}

export function saveFavorites() {
  const grouped = favorites.reduce((acc, favorite) => {
    const provider = favorite.provider || 'esa';
    if (!acc[provider]) acc[provider] = [];
    acc[provider].push(favorite);
    return acc;
  }, {});

  writeJsonStorage(STORAGE_KEYS.favorites, grouped);
}

export function isFavorite(uid) {
  const activeProvider = _cb.getActiveProvider();
  return favorites.some(f => f.uid === uid && (f.provider || 'esa') === activeProvider);
}

export function toggleFavorite(profile) {
  const uid = profile?.uid || extractUidFromUrl(profile?.profileUrl);
  if (!uid) return;
  const activeProvider = _cb.getActiveProvider();
  const provider = profile?.provider || activeProvider;

  if (isFavorite(uid)) {
    favorites = favorites.filter(f => !(f.uid === uid && (f.provider || 'esa') === provider));
  } else {
    favorites.unshift({
      provider,
      uid,
      name: profile.name || `UID ${uid}`,
      area: profile.area || '',
      thumbUrl: profile.thumbUrl || '',
      profileUrl: profile.profileUrl || getProfileUrlByProvider(provider, uid),
      savedAt: Date.now(),
    });
  }

  saveFavorites();
  renderFavoritesPanel();

  const btn = document.getElementById('favorite-toggle-btn');
  if (btn) btn.textContent = isFavorite(uid) ? 'Remove Favorite' : 'Add To Favorites';
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

  favorites.forEach(favorite => {
    const row = document.createElement('div');
    const provider = favorite.provider || 'esa';
    row.className = `favorite-item favorite-item--${provider}`;

    const openBtn = document.createElement('button');
    openBtn.className = 'favorite-link';
    openBtn.title = `Load profile ${favorite.uid}`;
    openBtn.addEventListener('click', () => {
      const activeProvider = _cb.getActiveProvider();
      if ((favorite.provider || 'esa') !== activeProvider) {
        if (_cb.siteSelect) _cb.siteSelect.value = favorite.provider || 'esa';
        _cb.saveSelectedProvider(favorite.provider || 'esa');
        loadFavorites();
        renderFavoritesPanel();
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
        if (btn) btn.textContent = 'Add To Favorites';
      }
    });

    row.append(openBtn, removeBtn);
    list.appendChild(row);
  });

  container.innerHTML = '';
  container.appendChild(list);
}
