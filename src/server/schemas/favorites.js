'use strict';

const { Provider, Uid, Url, Timestamp, OkResponse, ErrorResponse } = require('./common');

const FavoriteProfile = {
  type: 'object',
  required: ['provider', 'uid', 'name', 'area', 'thumbUrl', 'profileUrl', 'savedAt'],
  properties: {
    provider: Provider,
    uid: Uid,
    name: { type: 'string' },
    area: { type: 'string' },
    thumbUrl: Url,
    profileUrl: Url,
    savedAt: Timestamp,
  },
};

// Shape of data/favorites.json — top-level keys are provider names.
const FavoritesFile = {
  type: 'object',
  properties: {
    esa: { type: 'array', items: FavoriteProfile },
    redvelvet: { type: 'array', items: FavoriteProfile },
  },
};

const GetFavoritesResponse = FavoritesFile;
const PostFavoritesRequest = FavoritesFile;
const PostFavoritesResponse = OkResponse;

module.exports = {
  FavoriteProfile,
  FavoritesFile,
  GetFavoritesResponse,
  PostFavoritesRequest,
  PostFavoritesResponse,
  ErrorResponse,
};
