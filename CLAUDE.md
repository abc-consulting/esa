# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the App

```bash
node server.js          # start the local server (default port 5510)
npm start               # same as above
PORT=3000 node server.js  # override port
```

Open `http://localhost:5510` in a browser. There is no build step — the frontend is vanilla ES modules served directly by the local server.

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `RV_EMAIL` | Optional | RedVelvet account email for authenticated scraping |
| `RV_PASSWORD` | Optional | RedVelvet account password for authenticated scraping |

Without `RV_EMAIL`/`RV_PASSWORD` the server runs in anonymous mode; some profile details may be unavailable.

## Architecture

This is a single-page browser app backed by a lightweight Node.js server. There are no frameworks, no bundler, and no npm dependencies (jszip is loaded from a CDN `<script>` tag in `index.html`).

### Two-layer design

**Browser layer** (`src/client/app.js` + `src/client/modules/`) — ES module scripts loaded by `index.html`. All UI logic lives here.

**Server layer** (`src/server/router.js`) — A plain `http.createServer` server with four responsibilities:
1. Serve static files (HTML, JS, CSS) so ES module imports work without a CORS error
2. Relay images via `/image?url=<encoded>` — bypasses hot-link blocking from ESA and RedVelvet; only allows a fixed allowlist of hostnames (`ALLOWED_IMAGE_HOSTS` in `src/server/constants.js`)
3. Expose RedVelvet lookup APIs so the browser doesn't scrape those sites through a public CORS proxy
4. Handle RedVelvet authentication and session management so credentials never leave the server

The relay base URL is injected into the browser via a `<meta name="esa-image-relay-base-url">` tag in `index.html`. If this tag is absent or empty, image relaying is silently skipped.

### Server API endpoints

| Endpoint | Method | Handler | Description |
|---|---|---|---|
| `/image?url=<encoded>` | GET | `middleware/image-relay.js` | Proxy-relay images from allowed hosts |
| `/redvelvet-area?name=<name>` | GET | `redvelvet/areas.js` | Resolve area name → URL + IDs |
| `/redvelvet-areas?cityBucket=<n>` | GET | `redvelvet/areas.js` | List all area names for a city bucket |
| `/redvelvet-area-profiles?name=<name>&cityBucket=<n>` | GET | `redvelvet/areas.js` | Fetch all profiles in an area |
| `/redvelvet-tags?` | GET | `redvelvet/tags.js` | List all fetish/tag labels |
| `/redvelvet-tag-profiles?tag=<label>&cityBucket=<n>` | GET | `redvelvet/profiles.js` | Fetch all profiles matching a tag |
| `/redvelvet-profile?` | GET | `redvelvet/profiles.js` | Look up a single profile by UID |
| `/redvelvet-profile-details?` | GET | `redvelvet/profile-details.js` | Fetch full profile detail (age, bust, images, video, tags) |
| `/redvelvet-search` | POST | `redvelvet/search.js` | Composite search with include/exclude filters, age, and bust |
| `/rv-auth-status` | GET | `redvelvet/auth.js` | Check whether a valid session cookie exists |

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
        redvelvet-service.js — fetches RedVelvet profiles/images via the local server relay
  server/
    router.js              — http.createServer, route dispatch, startup warmup (hashmaps + auth)
    constants.js           — PORT, ROOT, MIME_TYPES, ALLOWED_IMAGE_HOSTS, RACIAL_TAGS, URLs, TTLs
    middleware/
      static.js            — static file serving
      image-relay.js       — /image proxy relay
    redvelvet/
      areas.js             — area hashmap build/cache, area profile fetching, area handlers
      tags.js              — tag hashmap build/cache, tag URL resolution, /redvelvet-tags handler
      profiles.js          — ASP.NET __doPostBack pagination, /redvelvet-tag-profiles and /redvelvet-profile handlers
      profile-details.js   — full profile detail scraping (name, age, bust, images, videos, tags); two-tier cache
      search.js            — composite /redvelvet-search handler; three-state include/exclude, age & bust filtering
      auth.js              — RedVelvet login/session management (RV_EMAIL/RV_PASSWORD env vars, cookie caching)
    utils/
      http.js              — fetchText, send, isAllowedImageUrl
      html.js              — extractHiddenFields, extractDataPagerTargets, stripTags, decodeHtmlEntities
      normalize.js         — normalizeAreaName, normalizeTagName, decodePlusSegment
