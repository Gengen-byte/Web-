'use strict';

/* =========================================================
   みんツジ - みんなのツジドウ プロトタイプ
   ========================================================= */

/* ---------- Firebase ---------- */

const firebaseConfig = {
  apiKey: "AIzaSyCUy27zgh1RzAm7Fr7Xggv71JgVsYHCjTA",
  authDomain: "mintsuji-3ce75.firebaseapp.com",
  projectId: "mintsuji-3ce75",
  storageBucket: "mintsuji-3ce75.firebasestorage.app",
  messagingSenderId: "240674296609",
  appId: "1:240674296609:web:685039729d31922bfca460",
};
firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
const auth = firebase.auth();
const postsCollection = db.collection('posts');

let currentUid = null;
const authReady = auth.signInAnonymously()
  .then(() => new Promise((resolve) => {
    const unsubscribe = auth.onAuthStateChanged((user) => {
      if (user) {
        currentUid = user.uid;
        unsubscribe();
        resolve();
      }
    });
  }))
  .catch((e) => {
    console.error('匿名認証に失敗しました', e);
    showToast('サーバーへの接続に失敗しました。時間をおいて再読み込みしてください。');
  });

const EXPIRY_MS = 24 * 60 * 60 * 1000; // 24時間でタイムカプセル消滅
const TSUJIDO_CENTER = [35.3331, 139.4459];
const TSUJIDO_BOUNDS = L.latLngBounds([35.315, 139.428], [35.351, 139.468]);
const POPULAR_THRESHOLD = 3; // このリアクション数から「人気ピン」演出
const HOT_THRESHOLD = 8;     // このリアクション数から「大人気ピン」演出

const CATEGORY_META = {
  normal: { emoji: '📝', label: '通常の投稿', expiryMs: EXPIRY_MS },
  new_shop: {
    emoji: '🎉', label: '新店オープン', expiryMs: EXPIRY_MS * 7, // 新店オープンは7日間表示
    bubbleClass: 'category-new-shop', tagBg: '#fff0f8', tagColor: '#c2447a',
    gradient: 'linear-gradient(135deg, #ffe3f3, #ffe9b8)',
  },
  notice: {
    emoji: '⚠️', label: 'お知らせ・注意', expiryMs: EXPIRY_MS, // 24時間で消滅
    bubbleClass: 'category-notice', tagBg: '#fff3d6', tagColor: '#8a5a00',
    gradient: 'linear-gradient(135deg, #ffe6b0, #ffcf7a)',
  },
  event: {
    emoji: '🎪', label: 'イベント', expiryMs: EXPIRY_MS, // 24時間で消滅
    bubbleClass: 'category-event', tagBg: '#eee7ff', tagColor: '#5b3ea8',
    gradient: 'linear-gradient(135deg, #d6c6ff, #aee0ff)',
  },
};

function categoryMeta(post) {
  return CATEGORY_META[post.category] || CATEGORY_META.normal;
}

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

/* ---------- 投稿データ（Firestoreで全端末共有） ---------- */

let posts = [];
const previousReactionTotals = new Map();

function pruneExpiredLocal() {
  const now = Date.now();
  const stillValid = [];
  posts.forEach((post) => {
    if (now >= post.expiresAt) {
      removeMarkerById(post.id);
      previousReactionTotals.delete(post.id);
      postsCollection.doc(post.id).delete().catch(() => {});
    } else {
      stillValid.push(post);
    }
  });
  posts = stillValid;
  updatePostCountBadge();
}

const postCountNumEl = document.getElementById('post-count-num');

function updatePostCountBadge() {
  if (postCountNumEl) postCountNumEl.textContent = posts.length;
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
  if (ageHours < 6) return 0.8;    // 1〜6時間: 不透明度（中）
  if (ageHours < 12) return 0.65;  // 6〜12時間: 不透明度（低）
  return 0.5;                      // 12〜24時間: 不透明度（低いが視認可能）
}

function formatElapsed(createdAt) {
  const mins = Math.floor((Date.now() - createdAt) / 60000);
  if (mins < 1) return 'たった今';
  if (mins < 60) return `${mins}分前`;
  const hours = Math.floor(mins / 60);
  return `${hours}時間前`;
}

