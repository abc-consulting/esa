# Tech Debt Backlog

Identified during architecture review. Each item is self-contained — work them in any order on a branch off master.

## Checklist

- [ ] **1. Dead handler in `redvelvet/areas.js`**  
  `handleRedvelvetAreas` (lines 377–410) is defined in `src/server/redvelvet/areas.js` but the router imports from `redvelvet/areas-list.js`. Delete the dead copy from `areas.js` and remove it from that file's `module.exports`.

- [ ] **2. Duplicate `decodePlusSegment` in `areas.js`**  
  `src/server/redvelvet/areas.js` line 138 re-defines `decodePlusSegment` locally. Import it from `src/server/utils/normalize.js` instead and delete the inline copy.

- [ ] **3. `pLimit` copy-pasted in both search files**  
  Identical implementation exists in `src/server/redvelvet/search.js` and `src/server/esa/search.js`. Extract to `src/server/utils/async.js` and import in both files.

- [ ] **4. `/esa-profiles?` dispatch logic in router**  
  `src/server/router.js` lines 108–114 inspect `searchParams` to route between `handleEsaProfilesByNickname` and `handleEsaProfilesByArea`. Move this dispatch into a single `handleEsaProfiles(req, res)` function in `src/server/esa/profiles.js` and call only that from the router.

- [ ] **5. `/rv-auth-status` response inline in router**  
  `src/server/router.js` lines 61–65 build and send the auth-status response directly. Extract to `handleRvAuthStatus(req, res)` in `src/server/redvelvet/auth.js`, export it, and import from there.

- [ ] **6. `AREA_MAP_CACHE_TTL_MS` redundant alias**  
  `src/server/constants.js` line 41 — `AREA_MAP_CACHE_TTL_MS` equals `CACHE_TTL_MS`. Replace all usages of `AREA_MAP_CACHE_TTL_MS` with `CACHE_TTL_MS` across `redvelvet/areas.js` and `redvelvet/tags.js`, then remove the alias from `constants.js`.

- [ ] **7. ESA `ProfileDetail.profile` missing `bust` and `tags` fields**  
  `src/server/esa/profile-details.js` `parseEsaProfileDetails` returns a profile without `bust` or `tags`. Both providers must conform to the same `ProfileDetail.profile` shape (see `docs/server-architecture.md`). Add `bust: ''` and `tags: []` to the ESA return value.

- [ ] **8. Empty-include early return uses `groups` key instead of `profiles`**  
  `src/server/redvelvet/search.js` and `src/server/esa/search.js` each have an early-return that sends `{ count: 0, groups: [] }`. Change `groups` to `profiles` to match the shape of every non-empty success response.

- [ ] **9. Stub 501 route for `/redvelvet-profile?`**  
  `src/server/redvelvet/profiles.js` `handleRedvelvetProfileLookup` always returns 501 Not Implemented. Either implement it (fetch a profile stub by UID using `fetchProfileStub`) or remove the route entry from `src/server/router.js`.

- [ ] **10. `beforeCount` implementation detail in tag-profiles response**  
  `src/server/redvelvet/profiles.js` `handleRedvelvetTagProfiles` includes `beforeCount` (profile count before city-bucket filtering) in the public response body. Remove this field — it is an internal diagnostic, not part of the API contract defined in `docs/server-architecture.md`.
