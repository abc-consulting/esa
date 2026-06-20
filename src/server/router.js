'use strict';

const http = require('http');
const { PORT } = require('./constants');
const { send } = require('./utils/http');
const { handleStatic } = require('./middleware/static');
const { handleImageRelay } = require('./middleware/image-relay');
const {
  handleRedvelvetAreaLookup,
  handleRedvelvetAreaProfiles,
  handleRedvelvetAreas,
  buildRedvelvetAreaHashMap,
} = require('./redvelvet/areas');
const { handleRedvelvetTags, buildRedvelvetTagHashMap } = require('./redvelvet/tags');
const { handleRedvelvetProfileLookup, handleRedvelvetTagProfiles } = require('./redvelvet/profiles');

const server = http.createServer(async (req, res) => {
  const serverBase = `http://${req.headers.host || `localhost:${PORT}`}`;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  if (req.url && req.url.startsWith('/image?')) {
    await handleImageRelay(req, res, serverBase);
    return;
  }

  if (req.url && req.url.startsWith('/redvelvet-area?')) {
    await handleRedvelvetAreaLookup(req, res, serverBase);
    return;
  }

  if (req.url && req.url.startsWith('/redvelvet-profile?')) {
    await handleRedvelvetProfileLookup(req, res, serverBase);
    return;
  }

  if (req.url && req.url.startsWith('/redvelvet-area-profiles?')) {
    await handleRedvelvetAreaProfiles(req, res, serverBase);
    return;
  }

  if (req.url && req.url.startsWith('/redvelvet-areas?')) {
    await handleRedvelvetAreas(req, res, serverBase);
    return;
  }

  if (req.url && req.url.startsWith('/redvelvet-tags?')) {
    await handleRedvelvetTags(req, res);
    return;
  }

  if (req.url && req.url.startsWith('/redvelvet-tag-profiles?')) {
    await handleRedvelvetTagProfiles(req, res, serverBase);
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, 'Method not allowed');
    return;
  }

  handleStatic(req, res, serverBase);
});

server.listen(PORT, () => {
  console.log(`ESA app server running at http://localhost:${PORT}`);
  buildRedvelvetAreaHashMap().catch(err => console.error('Area hashmap warmup failed:', err));
  buildRedvelvetTagHashMap().catch(err => console.error('Tag hashmap warmup failed:', err));
});