function popupHtml(post) {
  const meta = categoryMeta(post);
  const isSpecial = post.category !== 'normal';
  const bg = isSpecial ? meta.gradient : `rgba(163, 216, 244, ${ageAlpha(post.createdAt)})`;
  const categoryTag = isSpecial
    ? `<div class="popup-category-tag" style="background:${meta.tagBg};color:${meta.tagColor}">${meta.emoji} ${meta.label}</div>`
    : '';
  const photoHtml = post.photo
    ? `<img class="popup-photo" src="${post.photo}" alt="投稿された写真">`
    : '';
  const deleteHtml = post.ownerId === currentUid
    ? `<button class="popup-delete-btn" data-id="${post.id}" aria-label="投稿を削除">🗑 削除</button>`
    : '';
  return `
    <div class="mintsuji-popup" style="background:${bg}">
      ${categoryTag}
      ${photoHtml}
      <p class="popup-text">${escapeHtml(post.text)}</p>
      <div class="popup-meta">${formatElapsed(post.createdAt)}に投稿</div>
      <div class="popup-reactions">
        <button class="reaction-btn" data-id="${post.id}" data-type="hokkori">😊 <span class="reaction-count">${post.reactions.hokkori}</span></button>
        <button class="reaction-btn" data-id="${post.id}" data-type="iine">🌊 <span class="reaction-count">${post.reactions.iine}</span></button>
        <button class="popup-share-btn" data-id="${post.id}" aria-label="投稿をシェア">📤 シェア</button>
        ${deleteHtml}
      </div>
    </div>
  `;
}

/* ---------- 地図初期化 ---------- */

const LIGHT_TILE_URL = 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png';
const DARK_TILE_URL = 'https://{s}.basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}{r}.png';

const map = L.map('map', {
  zoomControl: false,
  maxBounds: TSUJIDO_BOUNDS,
  maxBoundsViscosity: 1.0,
  minZoom: 14,
}).setView(TSUJIDO_CENTER, 15);
L.control.zoom({ position: 'topright' }).addTo(map);
const tileLayer = L.tileLayer(
  document.documentElement.classList.contains('dark-mode') ? DARK_TILE_URL : LIGHT_TILE_URL,
  {
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
    maxZoom: 20,
    subdomains: 'abcd',
  }
).addTo(map);

/* ---------- 周辺施設: 小学校・中学校 ---------- */

const SCHOOL_CACHE_KEY = 'mintsuji_schools_cache_v1';
const SCHOOL_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 学校情報は1週間キャッシュ

const SCHOOL_ICONS = {
  elementary: L.divIcon({
    className: '',
    html: '<div class="school-marker school-elementary">🏫</div>',
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  }),
  junior_high: L.divIcon({
    className: '',
    html: '<div class="school-marker school-junior-high">🎓</div>',
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  }),
};

function classifySchool(name) {
  if (!name) return null;
  if (name.includes('小学校')) return 'elementary';
  if (name.includes('中学校')) return 'junior_high';
  return null;
}

