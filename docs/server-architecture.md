# Server Architecture Reference

## Overview

Plain Node.js `http.createServer` — no framework, no bundler, no npm dependencies.  
Entry point: `src/server/router.js` → delegates every route to a handler module.

Two data providers (ESA, RedVelvet) share a common shape contract defined below.  
Shared middleware (static files, image relay) is provider-agnostic.

---

## Module Map

```
src/server/
  router.js                 — route dispatch, startup warmup
  constants.js              — all shared constants (PORT, TTLs, URLs, allow-lists)

  middleware/
    static.js               — serves HTML/JS/CSS from disk
    image-relay.js          — proxies images/videos from allowed hosts

  utils/
    http.js                 — fetchText, send, isAllowedImageUrl
    html.js                 — extractHiddenFields, extractDataPagerTargets, stripTags, decodeHtmlEntities, getTagAttribute
    normalize.js            — normalizeAreaName, normalizeTagName, decodePlusSegment
    groups.js               — flattenWithSameNumber

  esa/
    areas.js                — buildEsaAreaHashMap (cache + scraper)
    areas-list.js           — handleEsaAreas (HTTP handler)
    profiles.js             — parseEsaProfileCards, fetchEsaProfiles, handleEsaProfilesByNickname, handleEsaProfilesByArea
    profile-details.js      — parseEsaProfileDetails, fetchEsaProfileDetails, handleEsaProfileDetails
    search.js               — handleEsaSearch

  redvelvet/
    auth.js                 — getSessionCookie, clearSessionCookie (two-step ASP.NET login)
    areas.js                — buildRedvelvetAreaHashMap, fetchRedvelvetProfilesWithPostback, getRedvelvetAreaProfiles, handleRedvelvetAreaLookup, handleRedvelvetAreaProfiles
    areas-list.js           — handleRedvelvetAreas (HTTP handler)
    tags.js                 — buildRedvelvetTagHashMap, resolveRedvelvetTagUrl, handleRedvelvetTags
    profiles.js             — handleRedvelvetTagProfiles (handleRedvelvetProfileLookup is 501 stub)
    profile-details.js      — parseProfileDetails, fetchProfileMeta, fetchRedvelvetProfileDetails, handleRedvelvetProfileDetails, fetchProfileAgeAndBust
    search.js               — handleRedvelvetSearch
    nickname-search.js      — handleRedvelvetNicknameSearch

  profile-groups.js         — handleGetProfileGroups, handleSaveProfileGroups (reads/writes data/profile-groups.json)
  favorites.js              — handleGetFavorites, handleSaveFavorites (reads/writes data/favorites.json)
```

---

## Canonical Data Structures

All endpoints share these shapes. Every new provider **must** produce these exact fields.

### ProfileStub

Returned by list/search endpoints. Lightweight — no detail fields.

```js
{
  provider:   'esa' | 'redvelvet',   // string — identifies the source
  uid:        string,                 // unique ID within the provider
  name:       string,
  area:       string,                 // display name of the area/suburb
  profileUrl: string,                 // absolute URL to the profile page
  thumbUrl:   string,                 // absolute URL to the thumbnail image
  phone:      string,                 // raw phone string (may be empty)

  // Added by flattenWithSameNumber() before response serialisation:
  profiles_with_same_number: [{ uid: string, provider: string }]
}
```

### ProfileDetail

Returned by `/*/profile-details` endpoints. Superset of ProfileStub — fetched on demand.

```js
{
  profile: {
    provider:   'esa' | 'redvelvet',
    uid:        string,
    name:       string,
    area:       string,
    areaUrl:    string,               // absolute URL to the area listing page
    thumbUrl:   string,
    profileUrl: string,
    phone:      string,
    age:        string,               // raw string e.g. "28", may be ""
    bust:       string,               // e.g. "34C" — present but "" for ESA
    tags:       string[],             // fetish/category labels — [] for ESA
  },
  images: string[],                   // ordered list of absolute image URLs
  videos: string[],                   // ordered list of absolute video URLs; [] for ESA
}
```

