'use strict';

const { Url, ErrorResponse } = require('./common');
const { ProfileCardWithSameNumber, ProfileDetailResponse } = require('./profiles');

// ---------------------------------------------------------------------------
// Internal cache structures
// ---------------------------------------------------------------------------

const EsaAreaHashEntry = {
  type: 'object',
  required: ['name', 'url'],
  properties: {
    name: { type: 'string', description: 'Original (non-normalized) area name' },
    url: Url,
  },
};

const EsaDetailCacheEntry = {
  type: 'object',
  required: ['data', 'fetchedAt'],
  properties: {
    data: ProfileDetailResponse,
    fetchedAt: { type: 'number' },
  },
};

// ---------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------

const EsaSearchRequest = {
  type: 'object',
  required: ['areas'],
  properties: {
    areas: {
      type: 'object',
      required: ['included', 'excluded'],
      properties: {
        included: { type: 'array', items: { type: 'string' } },
        excluded: { type: 'array', items: { type: 'string' } },
      },
    },
    nickname: { type: 'string' },
  },
};

// ---------------------------------------------------------------------------
// Response bodies
// ---------------------------------------------------------------------------

const EsaAreasResponse = {
  type: 'object',
  required: ['count', 'areas'],
  properties: {
    count: { type: 'integer', minimum: 0 },
    areas: { type: 'array', items: { type: 'string' } },
  },
};

const EsaProfileListResponse = {
  type: 'object',
  required: ['count', 'profiles'],
  properties: {
    count: { type: 'integer', minimum: 0 },
    profiles: { type: 'array', items: ProfileCardWithSameNumber },
  },
};

const EsaProfileDetailResponse = ProfileDetailResponse;

module.exports = {
  EsaAreaHashEntry,
  EsaDetailCacheEntry,
  EsaSearchRequest,
  EsaAreasResponse,
  EsaProfileListResponse,
  EsaProfileDetailResponse,
  ErrorResponse,
};