// Overpass APIが利用できない場合のオフライン用フォールバック
// (OpenStreetMapデータのスナップショット。最新でない可能性があります)
const FALLBACK_SCHOOLS = [
  { name: 'アレセイア湘南中学校', lat: 35.324695, lng: 139.432832, type: 'junior_high' },
  { name: '平和学園小学校', lat: 35.326325, lng: 139.432058, type: 'elementary' },
  { name: '藤沢市立湘洋中学校', lat: 35.3190165, lng: 139.4590629, type: 'junior_high' },
  { name: '藤沢市立高浜中学校', lat: 35.3244916, lng: 139.4485376, type: 'junior_high' },
  { name: '藤沢市立高砂小学校', lat: 35.3257723, lng: 139.4485095, type: 'elementary' },
  { name: '藤沢市立浜見小学校', lat: 35.3245112, lng: 139.4496742, type: 'elementary' },
  { name: '藤沢市立明治中学校', lat: 35.3410577, lng: 139.4558798, type: 'junior_high' },
  { name: '藤沢市立鵠南小学校', lat: 35.318393, lng: 139.4636069, type: 'elementary' },
  { name: '茅ヶ崎市立小和田小学校', lat: 35.3443428, lng: 139.4388225, type: 'elementary' },
  { name: '藤沢市立羽鳥小学校', lat: 35.3440553, lng: 139.4584052, type: 'elementary' },
  { name: '茅ヶ崎市立緑が浜小学校', lat: 35.3232281, lng: 139.4327106, type: 'elementary' },
  { name: '茅ケ崎市立汐見台小学校', lat: 35.3212986, lng: 139.437676, type: 'elementary' },
  { name: '藤沢市立辻堂小学校', lat: 35.3259651, lng: 139.457829, type: 'elementary' },
  { name: '藤沢市立明治小学校', lat: 35.3496988, lng: 139.4596714, type: 'elementary' },
  { name: '藤沢市立羽鳥中学校', lat: 35.3458511, lng: 139.4627096, type: 'junior_high' },
  { name: '藤沢市立八松小学校', lat: 35.3341378, lng: 139.4528244, type: 'elementary' },
  { name: '茅ヶ崎市立赤羽根中学校', lat: 35.3495763, lng: 139.4369142, type: 'junior_high' },
  { name: '茅ヶ崎市立松浪小学校', lat: 35.3312548, lng: 139.432797, type: 'elementary' },
  { name: '茅ヶ崎市立松林小学校', lat: 35.3443125, lng: 139.4278671, type: 'elementary' },
  { name: '茅ヶ崎市立松浪中学校', lat: 35.3288086, lng: 139.436111, type: 'junior_high' },
];

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const OVERPASS_RETRY_ATTEMPTS = 3;
const OVERPASS_RETRY_DELAY_MS = 800;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchOverpass(query) {
  const url = `${OVERPASS_URL}?data=${encodeURIComponent(query)}`;
  let lastError;

  for (let attempt = 1; attempt <= OVERPASS_RETRY_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (res.ok) return res.json();
      lastError = new Error(`Overpass API error: ${res.status}`);
    } catch (e) {
      lastError = e;
    }
    if (attempt < OVERPASS_RETRY_ATTEMPTS) await sleep(OVERPASS_RETRY_DELAY_MS * attempt);
  }
  throw lastError;
}

async function fetchSchools() {
  const b = TSUJIDO_BOUNDS;
  const bbox = `${b.getSouth()},${b.getWest()},${b.getNorth()},${b.getEast()}`;
  const query = `[out:json][timeout:25];(node["amenity"="school"](${bbox});way["amenity"="school"](${bbox});relation["amenity"="school"](${bbox}););out center;`;
  const data = await fetchOverpass(query);

  return data.elements
    .map((el) => {
      const lat = el.lat ?? el.center?.lat;
      const lng = el.lon ?? el.center?.lon;
      const name = el.tags?.name;
      const type = classifySchool(name);
      if (!lat || !lng || !type) return null;
      return { lat, lng, name, type };
    })
    .filter(Boolean);
}

async function loadSchools() {
  try {
    const cached = JSON.parse(localStorage.getItem(SCHOOL_CACHE_KEY) || 'null');
    if (cached && Date.now() - cached.fetchedAt < SCHOOL_CACHE_TTL) {
      return cached.schools;
    }
  } catch (e) {
    // キャッシュ読み込み失敗時はそのまま再取得する
  }

  const schools = await fetchSchools();
  try {
    localStorage.setItem(SCHOOL_CACHE_KEY, JSON.stringify({ fetchedAt: Date.now(), schools }));
  } catch (e) {
    // 保存できなくても表示自体には影響しない
  }
  return schools;
}

function renderSchools(schools) {
  schools.forEach((school) => {
    const marker = L.marker([school.lat, school.lng], { icon: SCHOOL_ICONS[school.type] }).addTo(map);
    marker.bindPopup(`<div class="school-popup">${escapeHtml(school.name)}</div>`);
  });
}

loadSchools()
  .then(renderSchools)
  .catch((e) => {
    console.warn('学校情報の取得に失敗しました。オフラインデータを表示します', e);
    renderSchools(FALLBACK_SCHOOLS);
    showToast('学校情報は保存済みのデータを表示しています（最新でない場合があります）。');
  });

function bubblePreview(text) {
  const chars = [...text];
  const clipped = chars.slice(0, 12).join('');
  return clipped.length < text.length ? `${clipped}…` : clipped;
}

function popularityClass(post) {
  const total = post.reactions.hokkori + post.reactions.iine;
  if (total >= HOT_THRESHOLD) return 'is-hot';
  if (total >= POPULAR_THRESHOLD) return 'is-popular';
  return '';
}