> **Note:** `bust` and `tags` are currently absent from ESA's `ProfileDetail.profile`. When ESA gains these fields, add them here and to `parseEsaProfileDetails`.

### AreaEntry (RedVelvet internal)

Used only within the RV layer; never serialised directly.

```js
{
  name:       string,   // normalised area name (lowercase, trimmed)
  areaId:     string,
  cityBucket: string,   // '2' = Cape Town
  url:        string,   // absolute URL to the RV area listing page
}
```

### TagEntry (RedVelvet API response)

```js
{
  label: string,          // display label e.g. "Asian"
  url:   string,          // absolute URL to the RV tag listing page
  count: number | null,   // profile count scraped from the option text
}
```

### SearchRequestBody

Sent as `application/json` to `POST /redvelvet-search` and `POST /esa-search`.

```js
// RedVelvet
{
  cityBucket: string,                // default '2'
  areas:  { included: string[], excluded: string[] },
  tags:   { included: string[], excluded: string[] },   // RV only
  age:    { min: number, max: number },                  // optional
  bust:   { band: number, cup: string, range: { min: number, max: number } } // optional
}

// ESA (subset — no tags/age/bust support yet)
{
  areas:    { included: string[], excluded: string[] },
  nickname: string   // optional; mutually exclusive with areas in practice
}
```

### GroupsFile (`data/profile-groups.json`)

Persisted as JSON, served verbatim. Shape is opaque to the server — it stores and returns whatever the client sends.

```js
Group[] // array of group objects; schema owned by the client
```

### FavoritesFile (`data/favorites.json`)

```js
{ [provider: string]: ProfileStub[] }  // keyed by provider, values are arrays
```

---

## Endpoint Reference

All responses include `Access-Control-Allow-Origin: *`.  
All JSON responses use `Content-Type: application/json; charset=utf-8`.

### Infrastructure / Shared

| Method | Path | Query / Body | Success Response | Notes |
|--------|------|--------------|-----------------|-------|
| GET | `/image?url=<encoded>` | `url` — encoded absolute image/video URL | image or video bytes | Only hosts in `ALLOWED_IMAGE_HOSTS` are proxied. Falls back through `size=` variants on 4xx. |
| GET | `/rv-auth-status` | — | `{ loggedIn: bool, cookie: string\|null }` | Shows first 40 chars of cookie |
| GET | `/profile-groups` | — | `Group[]` | Read from `data/profile-groups.json` |
| POST | `/profile-groups` | `Group[]` | `{ ok: true }` | Replaces the whole file |
| GET | `/favorites` | — | `{ [provider]: ProfileStub[] }` | Read from `data/favorites.json` |
| POST | `/favorites` | `{ [provider]: ProfileStub[] }` | `{ ok: true }` | Replaces the whole file |

### ESA

| Method | Path | Query / Body | Success Response |
|--------|------|--------------|-----------------|
| GET | `/esa-areas` | — | `{ count: number, areas: string[] }` |
| GET | `/esa-profiles?nickname=<n>` | `nickname` | `{ count, profiles: ProfileStub[] }` |
| GET | `/esa-profiles?area=<a>` | `area` | `{ count, profiles: ProfileStub[] }` |
| GET | `/esa-profile-details?id=<uid>` | `id` — numeric UID | `ProfileDetail` |
| POST | `/esa-search` | `SearchRequestBody` (ESA subset) | `{ count, profiles: ProfileStub[] }` |

### RedVelvet

