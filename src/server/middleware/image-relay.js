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
        'Accept': '*/*',
      },
    });

    if (!upstream.ok || !upstream.body) {
      send(res, upstream.status || 502, `Upstream error: ${upstream.status}`);
      return;
    }

    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
    const ct = contentType.toLowerCase();
    const isImage = ct.startsWith('image/');
    const isVideo = ct.startsWith('video/') || ct === 'application/octet-stream' && /\.(mp4|webm|ogg|mov)(\?|$)/i.test(target);
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
      'X-Relay-Source': new URL(target).hostname,
    };
    if (upstream.headers.get('content-length')) {
      responseHeaders['Content-Length'] = upstream.headers.get('content-length');
    }
    if (upstream.headers.get('accept-ranges')) {
      responseHeaders['Accept-Ranges'] = upstream.headers.get('accept-ranges');
    }
    res.writeHead(200, responseHeaders);

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
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { handleImageRelay };
