'use strict';

const { Provider, Uid, Url, Timestamp, OkResponse, ErrorResponse } = require('./common');

const ProfileGroupMember = {
  type: 'object',
  required: ['provider', 'uid', 'name', 'area', 'thumbUrl', 'profileUrl'],
  properties: {
    provider: Provider,
    uid: Uid,
    name: { type: 'string' },
    area: { type: 'string' },
    thumbUrl: Url,
    profileUrl: Url,
    phone: { type: 'string' },
  },
};

const PairLinkType = { type: 'string', enum: ['profile', 'venue', 'unknown'] };

const ProfileGroup = {
  type: 'object',
  required: ['id', 'members', 'createdAt'],
  properties: {
    id: { type: 'string' },
    members: { type: 'array', items: ProfileGroupMember, minItems: 1 },
    createdAt: Timestamp,
    linkType: { type: 'string', enum: ['venue', 'profile'] },
    // pairs: keys are "provider:uid|provider:uid", values are PairLinkType strings.
    pairs: { type: 'object' },
  },
};

const ProfileGroupsFile = { type: 'array', items: ProfileGroup };

const GetProfileGroupsResponse = ProfileGroupsFile;
const PostProfileGroupsRequest = ProfileGroupsFile;
const PostProfileGroupsResponse = OkResponse;

module.exports = {
  ProfileGroupMember,
  PairLinkType,
  ProfileGroup,
  ProfileGroupsFile,
  GetProfileGroupsResponse,
  PostProfileGroupsRequest,
  PostProfileGroupsResponse,
  ErrorResponse,
};