function bubbleIcon(post) {
  const meta = categoryMeta(post);
  const isSpecial = post.category !== 'normal';
  const popularClass = popularityClass(post);
  const categoryClass = isSpecial ? meta.bubbleClass : '';
  const bgStyle = isSpecial ? '' : `background:rgba(163, 216, 244, ${ageAlpha(post.createdAt)});`;
  const hotBadge = popularClass === 'is-hot' ? '<span class="mintsuji-bubble-badge">🔥</span>' : '';
  const photoBadge = post.photo ? '<span class="mintsuji-bubble-photo-badge">📷</span>' : '';
  const previewText = escapeHtml(bubblePreview(post.text));
  const displayText = isSpecial ? `${meta.emoji} ${previewText}` : previewText;
  return L.divIcon({
    className: '',
    html: `
      <div class="mintsuji-bubble-wrap">
        <div class="mintsuji-bubble ${popularClass} ${categoryClass}" style="${bgStyle}">${photoBadge}${hotBadge}${displayText}</div>
      </div>
    `,
    iconSize: [0, 0],
    iconAnchor: [0, 46],
    popupAnchor: [0, -46],
  });
}

const markersById = new Map();

function attachReactionHandlers(marker, postId) {
  const el = marker.getPopup().getElement();
  if (!el) return;
  el.querySelectorAll('.reaction-btn').forEach((btn) => {
    btn.onclick = (event) => {
      event.stopPropagation();
      reactToPost(postId, btn.dataset.type);
    };
  });
  const deleteBtn = el.querySelector('.popup-delete-btn');
  if (deleteBtn) {
    deleteBtn.onclick = (event) => {
      event.stopPropagation();
      deletePost(postId);
    };
  }
  const shareBtn = el.querySelector('.popup-share-btn');
  if (shareBtn) {
    shareBtn.onclick = (event) => {
      event.stopPropagation();
      handleShareClick(postId, shareBtn);
    };
  }
}

function deletePost(id) {
  if (!confirm('この投稿を削除しますか？この操作は取り消せません。')) return;
  postsCollection.doc(id).delete().catch((e) => {
    console.error('削除に失敗しました', e);
    showToast('削除に失敗しました。もう一度お試しください。');
  });
}

function reactToPost(id, type) {
  if (!currentUid) return;
  postsCollection.doc(id).update({
    [`reactions.${type}`]: firebase.firestore.FieldValue.increment(1),
  }).catch((e) => {
    console.error('リアクションの送信に失敗しました', e);
    showToast('リアクションを送信できませんでした。');
  });
}

/* ---------- 投稿シェア（画像カード生成） ---------- */

const SHARE_CARD_SIZE = 360; // 出力解像度は scale 倍（3倍 = 1080x1080）
const SHARE_CARD_SCALE = 3;