```

### Provider pattern

Both provider service modules receive a `deps` object `{ setStatus, searchBtn }` so they are decoupled from global DOM state. They return plain data objects; rendering is always done in `app.js`.

`app.js` maintains `activeProvider` (`'esa'` | `'redvelvet'`) and routes calls to the appropriate service. Provider selection is persisted in `localStorage` under `STORAGE_KEYS.provider`.

### Multi-filter state (`app.js`)

RedVelvet supports three-state composable filtering across tags and areas. The relevant state variables are:

- `activeTags` / `excludedTags` — included and excluded fetish tags
- `activeAreas` / `excludedAreas` — included and excluded areas
- `ageMin` / `ageMax` — age range filter
- `selectedBand` / `selectedCup` / `sizeMinVol` / `sizeMaxVol` — bust size filter
- `detailCache` — client-side Map caching fetched profile detail objects

Filters are sent as a single POST body to `/redvelvet-search`, which handles all set logic server-side:
- Racial tags (`Asian`, `Black`, `Coloured`, `Indian`, `White`) → **union** within that group
- Other tags → **intersection** (profile must match ALL selected non-racial tags)
- Racial union then intersected with non-racial intersection
- Areas → **union** (profile from ANY selected area)
- Tags and areas → intersected together
- Excluded tags/areas → subtracted from the final set
- Age and bust filters applied last, requiring a detail page fetch per profile

`updateFilterChips()` renders one dismissible chip per active inclusion and exclusion, and syncs both dropdown checkboxes. `clearProfiles()` resets all filter state.

### Favorites storage

Favorites are stored grouped by provider (`STORAGE_KEYS.favorites` = `'esa.favorites.v2'`). The old format was a flat array — `loadFavorites()` in `app.js` handles backward-compat migration on read.

Last-search is similarly scoped per provider under `STORAGE_KEYS.lastSearch` (`'esa.lastSearch.v2'`).

RedVelvet filter state (included/excluded tags and areas, age, bust) is persisted under `STORAGE_KEYS.rvFilters` (`'esa.rvFilters.v1'`) and restored on load.

### CORS strategy

All ESA page fetches go through `https://corsproxy.io/?<encoded-url>` (the public `PROXY` constant). RedVelvet area/profile lookups go through the local relay server directly. Image display for both providers goes through the local `/image` relay endpoint.

### RedVelvet authentication

`src/server/redvelvet/auth.js` implements a two-step ASP.NET login flow using `RV_EMAIL`/`RV_PASSWORD` env vars. It caches the session cookie in memory and deduplicates concurrent login attempts so only one network round-trip happens. The cookie is sent as a request header on all authenticated RedVelvet fetches. On startup, `router.js` calls `getSessionCookie()` to warm the session.

### RedVelvet pagination

RedVelvet uses ASP.NET WebForms with `__doPostBack` for pagination. `fetchRedvelvetProfilesWithPostback` in `src/server/redvelvet/profiles.js` implements a queue-based loop that extracts `__doPostBack` targets from each page and submits POST requests with the full hidden-field payload to walk through pages (capped at 25 pages). This runs server-side so the browser is not exposed to cross-origin POST restrictions.

### Profile detail caching

`src/server/redvelvet/profile-details.js` maintains two server-side caches keyed by UID: `metaCache` for lightweight age/bust metadata and `detailCache` for full profile data (images, videos, tags). Both have a 4-hour TTL (`CACHE_TTL_MS`). The `/redvelvet-search` endpoint uses `fetchProfileAgeAndBust` (concurrency-limited to 10 in-flight requests via an inline `pLimit` helper) when age or bust filters are active.

### Server startup warmup

On `server.listen`, `router.js` fires three background tasks:
1. `buildRedvelvetAreaHashMap()` — warms the area name → URL cache
2. `buildRedvelvetTagHashMap()` — warms the tag label → URL cache
3. `getSessionCookie()` — attempts login if `RV_EMAIL`/`RV_PASSWORD` are set

All three log errors without throwing, so a warmup failure doesn't crash the server.
