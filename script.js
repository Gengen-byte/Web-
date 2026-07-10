'use strict';

/* =========================================================
   みんツジ - みんなのツジドウ プロトタイプ
   ========================================================= */

const STORAGE_KEY = 'mintsuji_posts_v1';
const EXPIRY_MS = 24 * 60 * 60 * 1000; // 24時間でタイムカプセル消滅
const TSUJIDO_CENTER = [35.3331, 139.4459];

/* ---------- 安全フィルター ---------- */

function checkSafety(text) {
  const bannedWords = ['空き家', '抜け道', '空き巣', '泥棒', '放火', '殺す', '死ね'];
  for (const w of bannedWords) {
    if (text.includes(w)) {
      return { ok: false, reason: `不適切な単語「${w}」が含まれているため投稿できません。` };
    }
  }

  const patterns = [
    { re: /0\d{1,4}[-‐−ー]?\d{1,4}[-‐−ー]?\d{3,4}/, reason: '電話番号と思われる情報が含まれているため投稿できません。' },
    { re: /〒?\s?\d{3}[-‐−ー]\d{4}/, reason: '郵便番号・住所と思われる情報が含まれているため投稿できません。' },
    { re: /\d{1,4}丁目(\d{1,4}番地?)?(\d{1,4}号)?/, reason: '住所（丁目・番地）と思われる情報が含まれているため投稿できません。' },
    { re: /[一-龠]{1,4}(県|都|府)[一-龠ぁ-ゔ]{2,10}(市|区|町|村)/, reason: '住所と思われる情報が含まれているため投稿できません。' },
    { re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, reason: 'メールアドレスと思われる情報が含まれているため投稿できません。' },
    { re: /[一-龠々ぁ-ゔァ-ヴー]{2,6}(さん|様|くん|君|氏|ちゃん)/, reason: '個人名と思われる情報が含まれているため投稿できません。' },
  ];

  for (const { re, reason } of patterns) {
    if (re.test(text)) return { ok: false, reason };
  }

  return { ok: true };
}

/* ---------- localStorage 永続化 ---------- */

function loadPosts() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    console.warn('投稿データの読み込みに失敗しました', e);
    return [];
  }
}

function savePosts() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(posts));
}

let posts = loadPosts();

function pruneExpired() {
  const now = Date.now();
  const before = posts.length;
  posts = posts.filter((p) => now - p.createdAt < EXPIRY_MS);
  if (posts.length !== before) savePosts();
}

/* ---------- 表示ヘルパー ---------- */

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function ageAlpha(createdAt) {
  const ageHours = (Date.now() - createdAt) / 3600000;
  if (ageHours < 1) return 0.95;   // 0〜1時間: 不透明度（高）
  if (ageHours < 6) return 0.72;   // 1〜6時間: 不透明度（中）
  if (ageHours < 12) return 0.48;  // 6〜12時間: 不透明度（低）
  return 0.24;                     // 12〜24時間: 不透明度（ごく低）
}

function formatElapsed(createdAt) {
  const mins = Math.floor((Date.now() - createdAt) / 60000);
  if (mins < 1) return 'たった今';
  if (mins < 60) return `${mins}分前`;
  const hours = Math.floor(mins / 60);
  return `${hours}時間前`;
}

function popupHtml(post) {
  const alpha = ageAlpha(post.createdAt);
  const bg = `rgba(163, 216, 244, ${alpha})`;
  return `
    <div class="mintsuji-popup" style="background:${bg}">
      <p class="popup-text">${escapeHtml(post.text)}</p>
      <div class="popup-meta">${formatElapsed(post.createdAt)}に投稿</div>
      <div class="popup-reactions">
        <button class="reaction-btn" data-id="${post.id}" data-type="hokkori">😊 <span class="reaction-count">${post.reactions.hokkori}</span></button>
        <button class="reaction-btn" data-id="${post.id}" data-type="iine">🌊 <span class="reaction-count">${post.reactions.iine}</span></button>
      </div>
    </div>
  `;
}

/* ---------- 地図初期化 ---------- */

const map = L.map('map', { zoomControl: false }).setView(TSUJIDO_CENTER, 15);
L.control.zoom({ position: 'topright' }).addTo(map);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; OpenStreetMap contributors',
  maxZoom: 19,
}).addTo(map);

const pinIcon = L.divIcon({
  className: '',
  html: '<div class="mintsuji-pin">📍</div>',
  iconSize: [30, 30],
  iconAnchor: [15, 28],
  popupAnchor: [0, -24],
});

const markersById = new Map();

function attachReactionHandlers(marker, postId) {
  const el = marker.getPopup().getElement();
  if (!el) return;
  el.querySelectorAll('.reaction-btn').forEach((btn) => {
    btn.onclick = () => reactToPost(postId, btn.dataset.type);
  });
}

function reactToPost(id, type) {
  const post = posts.find((p) => p.id === id);
  if (!post) return;
  post.reactions[type] += 1;
  savePosts();
  const marker = markersById.get(id);
  if (marker) {
    marker.setPopupContent(popupHtml(post));
    attachReactionHandlers(marker, id);
  }
}

