# ESA Server API — Endpoint Reports

Generated from source using the [`endpoint-report`](https://github.com/agabrie/claude-skills/tree/main/endpoint-report) skill.

---

## Table of Contents

| # | Method | Route | Handler |
|---|---|---|---|
| 1 | GET | `/image` | `middleware/image-relay.js` |
| 2 | GET | `/rv-auth-status` | `redvelvet/auth.js` |
| 3 | GET | `/redvelvet-area` | `redvelvet/areas.js` |
| 4 | GET | `/redvelvet-area-profiles` | `redvelvet/areas.js` |
| 5 | GET | `/redvelvet-areas` | `redvelvet/areas-list.js` |
| 6 | GET | `/redvelvet-tags` | `redvelvet/tags.js` |
| 7 | GET | `/redvelvet-tag-profiles` | `redvelvet/profiles.js` |
| 8 | GET | `/redvelvet-profile-details` | `redvelvet/profile-details.js` |
| 9 | GET | `/redvelvet-nickname-search` | `redvelvet/nickname-search.js` |
| 10 | POST | `/redvelvet-search` | `redvelvet/search.js` |
| 11 | GET | `/esa-areas` | `esa/areas-list.js` |
| 12 | GET | `/esa-profiles?nickname=` | `esa/profiles.js` |
| 13 | GET | `/esa-profiles?area=` | `esa/profiles.js` |
| 14 | GET | `/esa-profile-details` | `esa/profile-details.js` |
| 15 | POST | `/esa-search` | `esa/search.js` |
| 16 | GET | `/profile-groups` | `profile-groups.js` |
| 17 | POST | `/profile-groups` | `profile-groups.js` |
| 18 | GET | `/favorites` | `favorites.js` |
| 19 | POST | `/favorites` | `favorites.js` |

---

## 1. GET /image

**Handler:** `src/server/middleware/image-relay.js:handleImageRelay`

### Auth

None / public. No credentials required. The server enforces an allowlist of upstream hostnames instead.

### Input

| Field | Type | Constraints | Required |
|---|---|---|---|
| `url` | string (query) | Must be `http` or `https`. Hostname must be in `ALLOWED_IMAGE_HOSTS` (`redvelvet.co.za`, `esa.co.za`, `userfiles.esa.co.za`, `goldmember.esa.co.za`, etc.) | Yes |

```
GET /image?url=https%3A%2F%2Fredvelvet.co.za%2Fuploadimages%2Ffoo.jpg
```

### Logic flow

```mermaid
flowchart TD
    A[GET /image?url=encoded] --> B{url present and host in allowlist?}
    B -->|No| C[400 Invalid image URL]
    B -->|Yes| D[fetchUpstream with 15s timeout]
    D --> E{Response OK?}
    E -->|4xx and url has size= param| F[Substitute next smaller size and retry]
    F --> D
    E -->|Other non-OK| G[Return upstream status code as 502]
    E -->|OK| H{Content-Type is image or video?}
    H -->|No| I[415 Unsupported Media Type]
    H -->|Yes| J{Content-Length over 8 MB for image?}
    J -->|Yes| K[413 Image too large]
    J -->|No| L[Stream body to client]
    L --> M{Streamed bytes exceed 8 MB?}
    M -->|Yes| N[Destroy connection mid-stream]
    M -->|No| O[200 OK with media bytes]
```

### Responses

#### 200 OK — Media streamed successfully

Headers: `Content-Type: image/jpeg` (or appropriate type), `Cache-Control: public, max-age=3600`, `X-Relay-Source: <hostname>`

Body: raw image or video bytes.

#### 400 Bad Request — Missing or disallowed URL

```
Invalid image URL
```

#### 413 Request Entity Too Large — Image exceeds 8 MB

```
Image too large
```

#### 415 Unsupported Media Type — Upstream returned non-image/video content

```
Upstream response is not an image or video
```

#### 502 Bad Gateway — Upstream fetch failed, timed out, or returned an error status

```
Relay failed: <error message>
```

or

```
Upstream error: 503
```

### Dependencies

- `ALLOWED_IMAGE_HOSTS` constant — `redvelvet.co.za`, `www.redvelvet.co.za`, `esa.co.za`, `www.esa.co.za`, `userfiles.esa.co.za`, `goldmember.esa.co.za`
- `MAX_IMAGE_BYTES` = 8 MB cap (`constants.js`)
- `REQUEST_TIMEOUT_MS` = 15 s per upstream fetch
- Size fallback chain: `large → medium → small → thumb_blur`

---

## 2. GET /rv-auth-status

**Handler:** inline in `src/server/router.js` → `src/server/redvelvet/auth.js:getSessionCookie`

### Auth

None / public.

### Input

No query parameters.

```
GET /rv-auth-status
```

### Logic flow

```mermaid
flowchart TD
    A[GET /rv-auth-status] --> B[Call getSessionCookie]
    B --> C{sessionCookie cached in memory?}
    C -->|Yes| D[Return cached cookie]
    C -->|No and loginInProgress exists| E[Await in-flight login promise]
    C -->|No| F[GET login page - extract ASP.NET hidden fields]
    F --> G[POST credentials with full hidden field payload]
    G --> H{Set-Cookie present in response?}
    H -->|Yes| I[Cache cookie in memory]
    H -->|No| J[Return null]
    I --> D
    E --> D
    J --> K{cookie truthy?}
    D --> K
    K -->|Yes| L[200 loggedIn true with 40-char cookie prefix]
    K -->|No| M[200 loggedIn false]
```

### Responses

#### 200 OK — Session active

```json
{ "loggedIn": true, "cookie": "ASP.NET_SessionId=abc123xyz…" }
```

#### 200 OK — Not logged in

```json
{ "loggedIn": false, "cookie": null }
```

### Dependencies

- `redvelvet/auth.js` — two-step ASP.NET login; deduplicates concurrent login attempts
- `RV_EMAIL` / `RV_PASSWORD` environment variables
- `redvelvet.co.za/userlogin/login` — upstream login page
- `extractHiddenFields` (utils/html.js)

---

## 3. GET /redvelvet-area

**Handler:** `src/server/redvelvet/areas.js:handleRedvelvetAreaLookup`

### Auth

None / public.

### Input

| Field | Type | Constraints | Required |
|---|---|---|---|
| `name` | string (query) | Area name; normalized internally (lowercase, trimmed) | Yes |

```
GET /redvelvet-area?name=Sea+Point
```

### Logic flow

```mermaid
flowchart TD
    A[GET /redvelvet-area?name=] --> B{name present after trim?}
    B -->|No| C[400 Missing area name]
    B -->|Yes| D[buildRedvelvetAreaHashMap - served from 4h cache]
    D --> E[findAreaEntryByName - exact match then suffix-cleaned match then prefix match]
    E --> F{Entry found?}
    F -->|Yes| G[200 with url, area, areaId, cityBucket - Cache-Control 1h]
    F -->|No| H[200 with empty url - Cache-Control 5m]
```

### Responses

#### 200 OK — Area resolved

```json
{
  "url": "https://redvelvet.co.za/escorts/escorts_in_area/sea-point/123/2",
  "area": "sea point",
  "areaId": "123",
  "cityBucket": "2"
}
```

#### 200 OK — Area not found

```json
{ "url": "" }
```

#### 400 Bad Request

```json
{ "error": "Missing area name" }
```

#### 502 Bad Gateway — Area map fetch failed

```json
{ "error": "<message>" }
```

### Dependencies

- `buildRedvelvetAreaHashMap` — scrapes `redvelvet.co.za/escorts/escorts_in_area`, 4 h in-memory cache
- `normalizeAreaName` (utils/normalize.js)
- `findAreaEntryByName` — prefers `cityBucket=2`, falls back to first match

---

## 4. GET /redvelvet-area-profiles

**Handler:** `src/server/redvelvet/areas.js:handleRedvelvetAreaProfiles`

### Auth

None / public.

### Input

| Field | Type | Constraints | Required |
|---|---|---|---|
| `name` | string (query) | Area name | Yes |
| `cityBucket` | string (query) | City bucket to prefer when resolving the area; defaults to `"2"` | No |

```
GET /redvelvet-area-profiles?name=Sea+Point&cityBucket=2
```

### Logic flow

```mermaid
flowchart TD
    A[GET /redvelvet-area-profiles] --> B{name present?}
    B -->|No| C[400 Missing area name]
    B -->|Yes| D{areaProfileListCache hit within 4h?}
    D -->|Yes| E[Return cached profiles]
    D -->|No| F[buildRedvelvetAreaHashMap]
    F --> G[findAreaEntryByName]
    G --> H{Entry found?}
    H -->|No| I[Return empty profiles array]
    H -->|Yes| J[fetchRedvelvetProfilesWithPostback - GET page 1 then POST doPostBack up to 50 pages]
    J --> K[Store in areaProfileListCache for 4h]
    K --> L[flattenWithSameNumber - annotate profiles sharing same phone]
    E --> L
    I --> M[200 with area, areaUrl, count 0, profiles empty]
    L --> N[200 with area, areaUrl, count, profiles]
```

### Responses

#### 200 OK

```json
{
  "area": "sea point",
  "areaUrl": "https://redvelvet.co.za/escorts/escorts_in_area/sea-point/123/2",
  "count": 42,
  "profiles": [
    {
      "provider": "redvelvet",
      "uid": "99001",
      "name": "Jane",
      "area": "Sea Point",
      "profileUrl": "https://redvelvet.co.za/escorts/escorts_details/Jane/Sea-Point/99001",
      "thumbUrl": "https://redvelvet.co.za/uploadimages/jane.jpg",
      "phone": "0821234567",
      "profiles_with_same_number": []
    }
  ]
}
```

#### 400 Bad Request

```json
{ "error": "Missing area name" }
```

#### 502 Bad Gateway

```json
{ "error": "<message>" }
```

### Dependencies

- `buildRedvelvetAreaHashMap`, `fetchRedvelvetProfilesWithPostback` (`redvelvet/areas.js`)
- `flattenWithSameNumber` (`utils/groups.js`) — annotates `profiles_with_same_number`
- ASP.NET `__doPostBack` pagination — up to 50 pages, 45 s timeout per page
- `areaProfileListCache` — in-memory Map, 4 h TTL

---

## 5. GET /redvelvet-areas

**Handler:** `src/server/redvelvet/areas-list.js:handleRedvelvetAreas`

### Auth

None / public.

### Input

| Field | Type | Constraints | Required |
|---|---|---|---|
| `cityBucket` | string (query) | Filter to areas belonging to this bucket (e.g. `"2"`). Omit to return all. | No |

```
GET /redvelvet-areas?cityBucket=2
```

### Logic flow

```mermaid
flowchart TD
    A[GET /redvelvet-areas] --> B[buildRedvelvetAreaHashMap - 4h cache]
    B --> C{cityBucket provided?}
    C -->|Yes| D[Keep areas where at least one entry matches cityBucket]
    C -->|No| E[Keep all area names]
    D --> F[Sort alphabetically]
    E --> F
    F --> G[200 with cityBucket, count, areas]
```

### Responses

#### 200 OK

```json
{
  "cityBucket": "2",
  "count": 38,
  "areas": ["atlantic seaboard", "bellville", "cape town cbd"]
}
```

#### 502 Bad Gateway

```json
{ "error": "<message>" }
```

### Dependencies

- `buildRedvelvetAreaHashMap` (`redvelvet/areas.js`) — scrapes `redvelvet.co.za/escorts/escorts_in_area`, 4 h cache

---

## 6. GET /redvelvet-tags

**Handler:** `src/server/redvelvet/tags.js:handleRedvelvetTags`

### Auth

None / public.

### Input

No query parameters.

```
GET /redvelvet-tags
```

### Logic flow

```mermaid
flowchart TD
    A[GET /redvelvet-tags] --> B[buildRedvelvetTagHashMap - 4h cache]
    B --> C[Scrape fetish_escorts page for option elements]
    C --> D[Parse label and count from each option value and text]
    D --> E[Skip the catch-all All Tags entry]
    E --> F[Sort tags alphabetically by label]
    F --> G[200 with count and tags array]
```

### Responses

#### 200 OK

```json
{
  "count": 24,
  "tags": [
    { "label": "Asian", "url": "https://redvelvet.co.za/escorts/fetish_escorts?...", "count": 15 },
    { "label": "BDSM", "url": "https://redvelvet.co.za/escorts/fetish_escorts?...", "count": 8 }
  ]
}
```

#### 502 Bad Gateway

```json
{ "error": "<message>" }
```

### Dependencies

- `buildRedvelvetTagHashMap` — scrapes `redvelvet.co.za/escorts/fetish_escorts`, 4 h in-memory cache
- `normalizeTagName`, `stripTags`, `decodeHtmlEntities` utilities

---

## 7. GET /redvelvet-tag-profiles

**Handler:** `src/server/redvelvet/profiles.js:handleRedvelvetTagProfiles`

### Auth

None / public.

### Input

| Field | Type | Constraints | Required |
|---|---|---|---|
| `tag` | string (query) | Tag label to look up (e.g. `"Asian"`) | Required if `tagUrl` absent |
| `tagUrl` | string (query) | Direct `fetish_escorts` URL (bypasses tag map lookup) | Required if `tag` absent |
| `cityBucket` | string (query) | City bucket for area filtering; defaults to `"2"` | No |

```
GET /redvelvet-tag-profiles?tag=Asian&cityBucket=2
```

### Logic flow

```mermaid
flowchart TD
    A[GET /redvelvet-tag-profiles] --> B{tag or tagUrl present?}
    B -->|No| C[400 Missing tag or tagUrl]
    B -->|Yes| D[resolveRedvelvetTagUrl - exact then fuzzy match in tag map]
    D --> E{URL resolved?}
    E -->|No| F[200 empty profiles]
    E -->|Yes| G[fetchRedvelvetProfilesWithPostback up to 50 pages]
    G --> H[getAreaSetForCityBucket and buildRedvelvetAreaHashMap in parallel]
    H --> I[filterProfilesByCityBucket - remove profiles from other city buckets]
    I --> J[Load tag-overrides.json]
    J --> K{Any override UIDs missing from results?}
    K -->|Yes| L[fetchProfileStub for each missing UID]
    L --> M[Append stubs to filtered list]
    K -->|No| M
    M --> N[200 with tag, tagUrl, cityBucket, beforeCount, count, profiles]
```

### Responses

#### 200 OK

```json
{
  "tag": "Asian",
  "tagUrl": "https://redvelvet.co.za/escorts/fetish_escorts?...",
  "cityBucket": "2",
  "beforeCount": 35,
  "count": 28,
  "profiles": [
    {
      "provider": "redvelvet",
      "uid": "88001",
      "name": "Yuki",
      "area": "Sea Point",
      "profileUrl": "https://redvelvet.co.za/escorts/escorts_details/Yuki/Sea-Point/88001",
      "thumbUrl": "https://redvelvet.co.za/uploadimages/yuki.jpg",
      "phone": ""
    }
  ]
}
```

#### 200 OK — Tag not found

```json
{ "tag": "Unknown", "tagUrl": "", "cityBucket": "2", "beforeCount": 0, "count": 0, "profiles": [] }
```

#### 400 Bad Request

```json
{ "error": "Missing tag or tagUrl" }
```

#### 502 Bad Gateway

```json
{ "error": "<message>" }
```

### Dependencies

- `resolveRedvelvetTagUrl` (`redvelvet/tags.js`)
- `fetchRedvelvetProfilesWithPostback`, `filterProfilesByCityBucket`, `getAreaSetForCityBucket` (`redvelvet/areas.js`)
- `tag-overrides.json` — optional local file for manual UID additions per tag

---

## 8. GET /redvelvet-profile-details

**Handler:** `src/server/redvelvet/profile-details.js:handleRedvelvetProfileDetails`

### Auth

None / public. The server internally uses the RV session cookie (from `getSessionCookie`) when fetching upstream profile pages.

### Input

| Field | Type | Constraints | Required |
|---|---|---|---|
| `id` | string (query) | Numeric UID | Yes |

```
GET /redvelvet-profile-details?id=88001
```

### Logic flow

```mermaid
flowchart TD
    A[GET /redvelvet-profile-details?id=] --> B{id is numeric?}
    B -->|No| C[400 Missing or invalid id]
    B -->|Yes| D{detailCache hit within 4h?}
    D -->|Yes| E[Return cached result]
    D -->|No| F{metaCache hit for this uid?}
    F -->|Yes| G[Reuse cached meta - skip profile page re-fetch]
    F -->|No| H[fetchAuthenticated - GET profile page with session cookie]
    H --> I{Redirected to login page?}
    I -->|Yes| J[clearSessionCookie then retry without auth]
    I -->|No| K[parseProfileDetails - extract name area age bust phone tags images video link raw link]
    G --> L[Fetch video page and raw image page in parallel]
    K --> L
    L --> M[Merge images from profile page, raw page, and video page]
    M --> N[Store in detailCache for 4h]
    N --> O[200 with profile, images, videos - no-store]
    E --> O
```

### Responses

#### 200 OK

```json
{
  "profile": {
    "provider": "redvelvet",
    "uid": "88001",
    "name": "Yuki",
    "area": "Sea Point",
    "areaUrl": "https://redvelvet.co.za/escorts/escorts_in_area/sea-point/123/2",
    "thumbUrl": "https://redvelvet.co.za/uploadimages/yuki1.jpg",
    "profileUrl": "https://redvelvet.co.za/escorts/escorts_details/Yuki/Sea-Point/88001",
    "phone": "0821234567",
    "age": "25",
    "bust": "34C",
    "tags": ["Asian", "BDSM"]
  },
  "images": [
    "https://redvelvet.co.za/uploadimages/yuki1.jpg",
    "https://redvelvet.co.za/uploadimages/yuki2.jpg"
  ],
  "videos": ["https://redvelvet.co.za/selfies/up/yuki.mp4"]
}
```

#### 400 Bad Request

```json
{ "error": "Missing or invalid id param (must be numeric)" }
```

#### 502 Bad Gateway

```json
{ "error": "<message>" }
```

### Dependencies

- `redvelvet/auth.js:getSessionCookie` — session cookie for authenticated upstream fetches
- `metaCache` — in-memory Map, 4 h TTL (lightweight age/bust metadata)
- `detailCache` — in-memory Map, 4 h TTL (full profile with images/videos)
- `redvelvet.co.za` — profile detail page, video page (`/selfies/escort_videos/`), raw page (`/escorts/raw_escort_details/`)
- `buildRedvelvetAreaHashMap` — to resolve `areaUrl` from parsed area name

---

## 9. GET /redvelvet-nickname-search

**Handler:** `src/server/redvelvet/nickname-search.js:handleRedvelvetNicknameSearch`

### Auth

None / public.

### Input

| Field | Type | Constraints | Required |
|---|---|---|---|
| `nickname` | string (query) | Search term | Yes |
| `cityBucket` | string (query) | City bucket for filtering; defaults to `"2"` | No |

```
GET /redvelvet-nickname-search?nickname=Yuki&cityBucket=2
```

### Logic flow

```mermaid
flowchart TD
    A[GET /redvelvet-nickname-search] --> B{nickname present?}
    B -->|No| C[400 Missing nickname]
    B -->|Yes| D[getAreaSetForCityBucket and buildRedvelvetAreaHashMap in parallel]
    D --> E[GET redvelvet search page to capture ASP.NET hidden fields]
    E --> F[POST nickname with hidden field payload - 45s timeout]
    F --> G{HTTP 200?}
    G -->|No| H[Return empty profiles]
    G -->|Yes| I[parseRedvelvetAreaProfiles on result HTML]
    I --> J[filterProfilesByCityBucket]
    J --> K[flattenWithSameNumber]
    K --> L[200 with count and profiles - no-store]
    H --> M[200 count 0 profiles empty]
```

### Responses

#### 200 OK

```json
{
  "count": 2,
  "profiles": [
    {
      "provider": "redvelvet",
      "uid": "88001",
      "name": "Yuki",
      "area": "Sea Point",
      "profileUrl": "https://redvelvet.co.za/escorts/escorts_details/Yuki/Sea-Point/88001",
      "thumbUrl": "https://redvelvet.co.za/uploadimages/yuki.jpg",
      "phone": "",
      "profiles_with_same_number": []
    }
  ]
}
```

#### 400 Bad Request

```json
{ "error": "Missing nickname" }
```

#### 502 Bad Gateway

```json
{ "error": "<message>" }
```

### Dependencies

- `redvelvet.co.za/search/search` — ASP.NET WebForms search form
- `extractHiddenFields` (`utils/html.js`) — captures `__VIEWSTATE` and related fields
- `filterProfilesByCityBucket`, `buildRedvelvetAreaHashMap` (`redvelvet/areas.js`)
- `flattenWithSameNumber` (`utils/groups.js`)
- `POSTBACK_TIMEOUT_MS` = 45 s

---

## 10. POST /redvelvet-search

**Handler:** `src/server/redvelvet/search.js:handleRedvelvetSearch`

### Auth

None / public.

### Input (JSON body)

| Field | Type | Constraints | Required |
|---|---|---|---|
| `cityBucket` | string | Defaults to `"2"` | No |
| `areas.included` | string[] | Area names to union into result set | At least one of `areas.included` or `tags.included` required |
| `areas.excluded` | string[] | Area names to subtract from result set | No |
| `tags.included` | string[] | Tag labels to include | No |
| `tags.excluded` | string[] | Tag labels to subtract | No |
| `age.min` | number | Minimum age (triggers per-profile detail fetch) | No |
| `age.max` | number | Maximum age (triggers per-profile detail fetch) | No |
| `bust.band` | number | Exact band size e.g. `34` | No |
| `bust.cup` | string | Exact cup letter e.g. `"C"` | No |
| `bust.range.min` | number | Min bust volume index | No |
| `bust.range.max` | number | Max bust volume index | No |

```json
{
  "cityBucket": "2",
  "areas": { "included": ["Sea Point"], "excluded": [] },
  "tags": { "included": ["Asian"], "excluded": ["BDSM"] },
  "age": { "min": 20, "max": 30 },
  "bust": { "cup": "C" }
}
```

### Logic flow

```mermaid
flowchart TD
    A[POST /redvelvet-search] --> B{Valid JSON body?}
    B -->|No| C[400 Invalid JSON]
    B -->|Yes| D{Any included areas or tags?}
    D -->|No| E[200 count 0 empty]
    D -->|Yes| F[Split included tags into racial and non-racial]
    F --> G[Fetch area profiles, racial tag profiles, other tag profiles in parallel]
    G --> H[Build uid-to-profile map - area data wins over tag data]
    H --> I[Area union of UIDs]
    I --> J[Racial tags union then intersect with non-racial intersection]
    J --> K[Intersect tag UIDs with area UIDs to get finalUids]
    K --> L[Fetch excluded area and tag UID lists in parallel]
    L --> M[Subtract excluded UIDs from finalUids]
    M --> N{Age or bust filter or excluded tags active?}
    N -->|Yes| O[fetchProfileAgeAndBust for each profile - max 10 concurrent]
    O --> P[Filter by age range, bust volume, and tag-level exclusion]
    P --> Q[flattenWithSameNumber]
    N -->|No| Q
    Q --> R[200 with count and profiles - no-store]
```

### Responses

#### 200 OK

```json
{
  "count": 12,
  "profiles": [
    {
      "provider": "redvelvet",
      "uid": "88001",
      "name": "Yuki",
      "area": "Sea Point",
      "profileUrl": "...",
      "thumbUrl": "...",
      "phone": "",
      "profiles_with_same_number": []
    }
  ]
}
```

#### 200 OK — No includes provided

```json
{ "count": 0, "groups": [] }
```

#### 400 Bad Request

```json
{ "error": "Invalid JSON body" }
```

#### 502 Bad Gateway

```json
{ "error": "<message>" }
```

### Dependencies

- `getRedvelvetAreaProfiles`, `filterProfilesByCityBucket` (`redvelvet/areas.js`)
- `resolveRedvelvetTagUrl` (`redvelvet/tags.js`)
- `fetchProfileAgeAndBust` (`redvelvet/profile-details.js`) — fetches meta detail page per profile when age/bust filter active; capped at 10 concurrent
- `RACIAL_TAGS` = `{ Asian, Black, Coloured, Indian, White }` — unioned rather than intersected
- `tagProfileCache` — in-memory Map, 4 h TTL
- `flattenWithSameNumber` (`utils/groups.js`)

---

## 11. GET /esa-areas

**Handler:** `src/server/esa/areas-list.js:handleEsaAreas`

### Auth

None / public.

### Input

No query parameters.

```
GET /esa-areas
```

### Logic flow

```mermaid
flowchart TD
    A[GET /esa-areas] --> B[buildEsaAreaHashMap - 4h cache]
    B --> C[Scrape esa.co.za category page for gallery.php area hrefs]
    C --> D[Normalize and deduplicate area names]
    D --> E[Sort alphabetically]
    E --> F[200 with count and areas - Cache-Control 1h]
```

### Responses

#### 200 OK

```json
{
  "count": 25,
  "areas": ["Atlantic Seaboard", "Bellville", "Cape Town CBD"]
}
```

#### 502 Bad Gateway

```json
{ "error": "<message>" }
```

### Dependencies

- `buildEsaAreaHashMap` (`esa/areas.js`) — scrapes `www.esa.co.za/category.php?sp[city]=Cape Town`, 4 h cache
- `normalizeAreaName` (`utils/normalize.js`)

---

## 12. GET /esa-profiles?nickname=

**Handler:** `src/server/esa/profiles.js:handleEsaProfilesByNickname`

### Auth

None / public. Upstream ESA fetches go through `corsproxy.io`.

### Input

| Field | Type | Constraints | Required |
|---|---|---|---|
| `nickname` | string (query) | Search term | Yes |

```
GET /esa-profiles?nickname=Yuki
```

### Logic flow

```mermaid
flowchart TD
    A[GET /esa-profiles?nickname=] --> B{nickname present?}
    B -->|No| C[400 nickname required]
    B -->|Yes| D[Build gallery URL with nickname and city=Cape Town]
    D --> E[fetchEsaProfiles - GET page 1]
    E --> F{Contains Next link?}
    F -->|Yes and under 50 pages| G[Fetch next page]
    G --> F
    F -->|No or 50 pages reached| H[Deduplicate by uid]
    H --> I[flattenWithSameNumber]
    I --> J[200 with count and profiles - no-store]
```

### Responses

#### 200 OK

```json
{
  "count": 3,
  "profiles": [
    {
      "provider": "esa",
      "uid": "12345",
      "name": "Yuki",
      "area": "Sea Point",
      "profileUrl": "https://www.esa.co.za/escorts/viewEscort.php?uid=12345",
      "thumbUrl": "https://www.esa.co.za/client/gallery/srv.php?...",
      "phone": "0821234567",
      "profiles_with_same_number": []
    }
  ]
}
```

#### 400 Bad Request

```json
{ "error": "nickname required" }
```

#### 502 Bad Gateway

```json
{ "error": "<message>" }
```

### Dependencies

- `fetchEsaProfiles` (`esa/profiles.js`) — paginates via `Next »` link, up to 50 pages
- `ESA_GALLERY_URL` = `https://www.esa.co.za/gallery.php`
- `corsproxy.io` — CORS proxy used by `fetchText`
- `flattenWithSameNumber` (`utils/groups.js`)

---

## 13. GET /esa-profiles?area=

**Handler:** `src/server/esa/profiles.js:handleEsaProfilesByArea`

### Auth

None / public.

### Input

| Field | Type | Constraints | Required |
|---|---|---|---|
| `area` | string (query) | Area name | Yes |

```
GET /esa-profiles?area=Sea+Point
```

### Logic flow

```mermaid
flowchart TD
    A[GET /esa-profiles?area=] --> B{area present?}
    B -->|No| C[400 area required]
    B -->|Yes| D[Build gallery URL with area and city=Cape Town]
    D --> E[fetchEsaProfiles - paginate up to 50 pages via Next link]
    E --> F[Deduplicate by uid]
    F --> G[flattenWithSameNumber]
    G --> H[200 with count and profiles - no-store]
```

### Responses

#### 200 OK

```json
{
  "count": 18,
  "profiles": [
    {
      "provider": "esa",
      "uid": "12345",
      "name": "Yuki",
      "area": "Sea Point",
      "profileUrl": "https://www.esa.co.za/escorts/viewEscort.php?uid=12345",
      "thumbUrl": "https://www.esa.co.za/client/gallery/srv.php?...",
      "phone": "",
      "profiles_with_same_number": []
    }
  ]
}
```

#### 400 Bad Request

```json
{ "error": "area required" }
```

#### 502 Bad Gateway

```json
{ "error": "<message>" }
```

### Dependencies

- `fetchEsaProfiles` (`esa/profiles.js`) — paginates up to 50 pages
- `ESA_GALLERY_URL`
- `flattenWithSameNumber` (`utils/groups.js`)

---

## 14. GET /esa-profile-details

**Handler:** `src/server/esa/profile-details.js:handleEsaProfileDetails`

### Auth

None / public.

### Input

| Field | Type | Constraints | Required |
|---|---|---|---|
| `id` | string (query) | Numeric UID | Yes |

```
GET /esa-profile-details?id=12345
```

### Logic flow

```mermaid
flowchart TD
    A[GET /esa-profile-details?id=] --> B{id is numeric?}
    B -->|No| C[400 id must be numeric]
    B -->|Yes| D{detailCache hit within 4h?}
    D -->|Yes| E[Return cached data]
    D -->|No| F[fetchText ESA viewEscort.php via corsproxy.io]
    F --> G[parseEsaProfileDetails - extract name area age phone]
    G --> H[Extract gallery srv.php URLs - normalise all to size=large]
    H --> I[Extract subid ranges and expand into picserver.php URLs]
    I --> J[Store in detailCache for 4h]
    J --> K[200 with profile, images, videos empty - no-store]
    E --> K
```

### Responses

#### 200 OK

```json
{
  "profile": {
    "provider": "esa",
    "uid": "12345",
    "name": "Yuki",
    "area": "Sea Point",
    "areaUrl": "https://www.esa.co.za/gallery.php?sp[area]=Sea+Point",
    "thumbUrl": "https://www.esa.co.za/client/gallery/srv.php?type=thumb&...",
    "profileUrl": "https://www.esa.co.za/escorts/viewEscort.php?uid=12345",
    "phone": "0821234567",
    "age": "25"
  },
  "images": [
    "https://www.esa.co.za/client/gallery/srv.php?type=photo&size=large",
    "https://goldmember.esa.co.za/picserver.php?type=picsets&subid=999&picnum=1&size=large"
  ],
  "videos": []
}
```

#### 400 Bad Request

```json
{ "error": "id must be numeric" }
```

#### 502 Bad Gateway

```json
{ "error": "<message>" }
```

### Dependencies

- `fetchText` (`utils/http.js`) — fetches via CORS proxy
- `detailCache` — in-memory Map, 4 h TTL
- `www.esa.co.za` — profile page
- `goldmember.esa.co.za/picserver.php` — expanded per-subid image URLs

---

## 15. POST /esa-search

**Handler:** `src/server/esa/search.js:handleEsaSearch`

### Auth

None / public.

### Input (JSON body)

| Field | Type | Constraints | Required |
|---|---|---|---|
| `areas.included` | string[] | Area names to union | At least one include required (unless `nickname` given) |
| `areas.excluded` | string[] | Area names to subtract | No |
| `nickname` | string | Nickname search term; when present, replaces area-union fetch | No |

```json
{
  "areas": { "included": ["Sea Point", "Green Point"], "excluded": ["Bellville"] }
}
```

or with nickname:

```json
{ "nickname": "Yuki", "areas": { "included": ["Sea Point"] } }
```

### Logic flow

```mermaid
flowchart TD
    A[POST /esa-search] --> B{Valid JSON body?}
    B -->|No| C[400 Invalid JSON]
    B -->|Yes| D{nickname or included areas present?}
    D -->|No| E[200 count 0]
    D -->|Yes and nickname| F[fetchEsaProfiles with nickname URL]
    F --> G{includedAreas also given?}
    G -->|Yes| H[Filter results to profiles matching included areas]
    G -->|No| I[Use all nickname results]
    H --> J[Subtract excludedAreas]
    I --> J
    D -->|Yes and areas only| K[fetchEsaProfiles per area - max 4 concurrent]
    K --> L[Union profiles by uid]
    L --> J
    J --> M[flattenWithSameNumber]
    M --> N[200 with count and profiles - no-store]
```

### Responses

#### 200 OK

```json
{
  "count": 22,
  "profiles": [
    {
      "provider": "esa",
      "uid": "12345",
      "name": "Yuki",
      "area": "Sea Point",
      "profileUrl": "...",
      "thumbUrl": "...",
      "phone": "",
      "profiles_with_same_number": []
    }
  ]
}
```

#### 200 OK — No includes provided

```json
{ "count": 0, "groups": [] }
```

#### 400 Bad Request

```json
{ "error": "Invalid JSON body" }
```

#### 502 Bad Gateway

```json
{ "error": "<message>" }
```

### Dependencies

- `fetchEsaProfiles` (`esa/profiles.js`) — concurrency limited to 4 via inline `pLimit`
- `normalizeAreaName` (`utils/normalize.js`)
- `flattenWithSameNumber` (`utils/groups.js`)
- `ESA_GALLERY_URL`

---

## 16. GET /profile-groups

**Handler:** `src/server/profile-groups.js:handleGetProfileGroups`

### Auth

None / public (local server only — not exposed externally).

### Input

No parameters.

```
GET /profile-groups
```

### Logic flow

```mermaid
flowchart TD
    A[GET /profile-groups] --> B[readGroups - fs.readFileSync data/profile-groups.json]
    B --> C{File exists and parses as array?}
    C -->|Yes| D[Return parsed array]
    C -->|No or error| E[Return empty array]
    D --> F[200 with JSON array]
    E --> F
```

### Responses

#### 200 OK — Has groups

```json
[
  { "name": "Favourites Group 1", "links": ["https://redvelvet.co.za/..."] }
]
```

#### 200 OK — No file or parse error

```json
[]
```

### Dependencies

- `data/profile-groups.json` — local filesystem (created on first POST)

---

## 17. POST /profile-groups

**Handler:** `src/server/profile-groups.js:handleSaveProfileGroups`

### Auth

None / public (local server only).

### Input (JSON body)

| Field | Type | Constraints | Required |
|---|---|---|---|
| body | array | Must be a valid JSON array | Yes |

```json
[{ "name": "Group 1", "links": ["https://redvelvet.co.za/..."] }]
```

### Logic flow

```mermaid
flowchart TD
    A[POST /profile-groups] --> B[Accumulate body chunks]
    B --> C{Valid JSON?}
    C -->|No| D[400 Invalid JSON]
    C -->|Yes| E{Parsed value is array?}
    E -->|No| F[400 Expected an array]
    E -->|Yes| G[writeGroups - mkdirSync if needed then writeFileSync]
    G --> H{Write succeeded?}
    H -->|No| I[500 error message]
    H -->|Yes| J[200 ok true]
```

### Responses

#### 200 OK

```json
{ "ok": true }
```

#### 400 Bad Request — Invalid JSON

```json
{ "error": "Invalid JSON" }
```

#### 400 Bad Request — Not an array

```json
{ "error": "Expected an array" }
```

#### 500 Internal Server Error

```json
{ "error": "<message>" }
```

### Dependencies

- `data/profile-groups.json` — local filesystem; `data/` directory created automatically if absent

---

## 18. GET /favorites

**Handler:** `src/server/favorites.js:handleGetFavorites`

### Auth

None / public (local server only).

### Input

No parameters.

```
GET /favorites
```

### Logic flow

```mermaid
flowchart TD
    A[GET /favorites] --> B[readFavorites - fs.readFileSync data/favorites.json]
    B --> C{File exists and parses as object?}
    C -->|Yes| D[Return parsed object]
    C -->|No or error| E[Return empty object]
    D --> F[200 with JSON object]
    E --> F
```

### Responses

#### 200 OK — Has favorites

```json
{
  "esa": {
    "12345": { "uid": "12345", "name": "Yuki", "provider": "esa" }
  },
  "redvelvet": {}
}
```

#### 200 OK — No file or parse error

```json
{}
```

### Dependencies

- `data/favorites.json` — local filesystem (created on first POST)

---

## 19. POST /favorites

**Handler:** `src/server/favorites.js:handleSaveFavorites`

### Auth

None / public (local server only).

### Input (JSON body)

| Field | Type | Constraints | Required |
|---|---|---|---|
| body | object | Must be a JSON plain object (not array, not null) | Yes |

```json
{
  "esa": { "12345": { "uid": "12345", "name": "Yuki", "provider": "esa" } },
  "redvelvet": {}
}
```

### Logic flow

```mermaid
flowchart TD
    A[POST /favorites] --> B[Accumulate body chunks]
    B --> C{Valid JSON?}
    C -->|No| D[400 Invalid JSON]
    C -->|Yes| E{Value is plain object and not array and not null?}
    E -->|No| F[400 Expected an object]
    E -->|Yes| G[writeFavorites - mkdirSync if needed then writeFileSync]
    G --> H{Write succeeded?}
    H -->|No| I[500 error message]
    H -->|Yes| J[200 ok true]
```

### Responses

#### 200 OK

```json
{ "ok": true }
```

#### 400 Bad Request — Invalid JSON

```json
{ "error": "Invalid JSON" }
```

#### 400 Bad Request — Not a plain object

```json
{ "error": "Expected an object" }
```

#### 500 Internal Server Error

```json
{ "error": "<message>" }
```

### Dependencies

- `data/favorites.json` — local filesystem; `data/` directory created automatically if absent
