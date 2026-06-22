export const BASE_URL = 'https://www.esa.co.za';
export const REDVELVET_BASE_URL = 'https://redvelvet.co.za';
export const PROXY = 'https://corsproxy.io/?';
export const IMAGE_RELAY_BASE_URL = document
  .querySelector('meta[name="esa-image-relay-base-url"]')
  ?.getAttribute('content')
  ?.trim() || '';

export const STORAGE_KEYS = {
  favorites: 'esa.favorites.v2',
  lastSearch: 'esa.lastSearch.v2',
  provider: 'esa.provider.v1',
  rvFilters: 'esa.rvFilters.v1',
};