| Method | Path | Query / Body | Success Response |
|--------|------|--------------|-----------------|
| GET | `/redvelvet-areas?cityBucket=<n>` | `cityBucket` (optional) | `{ cityBucket, count, areas: string[] }` |
| GET | `/redvelvet-area?name=<n>` | `name` | `{ url, area, areaId, cityBucket }` or `{ url: '' }` |
| GET | `/redvelvet-area-profiles?name=<n>&cityBucket=<n>` | `name`, `cityBucket` | `{ area, areaUrl, count, profiles: ProfileStub[] }` |
| GET | `/redvelvet-tags?` | — | `{ count, tags: TagEntry[] }` |
| GET | `/redvelvet-tag-profiles?tag=<t>&cityBucket=<n>` | `tag`, optional `tagUrl`, `cityBucket` | `{ tag, tagUrl, cityBucket, count, profiles: ProfileStub[] }` |
| GET | `/redvelvet-profile-details?id=<uid>` | `id` — numeric UID | `ProfileDetail` |
| GET | `/redvelvet-nickname-search?nickname=<n>&cityBucket=<n>` | `nickname`, `cityBucket` | `{ count, profiles: ProfileStub[] }` |
| POST | `/redvelvet-search` | `SearchRequestBody` | `{ count, profiles: ProfileStub[] }` |

---

## Request Flow Diagrams

### Area Profile List (RV)

```
Client
  │
  ├─ GET /redvelvet-area-profiles?name=Camps+Bay&cityBucket=2
  │
Router → handleRedvelvetAreaProfiles (areas.js)
  │
  ├─ getRedvelvetAreaProfiles(name, cityBucket)
  │     ├─ check areaProfileListCache (4h TTL)
  │     ├─ buildRedvelvetAreaHashMap() → (warm from startup, 4h TTL)
  │     │     └─ GET https://redvelvet.co.za/escorts/escorts_in_area
  │     │        scrapes slug/areaId/cityBucket triples → Map<normalizedName, AreaEntry[]>
  │     ├─ findAreaEntryByName(map, name, '2') → AreaEntry
  │     └─ fetchRedvelvetProfilesWithPostback(areaEntry.url)
  │           ├─ GET <areaUrl>          → parse page 1 with parseRedvelvetAreaProfiles
  │           └─ loop: POST __doPostBack → parse next pages (max 50)
  │              returns ProfileStub[]
  │
  ├─ flattenWithSameNumber(profiles) → adds profiles_with_same_number
  └─ send 200 { area, areaUrl, count, profiles: ProfileStub[] }
```

### Profile Detail (RV)

```
Client
  │
  ├─ GET /redvelvet-profile-details?id=12345
  │
Router → handleRedvelvetProfileDetails (profile-details.js)
  │
  ├─ fetchRedvelvetProfileDetails(profileUrl)
  │     ├─ check detailCache by uid (4h TTL)
  │     ├─ fetchProfileMeta(uid)
  │     │     ├─ check metaCache by uid (4h TTL)
  │     │     ├─ fetchAuthenticated(profileUrl)   ← uses session cookie if available
  │     │     │     └─ on login redirect: clearSessionCookie + retry without auth
  │     │     └─ parseProfileDetails(html, finalUrl)
  │     │          → { uid, name, area, age, bust, phone, tags, images,
  │     │               videoPageUrl, rawPageUrl }
  │     ├─ fetchAuthenticated(videoPageUrl) → parseVideoPage → string[]
  │     ├─ fetchAuthenticated(rawPageUrl)   → parseRawPage   → string[]
  │     └─ merge images, build ProfileDetail, store in detailCache
  │
  └─ send 200 ProfileDetail
```

### Composite Search (RV)

```
Client
  │
  ├─ POST /redvelvet-search
  │   body: { areas, tags, age, bust, cityBucket }
  │
Router → handleRedvelvetSearch (search.js)
  │
  ├─ Parse body → includedAreas, excludedAreas, includedTags, excludedTags, age, bust
  ├─ Split includedTags → racialTags (union) + otherTags (intersection)
  │
  ├─ Parallel fetch:
  │     areaResults   = getRedvelvetAreaProfiles × includedAreas
  │     racialResults = fetchTagProfiles × racialTags
  │     otherResults  = fetchTagProfiles × otherTags
  │
  ├─ Set logic:
  │     areaUids   = union  of area profile UIDs
  │     racialUids = union  of racial tag profile UIDs
  │     otherUids  = intersection of other tag profile UIDs
  │     tagUids    = racialUids ∩ otherUids  (or whichever is non-null)
  │     finalUids  = tagUids ∩ areaUids      (or whichever is non-null)
  │
  ├─ Subtract excluded areas + excluded tags UIDs
  │
  ├─ If age/bust/excludedTags filters active:
  │     fetchProfileAgeAndBust(uid) × all profiles  (concurrency 10)
  │     → filter by age, bust, tag exclusion
  │
  ├─ flattenWithSameNumber(profiles)
  └─ send 200 { count, profiles: ProfileStub[] }
```

