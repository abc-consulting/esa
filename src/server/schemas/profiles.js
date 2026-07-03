'use strict';

const { Provider, Uid, Url, ProfilesWithSameNumber } = require('./common');

const ProfileCard = {
  type: 'object',
  required: ['provider', 'uid', 'name', 'area', 'profileUrl', 'thumbUrl'],
  properties: {
    provider: Provider,
    uid: Uid,
    name: { type: 'string' },
    area: { type: 'string' },
    profileUrl: Url,
    thumbUrl: Url,
    phone: { type: 'string' },
  },
};

const ProfileCardWithSameNumber = {
  type: 'object',
  required: [...ProfileCard.required, 'profiles_with_same_number'],
  properties: {
    ...ProfileCard.properties,
    profiles_with_same_number: ProfilesWithSameNumber,
  },
};

const ProfileDetail = {
  type: 'object',
  required: ['provider', 'uid', 'name', 'area', 'profileUrl', 'thumbUrl'],
  properties: {
    provider: Provider,
    uid: Uid,
    name: { type: 'string' },
    area: { type: 'string' },
    areaUrl: Url,
    profileUrl: Url,
    thumbUrl: Url,
    phone: { type: 'string' },
    age: { type: 'string' },
    bust: { type: 'string', description: 'Bust size string e.g. "75D"' },
    tags: { type: 'array', items: { type: 'string' } },
  },
};

const ProfileDetailResponse = {
  type: 'object',
  required: ['profile', 'images', 'videos'],
  properties: {
    profile: ProfileDetail,
    images: { type: 'array', items: Url },
    videos: { type: 'array', items: Url },
  },
};

module.exports = { ProfileCard, ProfileCardWithSameNumber, ProfileDetail, ProfileDetailResponse };
