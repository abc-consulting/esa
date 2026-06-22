import { IMAGE_RELAY_BASE_URL } from '../config.js';

function relayBase() {
  return IMAGE_RELAY_BASE_URL.replace(/\/$/, '');
}

async function relayGet(path, deps) {
  const { setStatus, searchBtn } = deps;
  try {
    const res = await fetch(`${relayBase()}${path}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    setStatus(`Error: ${err.message}`, true);
    if (searchBtn) searchBtn.disabled = false;
    return null;
  }
}

function flattenGroups(data) {
  return (data.groups || []).flatMap(g => g.profiles || []);
}

export async function fetchEsaProfilesByNickname(nickname, deps) {
  const { setStatus } = deps;
  setStatus('<span class="spinner"></span>Fetching results…');
  const data = await relayGet(`/esa-profiles?nickname=${encodeURIComponent(nickname)}`, deps);
  if (!data) return [];
  setStatus('');
  return flattenGroups(data);
}

export async function fetchEsaProfilesByArea(area, deps) {
  const { setStatus } = deps;
  setStatus('<span class="spinner"></span>Fetching area results…');
  const data = await relayGet(`/esa-profiles?area=${encodeURIComponent(area)}`, deps);
  if (!data) return [];
  setStatus('');
  return flattenGroups(data);
}

export async function fetchEsaImagesFromProfile(uid, deps) {
  const { setStatus, searchBtn } = deps;
  setStatus('<span class="spinner"></span>Fetching profile…');
  if (searchBtn) searchBtn.disabled = true;

  let data;
  try {
    const res = await fetch(`${relayBase()}/esa-profile-details?id=${encodeURIComponent(uid)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
    if (data.error) throw new Error(data.error);
  } catch (err) {
    setStatus(`Error: ${err.message}`, true);
    if (searchBtn) searchBtn.disabled = false;
    return null;
  }

  if (searchBtn) searchBtn.disabled = false;
  return data;
}