### ESA Profile Detail

```
Client
  │
  ├─ GET /esa-profile-details?id=67890
  │
Router → handleEsaProfileDetails (esa/profile-details.js)
  │
  ├─ fetchEsaProfileDetails(uid)
  │     ├─ check detailCache by uid (4h TTL)
  │     ├─ fetchText(ESA_BASE_URL/escorts/viewEscort.php?uid=...)
  │     └─ parseEsaProfileDetails(uid, html)
  │           ├─ extract name, area, areaUrl, phone, age, thumbUrl
  │           ├─ extract /client/gallery/srv.php URLs → directImages
  │           └─ expand subid/picnum ranges into picserver URLs
  │
  └─ send 200 ProfileDetail  (videos: [] always)
```

### Image Relay

```
Client
  │
  ├─ GET /image?url=<encoded-absolute-url>
  │
Router → handleImageRelay (middleware/image-relay.js)
  │
  ├─ isAllowedImageUrl(target) — hostname must be in ALLOWED_IMAGE_HOSTS
  ├─ fetchUpstream(target, userAgent, REQUEST_TIMEOUT_MS)
  │     └─ on 4xx + size= param in URL: retry with next size fallback
  │         (large → medium → small → thumb_blur)
  ├─ validate Content-Type: must be image/* or video/*
  ├─ validate Content-Length ≤ MAX_IMAGE_BYTES (images only)
  ├─ stream body to client, enforce byte cap during streaming
  └─ send 200 with Cache-Control: public, max-age=3600
```

---

## Caching Strategy

| Cache | Location | Key | TTL | Scope |
|-------|----------|-----|-----|-------|
| RV area hashmap | `redvelvet/areas.js` module-level | — | 4h | warm on startup |
| RV area profile list | `redvelvet/areas.js` `areaProfileListCache` Map | normalised area name | 4h | per area |
| RV tag hashmap | `redvelvet/tags.js` module-level | — | 4h | warm on startup |
| RV tag profile list | `redvelvet/search.js` `tagProfileCache` Map | `tag:cityBucket` | 4h | per tag+bucket |
| RV profile meta | `redvelvet/profile-details.js` `metaCache` Map | uid | 4h | per profile |
| RV profile detail | `redvelvet/profile-details.js` `detailCache` Map | uid | 4h | per profile |
| ESA area hashmap | `esa/areas.js` module-level | — | 4h | warm on startup |
| ESA profile detail | `esa/profile-details.js` `detailCache` Map | uid | 4h | per profile |

All cache TTLs are driven by `CACHE_TTL_MS = 4 * 60 * 60 * 1000` (constants.js).

---

## Startup Warmup

On `server.listen`, three background tasks fire in parallel (errors are logged, never thrown):

1. `buildRedvelvetAreaHashMap()` — fills RV area name → URL map
2. `buildRedvelvetTagHashMap()` — fills RV tag label → URL map
3. `buildEsaAreaHashMap()` — fills ESA area name → URL map
4. `getSessionCookie()` — logs into RV if `RV_EMAIL` + `RV_PASSWORD` are set

---

## Adding a New Provider

Follow this checklist. "Provider" here means a new scraping source (e.g. `newprovider`).

### 1. Create `src/server/newprovider/`