function addMarker(post) {
  const marker = L.marker([post.lat, post.lng], { icon: pinIcon }).addTo(map);
  marker.bindPopup(popupHtml(post));
  marker.on('popupopen', () => attachReactionHandlers(marker, post.id));
  markersById.set(post.id, marker);
}

function renderAll() {
  markersById.forEach((m) => map.removeLayer(m));
  markersById.clear();
  posts.forEach(addMarker);
}

/* ---------- タイムカプセル：定期更新 ---------- */

function refreshCapsules() {
  const beforeIds = new Set(posts.map((p) => p.id));
  pruneExpired();
  const afterIds = new Set(posts.map((p) => p.id));

  beforeIds.forEach((id) => {
    if (!afterIds.has(id)) {
      const marker = markersById.get(id);
      if (marker) {
        map.removeLayer(marker);
        markersById.delete(id);
      }
    }
  });

  markersById.forEach((marker, id) => {
    const post = posts.find((p) => p.id === id);
    if (post && marker.isPopupOpen()) {
      marker.setPopupContent(popupHtml(post));
      attachReactionHandlers(marker, id);
    }
  });
}

setInterval(refreshCapsules, 60 * 1000);

/* ---------- トースト通知 ---------- */

const toast = document.getElementById('toast');
let toastTimer = null;

function showToast(message) {
  toast.textContent = message;
  toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 4000);
}

/* ---------- 現在地から投稿 ---------- */

const locateBtn = document.getElementById('locate-btn');
let currentLocationMarker = null;

const currentLocationIcon = L.divIcon({
  className: '',
  html: '<div class="current-location-dot"></div>',
  iconSize: [16, 16],
  iconAnchor: [8, 8],
});

function showCurrentLocationMarker(latlng) {
  if (currentLocationMarker) {
    currentLocationMarker.setLatLng(latlng);
  } else {
    currentLocationMarker = L.marker(latlng, { icon: currentLocationIcon, interactive: false, zIndexOffset: -100 }).addTo(map);
  }
}

function handleLocateClick() {
  if (!navigator.geolocation) {
    showToast('お使いの端末は現在地の取得に対応していません。');
    return;
  }

  locateBtn.disabled = true;
  locateBtn.classList.add('loading');

  navigator.geolocation.getCurrentPosition(
    (position) => {
      locateBtn.disabled = false;
      locateBtn.classList.remove('loading');

      const latlng = L.latLng(position.coords.latitude, position.coords.longitude);
      showCurrentLocationMarker(latlng);
      map.flyTo(latlng, Math.max(map.getZoom(), 17));
      openModal(latlng);
    },
    (error) => {
      locateBtn.disabled = false;
      locateBtn.classList.remove('loading');

      let message = '現在地を取得できませんでした。';
      if (error.code === error.PERMISSION_DENIED) {
        message = '位置情報の利用が許可されていません。端末の設定をご確認ください。';
      } else if (error.code === error.TIMEOUT) {
        message = '現在地の取得がタイムアウトしました。もう一度お試しください。';
      }
      showToast(message);
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
  );
}

locateBtn.addEventListener('click', handleLocateClick);

/* ---------- 投稿モーダル ---------- */

const modal = document.getElementById('post-modal');
const postText = document.getElementById('post-text');
const charCount = document.getElementById('char-count');
const postError = document.getElementById('post-error');
const postCancel = document.getElementById('post-cancel');
const postSubmit = document.getElementById('post-submit');

let pendingLatLng = null;

function showError(message) {
  postError.textContent = message;
  postError.classList.remove('hidden');
}

function hideError() {
  postError.classList.add('hidden');
}

function openModal(latlng) {
  pendingLatLng = latlng;
  postText.value = '';
  charCount.textContent = '0';
  hideError();
  modal.classList.remove('hidden');
  postText.focus();
}

function closeModal() {
  modal.classList.add('hidden');
  pendingLatLng = null;
}

map.on('click', (e) => openModal(e.latlng));

postText.addEventListener('input', () => {
  charCount.textContent = String(postText.value.length);
});

postCancel.addEventListener('click', closeModal);

modal.addEventListener('click', (e) => {
  if (e.target === modal) closeModal();
});

postSubmit.addEventListener('click', () => {
  const text = postText.value.trim();

  if (!text) {
    showError('メッセージを入力してください。');
    return;
  }
  if (!pendingLatLng) {
    showError('地図上の場所を選択してください。');
    return;
  }

  const safety = checkSafety(text);
  if (!safety.ok) {
    showError(safety.reason);
    return;
  }

  const post = {
    id: `p_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    lat: pendingLatLng.lat,
    lng: pendingLatLng.lng,
    text,
    createdAt: Date.now(),
    reactions: { hokkori: 0, iine: 0 },
  };

  posts.push(post);
  savePosts();
  addMarker(post);
  closeModal();
});

/* ---------- 初期化 ---------- */

pruneExpired();
renderAll();
