import { PROXY } from './config.js';

export async function fetchViaProxy(url, onError, onFinally) {
  try {
    const response = await fetch(PROXY + encodeURIComponent(url));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const html = await response.text();
    if (!html) throw new Error('Empty response from proxy.');
    return new DOMParser().parseFromString(html, 'text/html');
  } catch (err) {
    onError(err);
  } finally {
    onFinally();
  }
}