| File | Responsibility |
|------|----------------|
| `areas.js` | `buildNewProviderAreaHashMap()`, `getNewProviderAreaProfiles(name)` |
| `areas-list.js` | `handleNewProviderAreas(req, res)` |
| `profiles.js` | `parseNewProviderProfileCards(html)`, `fetchNewProviderProfiles(url)`, `handleNewProviderProfilesByArea`, `handleNewProviderProfilesByNickname` |
| `profile-details.js` | `fetchNewProviderProfileDetails(uid)`, `handleNewProviderProfileDetails(req, res)` |
| `search.js` | `handleNewProviderSearch(req, res)` |

### 2. Data contracts

- `parseNewProviderProfileCards` **must** return `ProfileStub[]` with all required fields.
- `fetchNewProviderProfileDetails` **must** return `ProfileDetail`.
- Call `flattenWithSameNumber(profiles)` before serialising any list response.

### 3. Constants

Add provider-specific base URLs, TTLs, and any allow-listed hostnames to `src/server/constants.js`. Add image hostnames to `ALLOWED_IMAGE_HOSTS`.

### 4. Register routes in `router.js`

```js
// import
const { handleNewProviderAreas }          = require('./newprovider/areas-list');
const { handleNewProviderProfilesByArea } = require('./newprovider/profiles');
const { handleNewProviderProfileDetails } = require('./newprovider/profile-details');
const { handleNewProviderSearch }         = require('./newprovider/search');

// routes — follow the /newprovider- prefix pattern
if (req.url === '/newprovider-areas') { await handleNewProviderAreas(req, res); return; }
if (req.url?.startsWith('/newprovider-profiles?')) { await handleNewProviderProfilesByArea(req, res); return; }
if (req.url?.startsWith('/newprovider-profile-details?')) { await handleNewProviderProfileDetails(req, res); return; }
if (req.url === '/newprovider-search' && req.method === 'POST') { await handleNewProviderSearch(req, res); return; }
```

### 5. Warmup

Add the area/tag hashmap build to the `server.listen` block:

```js
buildNewProviderAreaHashMap().catch(err => console.error('[NewProvider] warmup failed:', err));
```

---

## Known Inconsistencies and Technical Debt

These are existing gaps to address before they spread to new providers.

| # | Location | Issue |
|---|----------|-------|
| 1 | `redvelvet/areas.js` lines 377–410 | `handleRedvelvetAreas` is defined here but the router imports from `redvelvet/areas-list.js`. The copy in `areas.js` is dead code and should be removed. |
| 2 | `redvelvet/areas.js` line 138 | `decodePlusSegment` is re-defined locally. The canonical copy is in `utils/normalize.js` — use that import instead. |
| 3 | `redvelvet/search.js` + `esa/search.js` | `pLimit` is copy-pasted verbatim in both files. Extract to `utils/async.js`. |
| 4 | `router.js` lines 108–114 | `/esa-profiles?` dispatch logic (nickname vs area) belongs in the handler, not the router. |
| 5 | `router.js` lines 61–65 | `/rv-auth-status` response is inline in the router. Should be a `handleRvAuthStatus` function in `redvelvet/auth.js`. |
| 6 | `constants.js` line 41 | `AREA_MAP_CACHE_TTL_MS` is a pointless alias for `CACHE_TTL_MS`. Use `CACHE_TTL_MS` everywhere. |
| 7 | `esa/profile-details.js` | ESA `ProfileDetail.profile` is missing `bust` (always `""`) and `tags` (always `[]`). Fields should be present but empty so both providers match the same shape. |
| 8 | `redvelvet/search.js` + `esa/search.js` lines for empty response | Empty-include early-return sends `{ count: 0, groups: [] }` — `groups` should be `profiles` to match the success response shape. |
| 9 | `redvelvet/profiles.js` | `handleRedvelvetProfileLookup` returns 501. Either implement it or remove the route from `router.js`. |
| 10 | `redvelvet/tag-profiles` response | Returns `beforeCount` (profiles before city filter) — implementation detail that should not be in the public response. |
