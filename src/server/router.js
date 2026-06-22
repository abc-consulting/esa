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
const { handleRedvelvetProfileDetails } = require('./redvelvet/profile-details');
const { handleRedvelvetSearch } = require('./redvelvet/search');
const { getSessionCookie } = require('./redvelvet/auth');
const { handleEsaProfilesByNickname, handleEsaProfilesByArea } = require('./esa/profiles');
const { handleEsaProfileDetails } = require('./esa/profile-details');
const { handleEsaAreas, buildEsaAreaHashMap } = require('./esa/areas');
const { handleEsaSearch } = require('./esa/search');

const server = http.createServer(async (req, res) => {
  const serverBase = `http://${req.headers.host || `localhost:${PORT}`}`;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,HEAD,POST,OPTIONS',
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

  if (req.url && req.url.startsWith('/redvelvet-profile-details?')) {
    await handleRedvelvetProfileDetails(req, res, serverBase);
    return;
  }

  if (req.url === '/rv-auth-status') {
    const cookie = await getSessionCookie().catch(() => null);
    send(res, 200, JSON.stringify({ loggedIn: !!cookie, cookie: cookie ? cookie.slice(0, 40) + '…' : null }), { 'Content-Type': 'application/json' });
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

  if (req.url === '/redvelvet-search' && req.method === 'POST') {
    await handleRedvelvetSearch(req, res, serverBase);
    return;
  }

  if (req.url && req.url.startsWith('/esa-profile-details?')) {
    await handleEsaProfileDetails(req, res);
    return;
  }

  if (req.url === '/esa-areas') {
    await handleEsaAreas(req, res);
    return;
  }

  if (req.url && req.url.startsWith('/esa-profiles?')) {
    const urlObj = new URL(req.url, 'http://localhost');
    if (urlObj.searchParams.has('nickname')) {
      await handleEsaProfilesByNickname(req, res);
    } else {
      await handleEsaProfilesByArea(req, res);
    }
    return;
  }

  if (req.url === '/esa-search' && req.method === 'POST') {
    await handleEsaSearch(req, res);
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
  buildEsaAreaHashMap().catch(err => console.error('[ESA] Area hashmap warmup failed:', err));
  if (!process.env.RV_EMAIL || !process.env.RV_PASSWORD) {
    console.warn('[RV Auth] RV_EMAIL / RV_PASSWORD not set — fetching without login');
  } else {
    getSessionCookie()
      .then(cookie => {
        if (cookie) console.log('[RV Auth] Session ready');
        else console.warn('[RV Auth] Login failed — check credentials');
      })
      .catch(err => console.error('[RV Auth] Warmup error:', err.message));
  }
});
