'use strict';

const { Url, ErrorResponse } = require('./common');
const { ProfileCardWithSameNumber, ProfileDetailResponse } = require('./profiles');

// ---------------------------------------------------------------------------
// Internal structures
// ---------------------------------------------------------------------------

const RedvelvetAreaHashEntry = {
  type: 'object',
  required: ['name', 'areaId', 'cityBucket', 'url'],
  properties: {
    name: { type: 'string', description: 'Normalized area name (lowercase)' },
    areaId: { type: 'string' },
    cityBucket: { type: 'string' },
    url: Url,
  },
};

const RedvelvetTagHashEntry = {
  type: 'object',
  required: ['label', 'url'],
  properties: {
    label: { type: 'string' },
    url: Url,
    count: { type: 'integer', minimum: 0 },
  },
};

const RedvelvetProfileMeta = {
  type: 'object',
  required: ['uid', 'name', 'area', 'areaUrl', 'thumbUrl', 'profileUrl'],
  properties: {
    uid: { type: 'string' },
    name: { type: 'string' },
    area: { type: 'string' },
    areaUrl: Url,
    thumbUrl: Url,
    profileUrl: Url,
    phone: { type: 'string' },
    age: { type: 'string' },
    bust: { type: 'string', description: 'Bust size string e.g. "75D"' },
    tags: { type: 'array', items: { type: 'string' } },
    _parsed: {
      type: 'object',
      description: 'Internal cache of parsed page data; never exposed in API responses',
      required: ['images', 'videoPageUrl', 'rawPageUrl'],
      properties: {
        images: { type: 'array', items: Url },
        videoPageUrl: { type: 'string' },
        rawPageUrl: { type: 'string' },
      },
    },
  },
};

const BustParsed = {
  type: 'object',
  required: ['band', 'cup'],
  properties: {
    band: { type: 'integer' },
    cup: { type: 'string' },
  },
};

const RedvelvetMetaCacheEntry = {
  type: 'object',
  required: ['data', 'fetchedAt'],
  properties: {
    data: RedvelvetProfileMeta,
    fetchedAt: { type: 'number' },
  },
};

const RedvelvetDetailCacheEntry = {
  type: 'object',
  required: ['data', 'fetchedAt'],
  properties: {
    data: ProfileDetailResponse,
    fetchedAt: { type: 'number' },
  },
};

const RedvelvetAreaProfileCacheEntry = {
  type: 'object',
  required: ['profiles', 'areaUrl', 'fetchedAt'],
  properties: {
    profiles: { type: 'array', items: ProfileCardWithSameNumber },
    areaUrl: Url,
    fetchedAt: { type: 'number' },
  },
};

const RedvelvetTagProfileCacheEntry = {
  type: 'object',
  required: ['profiles', 'fetchedAt'],
  properties: {
    profiles: { type: 'array', items: ProfileCardWithSameNumber },
    fetchedAt: { type: 'number' },
  },
};

// ---------------------------------------------------------------------------
// Request filter shapes
// ---------------------------------------------------------------------------

const AgeFilter = {
  type: 'object',
  properties: {
    min: { type: 'integer', minimum: 0 },
    max: { type: 'integer', minimum: 0 },
  },
};

const BustFilter = {
  type: 'object',
  properties: {
    band: { type: 'integer' },
    cup: { type: 'string' },
    range: {
      type: 'object',
      required: ['min', 'max'],
      properties: {
        min: { type: 'number' },
        max: { type: 'number' },
      },
    },
  },
};

const AreaFilter = {
  type: 'object',
  required: ['included', 'excluded'],
  properties: {
    included: { type: 'array', items: { type: 'string' } },
    excluded: { type: 'array', items: { type: 'string' } },
  },
};

const TagFilter = {
  type: 'object',
  required: ['included', 'excluded'],
  properties: {
    included: { type: 'array', items: { type: 'string' } },
    excluded: { type: 'array', items: { type: 'string' } },
  },
};

const RedvelvetSearchRequest = {
  type: 'object',
  required: ['cityBucket', 'areas', 'tags'],
  properties: {
    cityBucket: { type: 'string' },
    areas: AreaFilter,
    tags: TagFilter,
    age: AgeFilter,
    bust: BustFilter,
  },
};

// ---------------------------------------------------------------------------
// Response bodies
// ---------------------------------------------------------------------------

const RedvelvetAreasResponse = {
  type: 'object',
  required: ['cityBucket', 'count', 'areas'],
  properties: {
    cityBucket: { type: 'string' },
    count: { type: 'integer', minimum: 0 },
    areas: { type: 'array', items: { type: 'string' } },
  },
};

const RedvelvetAreaLookupResponse = {
  type: 'object',
  required: ['url', 'area', 'areaId', 'cityBucket'],
  properties: {
    url: { type: 'string', description: 'Empty string when not found' },
    area: { type: 'string' },
    areaId: { type: 'string' },
    cityBucket: { type: 'string' },
  },
};

const RedvelvetAreaProfilesResponse = {
  type: 'object',
  required: ['area', 'areaUrl', 'count', 'profiles'],
  properties: {
    area: { type: 'string' },
    areaUrl: Url,
    count: { type: 'integer', minimum: 0 },
    profiles: { type: 'array', items: ProfileCardWithSameNumber },
  },
};

const RedvelvetTagsResponse = {
  type: 'object',
  required: ['count', 'tags'],
  properties: {
    count: { type: 'integer', minimum: 0 },
    tags: {
      type: 'array',
      items: {
        type: 'object',
        required: ['label', 'url'],
        properties: {
          label: { type: 'string' },
          url: Url,
          count: { type: 'integer', minimum: 0 },
        },
      },
    },
  },
};

const RedvelvetTagProfilesResponse = {
  type: 'object',
  required: ['tag', 'tagUrl', 'cityBucket', 'beforeCount', 'count', 'profiles'],
  properties: {
    tag: { type: 'string' },
    tagUrl: Url,
    cityBucket: { type: 'string' },
    beforeCount: { type: 'integer', minimum: 0 },
    count: { type: 'integer', minimum: 0 },
    profiles: { type: 'array', items: ProfileCardWithSameNumber },
  },
};

const RedvelvetProfileDetailResponse = ProfileDetailResponse;

const RedvelvetNicknameSearchResponse = {
  type: 'object',
  required: ['count', 'profiles'],
  properties: {
    count: { type: 'integer', minimum: 0 },
    profiles: { type: 'array', items: ProfileCardWithSameNumber },
  },
};

const RedvelvetSearchResponse = {
  type: 'object',
  required: ['count', 'profiles'],
  properties: {
    count: { type: 'integer', minimum: 0 },
    profiles: { type: 'array', items: ProfileCardWithSameNumber },
  },
};

module.exports = {
  RedvelvetAreaHashEntry,
  RedvelvetTagHashEntry,
  RedvelvetProfileMeta,
  BustParsed,
  RedvelvetMetaCacheEntry,
  RedvelvetDetailCacheEntry,
  RedvelvetAreaProfileCacheEntry,
  RedvelvetTagProfileCacheEntry,
  AgeFilter,
  BustFilter,
  AreaFilter,
  TagFilter,
  RedvelvetSearchRequest,
  RedvelvetAreasResponse,
  RedvelvetAreaLookupResponse,
  RedvelvetAreaProfilesResponse,
  RedvelvetTagsResponse,
  RedvelvetTagProfilesResponse,
  RedvelvetProfileDetailResponse,
  RedvelvetNicknameSearchResponse,
  RedvelvetSearchResponse,
  ErrorResponse,
};