function formatShareDate(createdAt) {
  const d = new Date(createdAt);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function shareCardFontSize(text) {
  const len = [...text].length;
  if (len <= 25) return 30;
  if (len <= 50) return 24;
  if (len <= 90) return 19;
  return 15;
}

function buildShareCardElement(post) {
  const meta = categoryMeta(post);
  const fontSize = shareCardFontSize(post.text);

  const wrap = document.createElement('div');
  wrap.className = 'share-card-render';
  // 他の投稿情報が混ざらないよう、この投稿単体の情報のみで組み立てる
  wrap.innerHTML = `
    <div class="share-card-inner">
      <div class="share-card-category">${meta.emoji} ${escapeHtml(meta.label)}</div>
      <p class="share-card-text" style="font-size:${fontSize}px">${escapeHtml(post.text)}</p>
      <div class="share-card-footnote">
        <span>📍 辻堂</span>
        <span>${formatShareDate(post.createdAt)}</span>
      </div>
    </div>
    <div class="share-card-watermark">
      <img src="logo.png" class="share-card-logo" alt="">
      <span>みんツジで見つけた辻堂</span>
    </div>
  `;
  return wrap;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function handleShareClick(postId, btn) {
  const post = posts.find((p) => p.id === postId);
  if (!post) return;

  if (typeof html2canvas !== 'function') {
    showToast('シェア機能の読み込みに失敗しました。再読み込みしてください。');
    return;
  }

  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = '生成中…';

  const cardEl = buildShareCardElement(post);
  document.body.appendChild(cardEl);

  try {
    const canvas = await html2canvas(cardEl, {
      width: SHARE_CARD_SIZE,
      height: SHARE_CARD_SIZE,
      scale: SHARE_CARD_SCALE,
      backgroundColor: null,
      useCORS: true,
    });

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('画像の生成に失敗しました');

    const file = new File([blob], 'mintsuji-share.png', { type: 'image/png' });

    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({
        files: [file],
        title: 'みんツジ',
        text: 'みんツジで見つけた辻堂の投稿',
      });
    } else {
      downloadBlob(blob, 'mintsuji-share.png');
      showToast('画像をダウンロードしました。SNSアプリから投稿してください。');
    }
  } catch (e) {
    if (e && e.name === 'AbortError') {
      // ユーザーが共有シートをキャンセルした場合は何もしない
    } else {
      console.error('シェア画像の生成に失敗しました', e);
      showToast('シェア画像の生成に失敗しました。もう一度お試しください。');
    }
  } finally {
    cardEl.remove();
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
}

function addMarker(post) {
  const marker = L.marker([post.lat, post.lng], { icon: bubbleIcon(post) }).addTo(map);
  marker.bindPopup(popupHtml(post));
  marker.on('popupopen', () => attachReactionHandlers(marker, post.id));
  markersById.set(post.id, marker);
}

function removeMarkerById(id) {
  const marker = markersById.get(id);
  if (marker) {
    map.removeLayer(marker);
    markersById.delete(id);
  }
}

function upsertMarkerFromPost(post) {
  const existing = markersById.get(post.id);
  if (!existing) {
    addMarker(post);
    return;
  }
  existing.setIcon(bubbleIcon(post));
  existing.setPopupContent(popupHtml(post));
  if (existing.isPopupOpen()) attachReactionHandlers(existing, post.id);
}

/* ---------- タイムカプセル：Firestoreリアルタイム同期 ---------- */

function handleSnapshot(snapshot) {
  const now = Date.now();
  const expiredIds = [];

  snapshot.docChanges().forEach((change) => {
    const post = change.doc.data();

    if (change.type === 'removed') {
      removeMarkerById(post.id);
      posts = posts.filter((p) => p.id !== post.id);
      previousReactionTotals.delete(post.id);
      return;
    }

    if (now >= post.expiresAt) {
      removeMarkerById(post.id);
      posts = posts.filter((p) => p.id !== post.id);
      expiredIds.push(post.id);
      return;
    }

    const idx = posts.findIndex((p) => p.id === post.id);
    if (idx >= 0) posts[idx] = post; else posts.push(post);

    if (post.ownerId === currentUid) {
      const total = post.reactions.hokkori + post.reactions.iine;
      const prevTotal = previousReactionTotals.get(post.id);
      if (prevTotal !== undefined && total > prevTotal) {
        showToast('🎉 あなたの投稿にリアクションが届きました！');
      }
      previousReactionTotals.set(post.id, total);
    }

    upsertMarkerFromPost(post);
  });

  expiredIds.forEach((id) => {
    postsCollection.doc(id).delete().catch(() => {});
  });

  updatePostCountBadge();
}

authReady.then(() => {
  postsCollection.onSnapshot(handleSnapshot, (e) => {
    console.error('投稿データの購読に失敗しました', e);
    showToast('投稿データの取得に失敗しました。ネットワークをご確認ください。');
  });
});

setInterval(pruneExpiredLocal, 60 * 1000);

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

/* ---------- 共有QRモーダル ---------- */

const shareBtn = document.getElementById('share-btn');
const shareModal = document.getElementById('share-modal');
const shareClose = document.getElementById('share-close');

shareBtn.addEventListener('click', () => shareModal.classList.remove('hidden'));
shareClose.addEventListener('click', () => shareModal.classList.add('hidden'));
shareModal.addEventListener('click', (e) => {
  if (e.target === shareModal) shareModal.classList.add('hidden');
});

/* ---------- ダークモード ---------- */

const DARK_MODE_KEY = 'mintsuji_dark_mode';
const themeToggleBtn = document.getElementById('theme-toggle-btn');
const themeToggleIcon = document.getElementById('theme-toggle-icon');
const themeColorMeta = document.querySelector('meta[name="theme-color"]');

function isDarkMode() {
  return document.documentElement.classList.contains('dark-mode');
}

function applyDarkModeUi(isDark) {
  tileLayer.setUrl(isDark ? DARK_TILE_URL : LIGHT_TILE_URL);
  themeToggleIcon.textContent = isDark ? '☀️' : '🌙';
  themeToggleBtn.setAttribute('aria-label', isDark ? 'ライトモードに切り替え' : 'ダークモードに切り替え');
  if (themeColorMeta) themeColorMeta.setAttribute('content', isDark ? '#071627' : '#0C447C');
}

function setDarkMode(isDark) {
  document.documentElement.classList.toggle('dark-mode', isDark);
  try {
    localStorage.setItem(DARK_MODE_KEY, isDark ? '1' : '0');
  } catch (e) {
    // localStorageが使えない場合は保存をスキップ（表示自体には影響しない）
  }
  applyDarkModeUi(isDark);
}

themeToggleBtn.addEventListener('click', () => setDarkMode(!isDarkMode()));

// <head>のインラインスクリプトで初期クラスは反映済み。ここではタイル/アイコンを同期する。
applyDarkModeUi(isDarkMode());

/* ---------- 投稿モーダル ---------- */

const modal = document.getElementById('post-modal');
const postText = document.getElementById('post-text');
const charCount = document.getElementById('char-count');
const postError = document.getElementById('post-error');
const postCancel = document.getElementById('post-cancel');
const postSubmit = document.getElementById('post-submit');
const postPhotoInput = document.getElementById('post-photo');
const photoPreviewWrap = document.getElementById('photo-preview-wrap');
const photoPreview = document.getElementById('photo-preview');
const photoRemoveBtn = document.getElementById('photo-remove');
const categoryButtons = document.querySelectorAll('.category-btn');

const PHOTO_MAX_DIMENSION = 720;
const PHOTO_QUALITY = 0.7;

let pendingLatLng = null;
let pendingPhotoDataUrl = null;
let pendingCategory = 'normal';

function setPendingCategory(category) {
  pendingCategory = category;
  categoryButtons.forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.category === category);
  });
}

