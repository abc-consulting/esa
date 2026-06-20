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

**Browser layer** (`app.js` + `modules/`) — ES module scripts loaded by `index.html`. All UI logic lives here.

**Server layer** (`server.js`) — A plain `http.createServer` server with three responsibilities:
1. Serve static files (HTML, JS, CSS) so ES module imports work without a CORS error
2. Relay images via `/image?url=<encoded>` — bypasses hot-link blocking from ESA and RedVelvet; only allows a fixed allowlist of hostnames (`ALLOWED_IMAGE_HOSTS`)
3. Expose RedVelvet lookup APIs (`/redvelvet-area`, `/redvelvet-areas`, `/redvelvet-area-profiles`, `/redvelvet-fetishes`, `/redvelvet-tag-profiles`) so the browser doesn't have to scrape those sites through a public CORS proxy

The relay base URL is injected into the browser via a `<meta name="esa-image-relay-base-url">` tag in `index.html`. If this tag is absent or empty, image relaying is silently skipped.

### Module layout

```
modules/
  config.js          — BASE_URL, REDVELVET_BASE_URL, PROXY, IMAGE_RELAY_BASE_URL, STORAGE_KEYS
  dom.js             — single dom object of getElementById references for all used elements
  storage.js         — localStorage helpers: parseJsonStorage, writeJsonStorage, scoped get/set, provider persistence
  url-utils.js       — URL parsing/normalization shared between providers (extractUidFromUrl, extractSubId, normalizeGalleryImageUrl, etc.)
  common-utiils.js   — debounce (note: filename has a typo — double 'i')
  providers/
    esa-service.js       — fetches ESA profiles and images; returns structured data objects, never touches the DOM
    redvelvet-service.js — fetches RedVelvet profiles/images; handles ASP.NET __doPostBack pagination and quick-search form submission
```

### Provider pattern

Both provider service modules receive a `deps` object `{ fetchViaProxy, setStatus, searchBtn }` so they are decoupled from global DOM state. They return plain data objects; rendering is always done in `app.js`.

`app.js` maintains `activeProvider` (`'esa'` | `'redvelvet'`) and routes calls to the appropriate service. Provider selection is persisted in `localStorage` under `STORAGE_KEYS.provider`.

### Favorites storage

Favorites are stored grouped by provider (`STORAGE_KEYS.favorites` = `'esa.favorites.v2'`). The old format was a flat array — `loadFavorites()` in `app.js` handles backward-compat migration on read.

Last-search is similarly scoped per provider under `STORAGE_KEYS.lastSearch` (`'esa.lastSearch.v2'`).

### CORS strategy

All ESA page fetches go through `https://corsproxy.io/?<encoded-url>` (the public `PROXY` constant). RedVelvet area/profile lookups for server-side enrichment go through the local relay server directly. Image display for both providers goes through the local `/image` relay endpoint.

### RedVelvet pagination

RedVelvet uses ASP.NET WebForms with `__doPostBack` for pagination. The server-side `fetchRedvelvetProfilesWithPostback` and the client-side `fetchRedvelvetAreaAllPages` in `redvelvet-service.js` both implement a queue-based loop that extracts `__doPostBack` targets from the page and submits POST requests with the full hidden-field payload to walk through pages (capped at 25 pages).
