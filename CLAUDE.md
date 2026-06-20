# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the App

```bash
node server.js          # start the local server (default port 5510)
npm start               # same as above
PORT=3000 node server.js  # override port
```

Open `http://localhost:5510` in a browser. There is no build step — the frontend is vanilla ES modules served directly by the local server.

## Architecture

This is a single-page browser app backed by a lightweight Node.js server. There are no frameworks, no bundler, and no npm dependencies.

### Two-layer design

**Browser layer** (`src/client/app.js` + `src/client/modules/`) — ES module scripts loaded by `index.html`. All UI logic lives here.

**Server layer** (`src/server/router.js`) — A plain `http.createServer` server with three responsibilities:
1. Serve static files (HTML, JS, CSS) so ES module imports work without a CORS error
2. Relay images via `/image?url=<encoded>` — bypasses hot-link blocking from ESA and RedVelvet; only allows a fixed allowlist of hostnames (`ALLOWED_IMAGE_HOSTS` in `src/server/constants.js`)
3. Expose RedVelvet lookup APIs so the browser doesn't scrape those sites through a public CORS proxy

The relay base URL is injected into the browser via a `<meta name="esa-image-relay-base-url">` tag in `index.html`. If this tag is absent or empty, image relaying is silently skipped.

### Server API endpoints

| Endpoint | Handler | Description |
|---|---|---|
| `/image?url=<encoded>` | `middleware/image-relay.js` | Proxy-relay images from allowed hosts |
| `/redvelvet-area?name=<name>` | `redvelvet/areas.js` | Resolve area name → URL + IDs |
| `/redvelvet-areas?cityBucket=<n>` | `redvelvet/areas.js` | List all area names for a city bucket |
| `/redvelvet-area-profiles?name=<name>&cityBucket=<n>` | `redvelvet/areas.js` | Fetch all profiles in an area |
| `/redvelvet-tags?` | `redvelvet/tags.js` | List all fetish/tag labels |
| `/redvelvet-tag-profiles?tag=<label>&cityBucket=<n>` | `redvelvet/profiles.js` | Fetch all profiles matching a tag |

### Module layout

```
src/
  client/
    app.js                 — main entry point; all UI state, event wiring, rendering
    modules/
      config.js            — BASE_URL, REDVELVET_BASE_URL, PROXY, IMAGE_RELAY_BASE_URL, STORAGE_KEYS
      dom.js               — single dom object of getElementById refs for all used elements
      storage.js           — localStorage helpers: parseJsonStorage, writeJsonStorage, scoped get/set, provider persistence
      url-utils.js         — URL parsing/normalization shared between providers
      common-utils.js      — debounce
      http.js              — shared fetch helpers for the client
      favorites.js         — favorites state, storage, rendering, init
      providers/
        esa-service.js       — fetches ESA profiles and images; returns structured data, never touches DOM
        redvelvet-service.js — fetches RedVelvet profiles/images; scrapes age, bust, tags from profile pages
  server/
    router.js              — http.createServer, route dispatch, startup hashmap warmup
    constants.js           — PORT, ROOT, MIME_TYPES, ALLOWED_IMAGE_HOSTS, URLs, TTLs
    middleware/
      static.js            — static file serving
      image-relay.js       — /image proxy relay
    redvelvet/
      areas.js             — area hashmap build/cache, area profile fetching, area handlers
      tags.js              — tag hashmap build/cache, tag URL resolution, /redvelvet-tags handler
      profiles.js          — ASP.NET __doPostBack pagination, /redvelvet-tag-profiles handler
    utils/
      http.js              — fetchText, send
      html.js              — extractHiddenFields, extractDataPagerTargets, stripTags, decodeHtmlEntities
      normalize.js         — normalizeAreaName, normalizeTagName
```

### Provider pattern

Both provider service modules receive a `deps` object `{ setStatus, searchBtn }` so they are decoupled from global DOM state. They return plain data objects; rendering is always done in `app.js`.

`app.js` maintains `activeProvider` (`'esa'` | `'redvelvet'`) and routes calls to the appropriate service. Provider selection is persisted in `localStorage` under `STORAGE_KEYS.provider`.

### Multi-filter state (`app.js`)

RedVelvet supports composable filtering across tags and areas. The state lives in six variables:

- `activeTags` / `tagProfileSets` / `tagProfileObjects` — selected fetish tags and their profile sets
- `activeAreas` / `areaProfileSets` / `areaProfileObjects` — selected areas and their profile sets

`applyFilters()` computes the final `profileLinks`:
- Tags → **intersection** (profile must match ALL selected tags)
- Areas → **union** (profile from ANY selected area)
- Both active → intersect the tag result with the area union

`updateFilterChips()` renders one dismissible chip per active tag and area and syncs both dropdown checkboxes. `clearProfiles()` resets all six state structures.

### Favorites storage

Favorites are stored grouped by provider (`STORAGE_KEYS.favorites` = `'esa.favorites.v2'`). The old format was a flat array — `loadFavorites()` in `app.js` handles backward-compat migration on read.

Last-search is similarly scoped per provider under `STORAGE_KEYS.lastSearch` (`'esa.lastSearch.v2'`).

### CORS strategy

All ESA page fetches go through `https://corsproxy.io/?<encoded-url>` (the public `PROXY` constant). RedVelvet area/profile lookups go through the local relay server directly. Image display for both providers goes through the local `/image` relay endpoint.

### RedVelvet pagination

RedVelvet uses ASP.NET WebForms with `__doPostBack` for pagination. `fetchRedvelvetProfilesWithPostback` in `src/server/redvelvet/profiles.js` implements a queue-based loop that extracts `__doPostBack` targets from each page and submits POST requests with the full hidden-field payload to walk through pages (capped at 25 pages). This runs server-side so the browser is not exposed to cross-origin POST restrictions.

### Server startup warmup

On `server.listen`, `router.js` fires `buildRedvelvetAreaHashMap()` and `buildRedvelvetTagHashMap()` in the background (errors are logged, not thrown) so the first area/tag request hits a warm cache.
