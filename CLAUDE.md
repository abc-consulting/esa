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
| `MONGODB_URL` | Optional | MongoDB connection string (default: `mongodb://localhost:27017`) |
| `MONGODB_DB` | Optional | MongoDB database name (default: `esa`) |

Without `RV_EMAIL`/`RV_PASSWORD` the server runs in anonymous mode; some profile details may be unavailable.

## Reference Docs

Full server architecture reference — data structures, endpoint table, request flows, caching strategy, and a guide for adding new providers:

- [`docs/server-architecture.md`](docs/server-architecture.md)
- [`docs/tech-debt.md`](docs/tech-debt.md) — known inconsistencies backlog

## Architecture

This is a single-page browser app backed by a lightweight Node.js server. There are no frameworks, no bundler, and no npm dependencies (jszip is loaded from a CDN `<script>` tag in `index.html`).

### Two-layer design

**Browser layer** (`src/client/app.js` + `src/client/modules/`) — ES module scripts loaded by `index.html`. All UI logic lives here.

**Server layer** (`src/server/router.js`) — A plain `http.createServer` server with responsibilities:
1. Serve static files (HTML, JS, CSS) so ES module imports work without a CORS error
2. Relay images via `/image?url=<encoded>` — bypasses hot-link blocking from ESA and RedVelvet; only allows a fixed allowlist of hostnames (`ALLOWED_IMAGE_HOSTS` in `src/server/constants.js`)
3. Expose ESA and RedVelvet lookup APIs so the browser doesn't scrape those sites through a public CORS proxy
4. Handle RedVelvet authentication and session management so credentials never leave the server
5. Persist favorites and profile-group links to `data/` JSON files

The relay base URL is injected into the browser via a `<meta name="esa-image-relay-base-url">` tag in `index.html`. If this tag is absent or empty, image relaying is silently skipped.

### Server API endpoints

