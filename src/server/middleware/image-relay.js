'use strict';

const { MAX_IMAGE_BYTES, REQUEST_TIMEOUT_MS } = require('../constants');
const { send, isAllowedImageUrl } = require('../utils/http');
const { URL } = require('url');

const SIZE_FALLBACKS = ['large', 'medium', 'small', 'thumb_blur'];

function nextSizeUrl(url) {
  const m = url.match(/[?&]size=([^&]+)/i);
  if (!m) return null;
  const current = m[1].toLowerCase();
  const idx = SIZE_FALLBACKS.indexOf(current);
  if (idx < 0 || idx >= SIZE_FALLBACKS.length - 1) return null;
  return url.replace(/size=[^&]+/i, `size=${SIZE_FALLBACKS[idx + 1]}`);
}

async function fetchUpstream(target, userAgent, timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(target, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': userAgent, 'Accept': '*/*' },
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function handleImageRelay(req, res, serverBase) {
  const incoming = new URL(req.url, serverBase);
  const target = incoming.searchParams.get('url') || '';

  if (!target || !isAllowedImageUrl(target)) {
    send(res, 400, 'Invalid image URL');
    return;
  }

  const userAgent = req.headers['user-agent'] || 'Mozilla/5.0';
  let currentUrl = target;
  let upstream;

  // Try the requested URL; if 4xx and URL has size= param, fall back through smaller sizes
  while (true) {
    try {
      upstream = await fetchUpstream(currentUrl, userAgent, REQUEST_TIMEOUT_MS);
    } catch (err) {
      if (!res.headersSent) send(res, 502, `Relay failed: ${err.message}`);
      return;
    }
    if (upstream.ok) break;
    if (upstream.status >= 400 && upstream.status < 500) {
      const fallback = nextSizeUrl(currentUrl);
      if (fallback) { currentUrl = fallback; continue; }
    }
    send(res, upstream.status || 502, `Upstream error: ${upstream.status}`);
    return;
  }

  // upstream is ok at this point
  if (!upstream.body) {
    send(res, 502, 'Upstream returned no body');
    return;
  }

  const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
  const ct = contentType.toLowerCase();
  const isImage = ct.startsWith('image/');
  const isVideo = ct.startsWith('video/') || (ct === 'application/octet-stream' && /\.(mp4|webm|ogg|mov)(\?|$)/i.test(currentUrl));
  if (!isImage && !isVideo) {
    send(res, 415, 'Upstream response is not an image or video');
    return;
  }

  const contentLength = Number(upstream.headers.get('content-length') || 0);
  if (isImage && contentLength > MAX_IMAGE_BYTES) {
    send(res, 413, 'Image too large');
    return;
  }

  const responseHeaders = {
    'Content-Type': contentType,
    'Cache-Control': 'public, max-age=3600',
    'X-Relay-Source': new URL(currentUrl).hostname,
  };
  if (upstream.headers.get('content-length')) {
    responseHeaders['Content-Length'] = upstream.headers.get('content-length');
  }
  if (upstream.headers.get('accept-ranges')) {
    responseHeaders['Accept-Ranges'] = upstream.headers.get('accept-ranges');
  }
  res.writeHead(200, responseHeaders);

  try {
    const reader = upstream.body.getReader();
    let total = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      total += value.byteLength;
      if (isImage && total > MAX_IMAGE_BYTES) {
        res.destroy();
        return;
      }

      res.write(Buffer.from(value));
    }

    res.end();
  } catch (err) {
    if (!res.headersSent) {
      send(res, 502, `Relay failed: ${err.message}`);
    } else {
      res.destroy();
    }
  }
}

module.exports = { handleImageRelay };
