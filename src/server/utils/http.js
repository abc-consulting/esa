'use strict';

const { REQUEST_TIMEOUT_MS, ALLOWED_IMAGE_HOSTS } = require('../constants');

async function fetchText(url, headers = {}, timeout = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0',
        ...headers,
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Access-Control-Allow-Origin': '*',
    ...headers,
  });
  res.end(body);
}

function isAllowedImageUrl(rawUrl) {
  try {
    const { URL } = require('url');
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    return ALLOWED_IMAGE_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

module.exports = { fetchText, send, isAllowedImageUrl };
