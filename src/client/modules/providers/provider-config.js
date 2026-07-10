import { IMAGE_RELAY_BASE_URL } from '../config.js';

// Central registry of everything that differs between providers.
// All provider-specific branching in rendering/fetching should go through
// this object so the rendering functions stay provider-agnostic.

export const PROVIDER_CONFIG = {
  esa: {
    label: 'ESA',
    fallbackThumb: '',
    detailUrl: (uid, scrapeMode = false) => `${IMAGE_RELAY_BASE_URL.replace(/\/$/, '')}/esa-profile-details?id=${encodeURIComponent(uid)}${scrapeMode ? '&scrape=true' : ''}`,
    nicknameSearchUrl: (nickname, scrapeMode = false) => `${IMAGE_RELAY_BASE_URL.replace(/\/$/, '')}/esa-profiles?nickname=${encodeURIComponent(nickname)}${scrapeMode ? '&scrape=true' : ''}`,
    imageRenderDelay: 500,
    hasTags: false,
    hasCityBucket: false,
  },
  redvelvet: {
    label: 'RV',
    fallbackThumb: 'https://redvelvet.co.za/Assets/images/noimage.png',
    detailUrl: (uid, scrapeMode = false) => `${IMAGE_RELAY_BASE_URL.replace(/\/$/, '')}/redvelvet-profile-details?id=${encodeURIComponent(uid)}${scrapeMode ? '&scrape=true' : ''}`,
    nicknameSearchUrl: (nickname, scrapeMode = false) => `${IMAGE_RELAY_BASE_URL.replace(/\/$/, '')}/redvelvet-nickname-search?nickname=${encodeURIComponent(nickname)}&cityBucket=2${scrapeMode ? '&scrape=true' : ''}`,
    imageRenderDelay: 300,
    hasTags: true,
    hasCityBucket: true,
  },
};

/** Returns config for a provider, falling back to ESA if unknown. */
export function getProviderConfig(provider) {
  return PROVIDER_CONFIG[provider] ?? PROVIDER_CONFIG.esa;
}

/** Short display label for a provider: "ESA" or "RV". */
export function providerLabel(provider) {
  return getProviderConfig(provider).label;
}

/**
 * Returns an onAreaClick handler for renderProfileDetails.
 * Each provider routes area clicks to its own search function.
 * fetchAreaFns must be { redvelvet: fn(area), esa: fn(area) }.
 */
export function makeOnAreaClick(provider, fetchAreaFns) {
  return (profile) => fetchAreaFns[provider]?.(profile.area);
}