| Endpoint | Method | Handler | Description |
|---|---|---|---|
| `/image?url=<encoded>` | GET | `middleware/image-relay.js` | Proxy-relay images/videos from allowed hosts |
| `/rv-auth-status` | GET | `redvelvet/auth.js` | Check whether a valid RV session cookie exists |
| `/profile-groups` | GET/POST | `profile-groups.js` | Read/write profile group links from `data/profile-groups.json` |
| `/favorites` | GET/POST | `favorites.js` | Read/write favorites from `data/favorites.json` |
| `/esa-areas` | GET | `esa/areas-list.js` | List all ESA area names |
| `/esa-profiles?nickname=<n>` | GET | `esa/profiles.js` | Search ESA profiles by nickname |
| `/esa-profiles?area=<a>` | GET | `esa/profiles.js` | Fetch all ESA profiles in an area |
| `/esa-profile-details?id=<uid>` | GET | `esa/profile-details.js` | Full ESA profile detail (images, phone, age) |
| `/esa-search` | POST | `esa/search.js` | Composite ESA search with include/exclude area filters |
| `/redvelvet-areas?cityBucket=<n>` | GET | `redvelvet/areas-list.js` | List all RV area names for a city bucket |
| `/redvelvet-area?name=<n>` | GET | `redvelvet/areas.js` | Resolve RV area name → URL + IDs |
| `/redvelvet-area-profiles?name=<n>&cityBucket=<n>` | GET | `redvelvet/areas.js` | Fetch all profiles in a RV area |
| `/redvelvet-tags?` | GET | `redvelvet/tags.js` | List all RV fetish/tag labels |
| `/redvelvet-tag-profiles?tag=<label>&cityBucket=<n>` | GET | `redvelvet/profiles.js` | Fetch all RV profiles matching a tag |
| `/redvelvet-profile-details?id=<uid>` | GET | `redvelvet/profile-details.js` | Full RV profile detail (age, bust, images, video, tags) |
| `/redvelvet-nickname-search?nickname=<n>&cityBucket=<n>` | GET | `redvelvet/nickname-search.js` | Search RV profiles by nickname |
| `/redvelvet-search` | POST | `redvelvet/search.js` | Composite RV search with include/exclude filters, age, and bust |

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
    router.js              — http.createServer, route dispatch, startup warmup
    constants.js           — PORT, ROOT, MIME_TYPES, ALLOWED_IMAGE_HOSTS, RACIAL_TAGS, URLs, TTLs
    profile-groups.js      — GET/POST /profile-groups; reads/writes data/profile-groups.json
    favorites.js           — GET/POST /favorites; reads/writes data/favorites.json
    middleware/
      static.js            — static file serving
      image-relay.js       — /image proxy relay with size fallback and byte cap
    utils/
      http.js              — fetchText, send, isAllowedImageUrl
      html.js              — extractHiddenFields, extractDataPagerTargets, stripTags, decodeHtmlEntities, getTagAttribute
      normalize.js         — normalizeAreaName, normalizeTagName, decodePlusSegment
      groups.js            — flattenWithSameNumber (annotates profiles with profiles_with_same_number)
    esa/
      areas.js             — buildEsaAreaHashMap (scraper + 4h cache)
      areas-list.js        — handleEsaAreas
      profiles.js          — parseEsaProfileCards, fetchEsaProfiles, handleEsaProfilesByNickname, handleEsaProfilesByArea
      profile-details.js   — parseEsaProfileDetails, fetchEsaProfileDetails, handleEsaProfileDetails (4h cache)
      search.js            — handleEsaSearch; area union/exclusion, nickname search
    redvelvet/
      auth.js              — two-step ASP.NET login; session cookie cache + deduplication
      areas.js             — buildRedvelvetAreaHashMap, fetchRedvelvetProfilesWithPostback (ASP.NET __doPostBack pagination, max 50 pages), getRedvelvetAreaProfiles, handleRedvelvetAreaLookup, handleRedvelvetAreaProfiles
      areas-list.js        — handleRedvelvetAreas
      tags.js              — buildRedvelvetTagHashMap, resolveRedvelvetTagUrl, handleRedvelvetTags
      profiles.js          — handleRedvelvetTagProfiles
      profile-details.js   — parseProfileDetails, fetchProfileMeta (metaCache), fetchRedvelvetProfileDetails (detailCache), handleRedvelvetProfileDetails, fetchProfileAgeAndBust; two-tier 4h cache
      search.js            — handleRedvelvetSearch; three-state include/exclude, racial union, age & bust filtering
      nickname-search.js   — handleRedvelvetNicknameSearch; ASP.NET form POST search
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

RedVelvet uses ASP.NET WebForms with `__doPostBack` for pagination. `fetchRedvelvetProfilesWithPostback` in `src/server/redvelvet/areas.js` implements a loop that extracts `__doPostBack` targets from each page and submits POST requests with the full hidden-field payload to walk through pages (capped at 50 pages). This runs server-side so the browser is not exposed to cross-origin POST restrictions.

### Profile detail caching

`src/server/redvelvet/profile-details.js` maintains two server-side caches keyed by UID: `metaCache` for lightweight age/bust metadata and `detailCache` for full profile data (images, videos, tags). Both have a 4-hour TTL (`CACHE_TTL_MS`). The `/redvelvet-search` endpoint uses `fetchProfileAgeAndBust` (concurrency-limited to 10 in-flight requests via an inline `pLimit` helper) when age or bust filters are active.

### Server startup warmup

On `server.listen`, `router.js` fires four background tasks:
1. `buildRedvelvetAreaHashMap()` — warms the RV area name → URL cache
2. `buildRedvelvetTagHashMap()` — warms the RV tag label → URL cache
3. `buildEsaAreaHashMap()` — warms the ESA area name → URL cache
4. `getSessionCookie()` — attempts RV login if `RV_EMAIL`/`RV_PASSWORD` are set

All four log errors without throwing, so a warmup failure doesn't crash the server.
