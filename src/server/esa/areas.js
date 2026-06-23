'use strict';

const { ESA_BASE_URL, CACHE_TTL_MS } = require('../constants');
const { fetchText } = require('../utils/http');
const { normalizeAreaName } = require('../utils/normalize');

// Map of normalized area name → { name, url }
let areaMapCache = null;
let areaMapCacheTime = 0;

async function buildEsaAreaHashMap() {
  if (areaMapCache && Date.now() - areaMapCacheTime < CACHE_TTL_MS) return areaMapCache;

  const html = await fetchText(`${ESA_BASE_URL}/category.php?sp[city]=Cape%20Town`);

  const map = new Map();
  // Extract area links: /gallery.php?...sp[area]=AreaName... or sp%5Barea%5D=...
  const re = /href="([^"]*gallery\.php[^"]*(?:sp\[area\]|sp%5Barea%5D)=([^&"#]+)[^"]*)"/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const rawHref = m[1];
    const rawArea = decodeURIComponent(m[2].replace(/\+/g, ' ')).trim();
    if (!rawArea) continue;
    const key = normalizeAreaName(rawArea);
    if (!map.has(key)) {
      const url = rawHref.startsWith('http') ? rawHref : `${ESA_BASE_URL}${rawHref}`;
      map.set(key, { name: rawArea, url });
    }
  }

  areaMapCache = map;
  areaMapCacheTime = Date.now();
  console.log(`[ESA] Built ESA area hash map with ${map.size} keys`);
  return map;
}

module.exports = { buildEsaAreaHashMap };