categoryButtons.forEach((btn) => {
  btn.addEventListener('click', () => setPendingCategory(btn.dataset.category));
});

function resizeImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('画像の読み込みに失敗しました'));
      img.onload = () => {
        const scale = Math.min(1, PHOTO_MAX_DIMENSION / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', PHOTO_QUALITY));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function clearPendingPhoto() {
  pendingPhotoDataUrl = null;
  postPhotoInput.value = '';
  photoPreview.src = '';
  photoPreviewWrap.classList.add('hidden');
}

postPhotoInput.addEventListener('change', async () => {
  const file = postPhotoInput.files[0];
  if (!file) return;

  try {
    pendingPhotoDataUrl = await resizeImageFile(file);
    photoPreview.src = pendingPhotoDataUrl;
    photoPreviewWrap.classList.remove('hidden');
  } catch (e) {
    console.warn('写真の処理に失敗しました', e);
    showToast('写真の読み込みに失敗しました。別の写真でお試しください。');
    clearPendingPhoto();
  }
});

photoRemoveBtn.addEventListener('click', clearPendingPhoto);

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
  clearPendingPhoto();
  setPendingCategory('normal');
  hideError();
  modal.classList.remove('hidden');
  postText.focus();
}

function closeModal() {
  modal.classList.add('hidden');
  pendingLatLng = null;
  clearPendingPhoto();
}

map.on('click', (e) => openModal(e.latlng));

postText.addEventListener('input', () => {
  charCount.textContent = String(postText.value.length);
});

postCancel.addEventListener('click', closeModal);

modal.addEventListener('click', (e) => {
  if (e.target === modal) closeModal();
});

postSubmit.addEventListener('click', async () => {
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

  await authReady;
  if (!currentUid) {
    showError('サーバーへの接続に失敗しました。時間をおいて再度お試しください。');
    return;
  }

  const createdAt = Date.now();
  const category = pendingCategory;
  const post = {
    id: `p_${createdAt}_${Math.random().toString(36).slice(2, 8)}`,
    lat: pendingLatLng.lat,
    lng: pendingLatLng.lng,
    text,
    photo: pendingPhotoDataUrl,
    category,
    createdAt,
    expiresAt: createdAt + CATEGORY_META[category].expiryMs,
    ownerId: currentUid,
    reactions: { hokkori: 0, iine: 0 },
  };

  postSubmit.disabled = true;
  try {
    await postsCollection.doc(post.id).set(post);
    closeModal();
  } catch (e) {
    console.error('投稿に失敗しました', e);
    showError('投稿に失敗しました。ネットワークをご確認のうえ、もう一度お試しください。');
  } finally {
    postSubmit.disabled = false;
  }
});
