// ─── CONFIGURATION ────────────────────────────────────────────────────────

const BASE_URL = 'https://www.esa.co.za';
const PROXY    = 'https://api.allorigins.win/raw?url=';

// ─── DOM REFERENCES ───────────────────────────────────────────────────────

const searchBtn               = document.getElementById('searchBtn');
const profilesContainer       = document.getElementById('profiles-container');
const imagesContainer         = document.getElementById('images-container');
const profileDetailsContainer = document.getElementById('profile-details-container');

// ─── STATE ────────────────────────────────────────────────────────────────

let subIdArray   = [];
let profileLinks = [];

// ─── STATUS ───────────────────────────────────────────────────────────────

function setStatus(msg, isError = false) {
  const el = document.getElementById('status');
  el.innerHTML = msg;
  el.className = isError ? 'error' : '';
}

// ─── HELPERS ──────────────────────────────────────────────────────────────

/**
 * Extract a subId from an image src string.
 * Tries several URL patterns used by ESA:
 *   1. ?subid=123 or &subid=123
 *   2. ?uid=123
 *   3. ?picset_id=123
 *   4. A bare numeric path segment: /12345/ or /12345.jpg
 */
function extractSubId(src) {
  if (!src) return null;

  const patterns = [
    /[?&]subid=(\d+)/i,
    /[?&]uid=(\d+)/i,
    /[?&]picset_id=(\d+)/i,
    /\/(\d{4,})[\/\.]/,
  ];

  for (const pattern of patterns) {
    const match = src.match(pattern);
    if (match) return match[1];
  }

  return null;
}

/**
 * Fetch a URL through the CORS proxy and return a parsed DOM document.
 * Calls onError(err) on failure and onFinally() in either case.
 */
