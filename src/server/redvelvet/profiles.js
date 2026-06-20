'use strict';

const { send } = require('../utils/http');
const { extractHiddenFields, extractDataPagerTargets } = require('../utils/html');
const { parseRedvelvetAreaProfiles, getAreaSetForCityBucket, filterProfilesByCityBucket } = require('./areas');
const { resolveRedvelvetFetishUrl } = require('./fetishes');
const { URL } = require('url');

async function fetchRedvelvetProfilesWithPostback(startUrl) {
  const byUid = new Map();
  const seenTargets = new Set();
  const queue = [];

  const pushProfilesFromHtml = (html) => {
    parseRedvelvetAreaProfiles(html).forEach((profile) => {
      const key = String(profile.uid || '').trim();
      if (!key || byUid.has(key)) return;
      byUid.set(key, profile);
    });
  };

  const enqueueTargets = (html) => {
    extractDataPagerTargets(html).forEach((target) => {
      if (seenTargets.has(target)) return;
      seenTargets.add(target);
      queue.push({ target, html });
    });
  };

  const firstHtml = await fetch(startUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  }).then((r) => r.text());
  pushProfilesFromHtml(firstHtml);
  enqueueTargets(firstHtml);

  const MAX_POSTBACK_PAGES = 25;
  let traversed = 0;

  while (queue.length > 0 && traversed < MAX_POSTBACK_PAGES) {
    const next = queue.shift();
    if (!next?.target || !next?.html) continue;

    traversed += 1;
    const fields = extractHiddenFields(next.html);
    const body = new URLSearchParams(fields);
    body.set('__EVENTTARGET', next.target);
    body.set('__EVENTARGUMENT', '');

    let response;
    try {
      response = await fetch(startUrl, {
        method: 'POST',
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      });
    } catch {
      continue;
    }

    if (!response.ok) continue;
    const html = await response.text();
    if (!html) continue;

    pushProfilesFromHtml(html);
    enqueueTargets(html);
  }

  return Array.from(byUid.values());
}

async function handleRedvelvetProfileLookup(req, res) {
  send(res, 501, JSON.stringify({ error: 'Not implemented' }), {
    'Content-Type': 'application/json; charset=utf-8',
  });
}

async function handleRedvelvetTagProfiles(req, res, serverBase) {
  const incoming = new URL(req.url, serverBase);
  const tag = (incoming.searchParams.get('tag') || '').trim();
  const tagUrl = (incoming.searchParams.get('tagUrl') || '').trim();
  const cityBucket = (incoming.searchParams.get('cityBucket') || '2').trim();

  if (!tag && !tagUrl) {
    send(res, 400, JSON.stringify({ error: 'Missing tag or tagUrl' }), {
      'Content-Type': 'application/json; charset=utf-8',
    });
    return;
  }

  try {
    const resolvedTagUrl = await resolveRedvelvetFetishUrl(tag, tagUrl);
    if (!resolvedTagUrl) {
      send(res, 200, JSON.stringify({
        tag,
        tagUrl: '',
        cityBucket,
        beforeCount: 0,
        count: 0,
        profiles: [],
      }), {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=300',
      });
      return;
    }

    const profiles = await fetchRedvelvetProfilesWithPostback(resolvedTagUrl);
    const areaSet = await getAreaSetForCityBucket(cityBucket);
    const filteredProfiles = filterProfilesByCityBucket(profiles, areaSet);

    send(res, 200, JSON.stringify({
      tag,
      tagUrl: resolvedTagUrl,
      cityBucket,
      beforeCount: profiles.length,
      count: filteredProfiles.length,
      profiles: filteredProfiles,
    }), {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    });
  } catch (err) {
    send(res, 502, JSON.stringify({ error: err.message }), {
      'Content-Type': 'application/json; charset=utf-8',
    });
  }
}

module.exports = {
  fetchRedvelvetProfilesWithPostback,
  handleRedvelvetProfileLookup,
  handleRedvelvetTagProfiles,
};
