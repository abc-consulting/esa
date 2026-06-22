'use strict';

const fs   = require('fs');
const path = require('path');
const { send } = require('./utils/http');

const GROUPS_FILE = path.join(__dirname, '../../data/profile-groups.json');

function readGroups() {
  try {
    const raw = fs.readFileSync(GROUPS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeGroups(groups) {
  const dir = path.dirname(GROUPS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(GROUPS_FILE, JSON.stringify(groups, null, 2), 'utf8');
}

function handleGetProfileGroups(req, res) {
  const groups = readGroups();
  send(res, 200, JSON.stringify(groups), { 'Content-Type': 'application/json; charset=utf-8' });
}

async function handleSaveProfileGroups(req, res) {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    let groups;
    try {
      groups = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      send(res, 400, JSON.stringify({ error: 'Invalid JSON' }), { 'Content-Type': 'application/json' });
      return;
    }
    if (!Array.isArray(groups)) {
      send(res, 400, JSON.stringify({ error: 'Expected an array' }), { 'Content-Type': 'application/json' });
      return;
    }
    try {
      writeGroups(groups);
      send(res, 200, JSON.stringify({ ok: true }), { 'Content-Type': 'application/json' });
    } catch (err) {
      send(res, 500, JSON.stringify({ error: err.message }), { 'Content-Type': 'application/json' });
    }
  });
}

module.exports = { handleGetProfileGroups, handleSaveProfileGroups };