async function fetchViaProxy(url, onError, onFinally) {
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

// ─── CLEAR HELPERS ────────────────────────────────────────────────────────

function clearProfiles() {
  profilesContainer.innerHTML = '';
  profileLinks = [];
}

function clearImages() {
  imagesContainer.innerHTML = '';
}

function clearProfileDetails() {
  profileDetailsContainer.innerHTML = '';
}

// ─── SEARCH ENTRY POINTS ──────────────────────────────────────────────────

async function doSearch() {
  const query = document.getElementById('searchInput').value.trim();
  if (!query) {
    setStatus('Please enter a search term.', true);
    return;
  }

  clearProfiles();
  clearImages();
  clearProfileDetails();
  subIdArray = [];
  document.getElementById('selected-output').style.display = 'none';
  setStatus('<span class="spinner"></span>Fetching results…');
  searchBtn.disabled = true;

  if (/^\d+$/.test(query)) {
    await fetchImagesFromProfile(query);
  } else {
    await fetchProfilesByNickname(query);
  }
}

async function doAreaSearch() {
  const area = document.getElementById('areaInput').value.trim();
  if (!area) return;
  fetchProfilesByArea(area);
}

// ─── PROFILE FETCHING ─────────────────────────────────────────────────────

async function fetchImagesFromProfile(uid) {
  const url = `${BASE_URL}/escorts/viewEscort.php?uid=${encodeURIComponent(uid)}`;
  const doc = await fetchViaProxy(
    url,
    (err) => { setStatus(`Error: ${err.message}`, true); console.error(err); },
    ()    => { setStatus(''); searchBtn.disabled = false; },
  );

  if (!doc) return;

  const h1        = doc.querySelector('h1');
  const h1Anchor  = h1?.querySelector('a');
  const telAnchor = doc.querySelector('a[href^="tel:"]');
  const bodyText  = doc.body?.textContent ?? '';
  const ageMatch  = bodyText.match(/Age:\s*(\d+)/);

  const profile = {
    name:    doc.querySelector('h2')?.textContent.trim() ?? '',
    area:    h1?.textContent.trim() ?? '',
    areaUrl: h1Anchor ? BASE_URL + h1Anchor.getAttribute('href') : '',
    phone:   telAnchor?.textContent.trim() ?? '',
    age:     ageMatch?.[1] ?? '',
  };

  renderProfileDetails(profile);

  const imgs = Array.from(doc.querySelectorAll('img.photo, img.thumb-v'));

  if (imgs.length === 0) {
    setStatus('No targeted images found — trying all images for subId patterns…');
    processImages(Array.from(doc.querySelectorAll('img')));
  } else {
    processImages(imgs);
  }
}

async function fetchProfilesByNickname(nickname) {
  clearProfiles();
  const url = `${BASE_URL}/gallery.php?sp%5Bnickname%5D=${encodeURIComponent(nickname)}`;
  await processProfiles(url);
}

async function fetchProfilesByArea(area) {
  clearImages();
  clearProfiles();
  clearProfileDetails();

  const header = document.createElement('h2');
  header.className   = 'area-name';
  header.textContent = area;
  profilesContainer.appendChild(header);

  const url = `${BASE_URL}/gallery.php?&sp[city]=Cape+Town&sp[area]=${encodeURIComponent(area)}`;
  await processProfiles(url);
}

// ─── GALLERY PAGINATION ───────────────────────────────────────────────────

async function processProfiles(galleryUrl, pageNumber = 1) {
  setStatus(`<span class="spinner"></span>Fetching page ${pageNumber}…`);

  const doc = await fetchViaProxy(
    `${galleryUrl}&page=${pageNumber}`,
    (err) => { setStatus(`Error: ${err.message}`, true); console.error(err); },
    ()    => { searchBtn.disabled = false; },
  );

  if (!doc) return;

  const pageLinks = Array.from(doc.querySelectorAll('a[href^="/escorts/viewEscort.php"]'))
    .filter(a => a.getAttribute('href').includes('city=Cape+Town') && a.querySelector('img'));
  profileLinks.push(...pageLinks);

  const hasNextPage = Array.from(doc.querySelectorAll('a'))
    .some(a => a.textContent.trim() === 'Next »');

  if (hasNextPage) {
    await processProfiles(galleryUrl, pageNumber + 1);
  } else {
    setStatus('');
    renderProfileCards();
  }
}

// ─── RENDERING ────────────────────────────────────────────────────────────

function renderProfileCards() {
  profileLinks.forEach((a, index) => {
    const href     = a.getAttribute('href');
    const uidMatch = href.match(/uid=(\d+)/);
    if (!uidMatch) return;

    const uid      = uidMatch[1];
    const rawTitle = a.getAttribute('title') || a.textContent.trim();
    const label    = rawTitle.replace(/escorts in cape town\s*:?\s*/i, '').trim();
    const [namePart = '', numberPart = ''] = label.split(':').map(s => s.trim());

    const wrapper = document.createElement('div');
    wrapper.className = 'profile-card';
    wrapper.style.animationDelay = `${index * 50}ms`;

    const img = document.createElement('img');
    img.src          = a.querySelector('img').getAttribute('src') || '';
    img.alt          = label;
    img.title        = `Click to load images for uid ${uid}`;
    img.className    = 'profile-thumb';
    img.style.cursor = 'pointer';
    img.addEventListener('click', () => fetchImagesFromProfile(uid));

    const name = document.createElement('div');
    name.className   = 'profile-name';
    name.textContent = namePart;

    const number = document.createElement('div');
    number.className   = 'profile-number';
    number.textContent = numberPart;

    wrapper.append(img, name, number);
    profilesContainer.appendChild(wrapper);
  });
}

function renderProfileDetails(profile) {
  clearProfileDetails();

  const card = document.createElement('div');
  card.className = 'profile-details-card';

  const name = document.createElement('h2');
  name.className   = 'profile-details-name';
  name.textContent = profile.name;

  const areaBtn = document.createElement('button');
  areaBtn.className   = 'profile-details-area';
  areaBtn.textContent = profile.area;
  areaBtn.title       = 'Browse this area';
  areaBtn.disabled    = !profile.areaUrl;
  if (profile.areaUrl) {
    areaBtn.addEventListener('click', () => fetchProfilesByArea(profile.area));
  }

  card.append(name, areaBtn);

  if (profile.age) {
    const age = document.createElement('span');
    age.className   = 'profile-details-meta';
    age.textContent = `Age: ${profile.age}`;
    card.appendChild(age);
  }

  if (profile.phone) {
    const phone = document.createElement('a');
    phone.className   = 'profile-details-meta profile-details-phone';
    phone.href        = `tel:${profile.phone}`;
    phone.textContent = profile.phone;
    card.appendChild(phone);
  }

  profileDetailsContainer.appendChild(card);
}

function renderImages() {
  clearImages();

  let slot = 0;
  subIdArray.forEach(id => {
    for (let i = 1; i <= 6; i++) {
      const img = document.createElement('img');
      img.alt   = `subId ${id} pic ${i}`;
      img.src   = `https://goldmember.esa.co.za//picserver.php?type=picsets&subid=${id}&picnum=${i}&size=medium`;
      img.className = 'masonry-img';
      img.style.animationDelay = `${slot * 60}ms`;
      img.onerror = function () {
        const smallSrc = img.src.replace('size=medium', 'size=small');
        if (this.src !== smallSrc) this.src = smallSrc;
      };
      imagesContainer.appendChild(img);
      slot++;
    }
  });
}

// ─── IMAGE PROCESSING ─────────────────────────────────────────────────────

function processImages(imgs) {
  const seen = new Set();
  subIdArray = [];

  imgs.forEach(img => {
    const id = extractSubId(img.getAttribute('data-original') ?? '');
    if (id && !seen.has(id)) {
      seen.add(id);
      subIdArray.push(id);
    }
  });

  // Scroll to the images section first, then render once the scroll has settled
  profileDetailsContainer.scrollIntoView({ behavior: 'smooth' });
  setTimeout(renderImages, 500);
}

// ─── EVENT LISTENERS ──────────────────────────────────────────────────────

document.getElementById('searchInput')
  .addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });

document.getElementById('areaInput')
  .addEventListener('keydown', e => { if (e.key === 'Enter') doAreaSearch(); });
