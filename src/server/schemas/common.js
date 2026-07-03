'use strict';

const Provider = { type: 'string', enum: ['esa', 'redvelvet'] };

const Uid = { type: 'string', minLength: 1 };

const Timestamp = { type: 'number', description: 'Unix epoch in milliseconds' };

const Url = { type: 'string', format: 'uri' };

const ProfilesWithSameNumber = {
  type: 'array',
  items: {
    type: 'object',
    required: ['uid', 'provider'],
    properties: {
      uid: Uid,
      provider: Provider,
    },
  },
};

const OkResponse = {
  type: 'object',
  required: ['ok'],
  properties: {
    ok: { type: 'boolean', const: true },
  },
};

const ErrorResponse = {
  type: 'object',
  required: ['error'],
  properties: {
    error: { type: 'string' },
  },
};

module.exports = { Provider, Uid, Timestamp, Url, ProfilesWithSameNumber, OkResponse, ErrorResponse };
