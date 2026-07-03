import { IMAGE_RELAY_BASE_URL } from '../config.js';

// Central registry of everything that differs between providers.
// All provider-specific branching in rendering/fetching should go through
// this object so the rendering functions stay provider-agnostic.

export const PROVIDER_CONFIG = {
  esa: {
    label: 'ESA',
    fallbackThumb: '',
    detailUrl: (uid) => `${IMAGE_RELAY_BASE_URL.replace(/\/$/, '')}/esa-profile-details?id=${encodeURIComponent(uid)}`,
    nicknameSearchUrl: (nickname) => `${IMAGE_RELAY_BASE_URL.replace(/\/$/, '')}/esa-profiles?nickname=${encodeURIComponent(nickname)}`,
    // Delay before rendering images (ms) — ESA is faster to hydrate than RV
    imageRenderDelay: 500,
    // ESA profiles don't have tags
    hasTags: false,
    // ESA doesn't use cityBucket
    hasCityBucket: false,
  },
  redvelvet: {
    label: 'RV',
    fallbackThumb: 'https://redvelvet.co.za/Assets/images/noimage.png',
    detailUrl: (uid) => `${IMAGE_RELAY_BASE_URL.replace(/\/$/, '')}/redvelvet-profile-details?id=${encodeURIComponent(uid)}`,
    nicknameSearchUrl: (nickname) => `${IMAGE_RELAY_BASE_URL.replace(/\/$/, '')}/redvelvet-nickname-search?nickname=${encodeURIComponent(nickname)}&cityBucket=2`,
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
