'use strict';

const { send } = require('../utils/http');
const { buildEsaAreaHashMap } = require('./areas');

async function handleEsaAreas(req, res) {
  try {
    const map = await buildEsaAreaHashMap();
    const areas = [...map.values()].map(v => v.name).sort((a, b) => a.localeCompare(b));
    send(res, 200, JSON.stringify({ count: areas.length, areas }), {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'max-age=3600',
    });
  } catch (err) {
    send(res, 502, JSON.stringify({ error: err.message }), {
      'Content-Type': 'application/json; charset=utf-8',
    });
  }
}

module.exports = { handleEsaAreas };
