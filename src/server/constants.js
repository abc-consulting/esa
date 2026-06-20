'use strict';

const path = require('path');

const PORT = Number(process.env.PORT || 5510);
const ROOT = path.join(__dirname, '../../');
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15000;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

const ALLOWED_IMAGE_HOSTS = new Set([
  'redvelvet.co.za',
  'www.redvelvet.co.za',
  'esa.co.za',
  'www.esa.co.za',
  'userfiles.esa.co.za',
  'goldmember.esa.co.za',
]);

const REDVELVET_AREAS_URL = 'https://redvelvet.co.za/escorts/escorts_in_area';
const REDVELVET_FETISHES_URL = 'https://redvelvet.co.za/escorts/fetish_escorts';
const AREA_MAP_CACHE_TTL_MS = 60 * 60 * 1000;

module.exports = {
  PORT,
  ROOT,
  MAX_IMAGE_BYTES,
  REQUEST_TIMEOUT_MS,
  MIME_TYPES,
  ALLOWED_IMAGE_HOSTS,
  REDVELVET_AREAS_URL,
  REDVELVET_FETISHES_URL,
  AREA_MAP_CACHE_TTL_MS,
};
