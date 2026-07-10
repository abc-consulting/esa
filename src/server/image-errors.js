'use strict';

const { getDb } = require('./db');
const { send } = require('./utils/http');

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(raw)); } catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

// POST /image-errors
// Body: { url: string, profileId?: string, profileName?: string, provider?: string }
// Upserts the error record; on retry success the client calls DELETE-style POST with { url, resolved: true }
async function handleImageErrorReport(req, res) {
  const body = await readBody(req);
  const { url, profileId, profileName, provider, resolved } = body;

  if (!url) { send(res, 400, JSON.stringify({ error: 'url required' }), { 'Content-Type': 'application/json' }); return; }

  try {
    const db  = await getDb();
    const col = db.collection('imageErrors');

    if (resolved) {
      await col.deleteOne({ url });
    } else {
      await col.updateOne(
        { url },
        {
          $set:         { lastFailedAt: new Date() },
          $setOnInsert: { url, profileId: profileId || null, profileName: profileName || null, provider: provider || null, failCount: 0 },
          $inc:         { failCount: 1 },
        },
        { upsert: true },
      );
    }

    send(res, 200, JSON.stringify({ ok: true }), { 'Content-Type': 'application/json' });
  } catch (err) {
    send(res, 500, JSON.stringify({ error: err.message }), { 'Content-Type': 'application/json' });
  }
}

// GET /image-errors
async function handleGetImageErrors(req, res) {
  try {
    const db   = await getDb();
    const docs = await db.collection('imageErrors').find({}).sort({ lastFailedAt: -1 }).toArray();
    send(res, 200, JSON.stringify({ errors: docs }), { 'Content-Type': 'application/json' });
  } catch (err) {
    send(res, 500, JSON.stringify({ error: err.message }), { 'Content-Type': 'application/json' });
  }
}

module.exports = { handleImageErrorReport, handleGetImageErrors };
