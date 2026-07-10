'use strict';

const { MAX_IMAGE_BYTES, REQUEST_TIMEOUT_MS } = require('../constants');
const { send, isAllowedImageUrl } = require('../utils/http');
const { URL } = require('url');
const { getDb, getGridFSBucket } = require('../db');

async function persistImageBinary(sourceUrl, finalUrl, buffer, contentType) {
  try {
    const db  = await getDb();
    const doc = await db.collection('profileImages').findOne({ url: sourceUrl });
    if (!doc || doc.fileId) return; // not tracked or already stored

    const bucket   = await getGridFSBucket();
    const filename = `profileImages/${doc._id}`;
    const upload   = bucket.openUploadStream(filename, { contentType });
    await new Promise((resolve, reject) => {
      upload.on('finish', resolve);
      upload.on('error', reject);
      upload.end(buffer);
    });

    const quality = (() => {
      const m = finalUrl.match(/[?&]size=([^&]+)/i);
      return m ? m[1].toLowerCase() : null;
    })();

    const update = { $set: { fileId: upload.id } };
    if (quality) update.$set.quality = quality;
    await db.collection('profileImages').updateOne({ _id: doc._id }, update);
  } catch { /* non-fatal — relay already served the bytes */ }
}

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

async function serveFromGridFS(res, bucket, db, fileId) {
  const fileMeta = await db.collection('profileImages.files').findOne({ _id: fileId });
  const contentType = fileMeta?.contentType || 'image/jpeg';
  res.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': 'public, max-age=86400',
    'X-Relay-Source': 'db',
  });
  const stream = bucket.openDownloadStream(fileId);
  stream.pipe(res);
  stream.on('error', () => { if (!res.headersSent) send(res, 502, 'GridFS read error'); else res.destroy(); });
}

async function handleImageRelay(req, res, serverBase) {
  const incoming = new URL(req.url, serverBase);
  const imageUid = incoming.searchParams.get('id')  || '';
  const target   = incoming.searchParams.get('url') || '';

  // Resolve by uid: look up the profileImages doc, then serve from GridFS or fall back to its url
  if (imageUid) {
    try {
      const db  = await getDb();
      const doc = await db.collection('profileImages').findOne({ uid: imageUid });
      if (!doc) { send(res, 404, 'Image not found'); return; }
      if (doc.fileId) {
        const bucket = await getGridFSBucket();
        await serveFromGridFS(res, bucket, db, doc.fileId);
        return;
      }
      // Has a source URL — fall through to upstream fetch using doc.url
      if (!doc.url || !isAllowedImageUrl(doc.url)) { send(res, 400, 'Invalid image URL'); return; }
      return await fetchAndServe(req, res, doc.url, doc.url);
    } catch (err) {
      if (!res.headersSent) send(res, 500, `DB error: ${err.message}`);
      return;
    }
  }

  if (!target || !isAllowedImageUrl(target)) {
    send(res, 400, 'Invalid image URL');
    return;
  }

  // DB-first: if we have the binary stored for this URL, serve from GridFS
  try {
    const db  = await getDb();
    const doc = await db.collection('profileImages').findOne({ url: target }, { projection: { fileId: 1 } });
    if (doc?.fileId) {
      const bucket = await getGridFSBucket();
      await serveFromGridFS(res, bucket, db, doc.fileId);
      return;
    }
  } catch { /* non-fatal — fall through to upstream fetch */ }

  await fetchAndServe(req, res, target, target);
}

async function fetchAndServe(req, res, target, sourceUrl) {
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
    const reader  = upstream.body.getReader();
    const chunks  = [];
    let total = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      total += value.byteLength;
      if (isImage && total > MAX_IMAGE_BYTES) {
        res.destroy();
        return;
      }

      const buf = Buffer.from(value);
      chunks.push(buf);
      res.write(buf);
    }

    res.end();

    // Fire-and-forget: store binary in GridFS if this URL is tracked in profileImages
    if (isImage && chunks.length) {
      const fullBuffer = Buffer.concat(chunks);
      persistImageBinary(sourceUrl, currentUrl, fullBuffer, contentType);
    }
  } catch (err) {
    if (!res.headersSent) {
      send(res, 502, `Relay failed: ${err.message}`);
    } else {
      res.destroy();
    }
  }
}

module.exports = { handleImageRelay };
