import { IMAGE_RELAY_BASE_URL, STORAGE_KEYS } from './config.js';

// In-memory store — kept in sync with both localStorage (fallback) and server.
let _groups = null;

function relayBase() {
  return IMAGE_RELAY_BASE_URL.replace(/\/$/, '');
}

function fromLocalStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.profileGroups);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function toLocalStorage(groups) {
  localStorage.setItem(STORAGE_KEYS.profileGroups, JSON.stringify(groups));
}

async function pushToServer(groups) {
  try {
    await fetch(`${relayBase()}/profile-groups`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(groups),
    });
  } catch {
    // Server persistence is best-effort; localStorage remains the fallback.
  }
}

// Load from server on first call; fall back to localStorage if server is unavailable.
async function initGroups() {
  try {
    const res = await fetch(`${relayBase()}/profile-groups`);
    if (res.ok) {
      const data = await res.json();
      _groups = Array.isArray(data) ? data : [];
      toLocalStorage(_groups);
      return;
    }
  } catch { /* fall through */ }
  _groups = fromLocalStorage();
}

function getGroups() {
  if (_groups === null) _groups = fromLocalStorage();
  return _groups;
}

function saveGroups(groups) {
  _groups = groups;
  toLocalStorage(groups);
  pushToServer(groups);
}

function profileKey(provider, uid) {
  return `${provider}:${uid}`;
}

function findGroupForProfile(provider, uid) {
  const key = profileKey(provider, uid);
  return getGroups().find(g => g.members.some(m => profileKey(m.provider, m.uid) === key)) || null;
}

function createGroup(profileA, profileB) {
  const groups = getGroups();
  const id = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : String(Date.now());
  const toMember = p => ({
    provider: p.provider,
    uid: String(p.uid),
    name: p.name,
    area: p.area,
    thumbUrl: p.thumbUrl || '',
    profileUrl: p.profileUrl || '',
  });
  groups.push({ id, members: [toMember(profileA), toMember(profileB)], createdAt: Date.now() });
  saveGroups(groups);
  return id;
}

function addToGroup(groupId, profile) {
  const groups = getGroups();
  const group = groups.find(g => g.id === groupId);
  if (!group) return;
  const key = profileKey(profile.provider, String(profile.uid));
  if (group.members.some(m => profileKey(m.provider, m.uid) === key)) return;
  group.members.push({
    provider: profile.provider,
    uid: String(profile.uid),
    name: profile.name,
    area: profile.area,
    thumbUrl: profile.thumbUrl || '',
    profileUrl: profile.profileUrl || '',
  });
  saveGroups(groups);
}

function removeFromGroup(groupId, provider, uid) {
  let groups = getGroups();
  const group = groups.find(g => g.id === groupId);
  if (!group) return;
  const key = profileKey(provider, String(uid));
  group.members = group.members.filter(m => profileKey(m.provider, m.uid) !== key);
  if (group.members.length < 2) {
    groups = groups.filter(g => g.id !== groupId);
  }
  saveGroups(groups);
}

function mergeGroups(groupIdA, groupIdB) {
  const groups = getGroups();
  const a = groups.find(g => g.id === groupIdA);
  const b = groups.find(g => g.id === groupIdB);
  if (!a || !b) return;
  const existingKeys = new Set(a.members.map(m => profileKey(m.provider, m.uid)));
  b.members.forEach(m => {
    if (!existingKeys.has(profileKey(m.provider, m.uid))) a.members.push(m);
  });
  saveGroups(groups.filter(g => g.id !== groupIdB));
}

function getGroupMembers(groupId) {
  const group = getGroups().find(g => g.id === groupId);
  return group ? group.members : [];
}

export {
  initGroups,
  findGroupForProfile,
  createGroup,
  addToGroup,
  removeFromGroup,
  mergeGroups,
  getGroupMembers,
};
