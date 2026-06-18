const CACHE_NAME = 'myexpenses-cache-20260618_12';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './shiba_guard.png',
  './cat_helper.png'
];

// 安裝事件：快取所有靜態資源
self.addEventListener('install', (e) => {
  console.log('[Service Worker] 正在安裝 & 快取靜態資源...');
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS);
    }).then(() => {
      // 強制跳過等待，立刻讓新的 service worker 啟用
      return self.skipWaiting();
    })
  );
});

// 啟用事件：清除舊版本快取
self.addEventListener('activate', (e) => {
  console.log('[Service Worker] 啟用成功，清理舊快取中...');
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            console.log(`[Service Worker] 刪除舊快取: ${key}`);
            return caches.delete(key);
          }
        })
      );
    }).then(() => {
      // 獲取所有客戶端的控制權
      return self.clients.claim();
    })
  );
});

// 攔截請求事件
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  
  // 避雷設計：如果是 Firebase 的 API 請求或是 Authentication 的 request，直接 bypass 快取走網路
  if (url.origin.includes('firebase') || url.pathname.includes('firestore') || e.request.method !== 'GET') {
    return; // 交由瀏覽器與 Firebase SDK 處理，不進行攔截
  }

  // 靜態資源採取 Cache First, Fallback to Network 策略
  e.respondWith(
    caches.match(e.request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }
      
      return fetch(e.request).then((networkResponse) => {
        // 只有在成功取得回應且是 GET 時，才將其加入快取
        if (networkResponse && networkResponse.status === 200 && e.request.method === 'GET') {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(e.request, responseToCache);
          });
        }
        return networkResponse;
      }).catch(() => {
        // 如果連靜態網頁也沒網路，且沒快取，則返回預設（例如 index.html 的快取）
        if (e.request.mode === 'navigate') {
          return caches.match('./index.html');
        }
      });
    })
  );
});
