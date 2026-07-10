import { IMAGE_RELAY_BASE_URL } from '../config.js';

export async function fetchRedvelvetProfilesByArea(area, deps) {
  const { setStatus } = deps;
  const relayBase = IMAGE_RELAY_BASE_URL.replace(/\/$/, '');
  const scrape = deps.scrapeMode ? '&scrape=true' : '';
  setStatus('<span class="spinner"></span>Fetching area profiles…');
  try {
    const res = await fetch(`${relayBase}/redvelvet-area-profiles?name=${encodeURIComponent(area)}&cityBucket=2${scrape}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    setStatus('');
    return data.profiles || [];
  } catch (err) {
    setStatus(`Error: ${err.message}`, true);
    return [];
  }
}

export async function fetchRedvelvetProfilesByNickname(nickname, deps) {
  const { setStatus } = deps;
  const relayBase = IMAGE_RELAY_BASE_URL.replace(/\/$/, '');
  const scrape = deps.scrapeMode ? '&scrape=true' : '';
  setStatus('<span class="spinner"></span>Searching…');
  try {
    const res = await fetch(`${relayBase}/redvelvet-nickname-search?nickname=${encodeURIComponent(nickname)}&cityBucket=2${scrape}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    setStatus('');
    return data.profiles || [];
  } catch (err) {
    setStatus(`Error: ${err.message}`, true);
    return [];
  }
}

