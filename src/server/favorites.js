'use strict';

const fs   = require('fs');
const path = require('path');
const { send } = require('./utils/http');

const FAVORITES_FILE = path.join(__dirname, '../../data/favorites.json');

function readFavorites() {
  try {
    const raw = fs.readFileSync(FAVORITES_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function writeFavorites(data) {
  const dir = path.dirname(FAVORITES_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(FAVORITES_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function handleGetFavorites(req, res) {
  const data = readFavorites();
  send(res, 200, JSON.stringify(data), { 'Content-Type': 'application/json; charset=utf-8' });
}

async function handleSaveFavorites(req, res) {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    let data;
    try {
      data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      send(res, 400, JSON.stringify({ error: 'Invalid JSON' }), { 'Content-Type': 'application/json' });
      return;
    }
    if (typeof data !== 'object' || Array.isArray(data) || data === null) {
      send(res, 400, JSON.stringify({ error: 'Expected an object' }), { 'Content-Type': 'application/json' });
      return;
    }
    try {
      writeFavorites(data);
      send(res, 200, JSON.stringify({ ok: true }), { 'Content-Type': 'application/json' });
    } catch (err) {
      send(res, 500, JSON.stringify({ error: err.message }), { 'Content-Type': 'application/json' });
    }
  });
}

module.exports = { handleGetFavorites, handleSaveFavorites };
