'use strict';

function normalizeAreaName(value) {
  return decodeURIComponent(String(value || ''))
    .replace(/\+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function normalizeTagName(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function decodePlusSegment(value) {
  return decodeURIComponent(String(value || '')).replace(/\+/g, ' ').trim();
}

module.exports = { normalizeAreaName, normalizeTagName, decodePlusSegment };
