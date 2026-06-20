'use strict';

const { MAX_IMAGE_BYTES, REQUEST_TIMEOUT_MS } = require('../constants');
const { send, isAllowedImageUrl } = require('../utils/http');
const { URL } = require('url');

async function handleImageRelay(req, res, serverBase) {
  const incoming = new URL(req.url, serverBase);
  const target = incoming.searchParams.get('url') || '';

  if (!target || !isAllowedImageUrl(target)) {
    send(res, 400, 'Invalid image URL');
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const upstream = await fetch(target, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0',
        'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      },
    });

    if (!upstream.ok || !upstream.body) {
      send(res, upstream.status || 502, `Upstream error: ${upstream.status}`);
      return;
    }

    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
    if (!contentType.toLowerCase().startsWith('image/')) {
      send(res, 415, 'Upstream response is not an image');
      return;
    }

    const contentLength = Number(upstream.headers.get('content-length') || 0);
    if (contentLength > MAX_IMAGE_BYTES) {
      send(res, 413, 'Image too large');
      return;
    }

    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=3600',
      'X-Relay-Source': new URL(target).hostname,
    });

    const reader = upstream.body.getReader();
    let total = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      total += value.byteLength;
      if (total > MAX_IMAGE_BYTES) {
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
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { handleImageRelay };
