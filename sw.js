// Service Worker for FitBaus Trainer PWA
// Cache name is derived from version.js (single source of truth)

const urlsToCache = [
  '/',
  '/index.html',
  '/styles.css',
  '/dist/main.js',
  '/dist/workoutData.js',
  '/dist/workoutTemplate.js',
  '/dist/workoutPrescription.js',
  '/dist/personalizedPrescription.js',
  '/dist/personalizedPrescriptionCharacterization.js',
  '/dist/personalizationStatus.js',
  '/dist/personalizationDiagnosticsView.js',
  '/dist/workoutLogic.js',
  '/dist/workoutStorage.js',
  '/dist/workoutSummary.js',
  '/dist/workoutActivity.js',
  '/dist/sessionStore.js',
  '/dist/sessionControlMode.js',
  '/dist/zoneCalculator.js',
  '/dist/profile.js',
  '/dist/profileFitnessView.js',
  '/dist/fitnessState.js',
  '/dist/fitnessRefinement.js',
  '/dist/ordinaryWorkoutTelemetry.js',
  '/dist/workoutResponse.js',
  '/dist/stats.js',
  '/dist/performedLoad.js',
  '/dist/performedLoadDiagnosticsView.js',
  '/dist/utils/uuid.js',
  '/dist/voice.js',
  '/dist/uiControls.js',
  '/dist/sisuSync.js',
  '/dist/pwaInstall.js',
  '/dist/wakeLock.js',
  '/dist/platform/runtime.js',
  '/dist/platform/heartRateMeasurement.js',
  '/dist/platform/sisuHttp.js',
  '/dist/machines/guidance.js',
  '/dist/machines/proformSmartPower10.js',
  '/dist/machines/registry.js',
  '/dist/machines/runtime.js',
  '/dist/machines/selection.js',
  '/dist/machines/hrQuality.js',
  '/dist/machines/learning/index.js',
  '/dist/machines/learning/storage.js',
  '/dist/machines/learning/derive.js',
  '/dist/machines/learning/types.js',
  '/dist/machines/dynamics/index.js',
  '/dist/machines/dynamics/storage.js',
  '/dist/machines/dynamics/derive.js',
  '/dist/machines/dynamics/types.js',
  '/dist/machines/dynamics/recent.js',
  '/dist/machines/dynamics/timing.js',
  '/dist/machines/prediction/index.js',
  '/dist/machines/prediction/types.js',
  '/dist/machines/prediction/estimate.js',
  '/dist/machines/prediction/derive.js',
  '/dist/machines/prediction/storage.js',
  '/dist/machines/prediction/validation.js',
  '/dist/machines/diagnostics/index.js',
  '/dist/machines/diagnostics/types.js',
  '/dist/machines/diagnostics/snapshot.js',
  '/dist/machines/audit/index.js',
  '/dist/machines/audit/types.js',
  '/dist/machines/audit/runtime.js',
  '/dist/version.js',
  '/dist/types.js',
  '/dist/vo2Protocol.js',
  '/dist/vo2Evidence.js',
  '/dist/vo2Estimator.js',
  '/dist/vo2AssessmentView.js',
  '/dist/vo2Workload.js',
  '/dist/bikeTelemetryTrace.js',
  '/dist/workoutLifecycle.js',
  '/data.json',
  '/manifest.json',
  '/heart.png',
  '/bike.png',
  '/elliptical.png',
  '/dumbbell.png',
  '/favicon.ico'
];

// Resolve cache name by fetching version.js and parsing APP_VERSION (single source of truth)
let _cacheNamePromise = null;
function getCacheName() {
  if (_cacheNamePromise) return _cacheNamePromise;
  _cacheNamePromise = self.fetch('/dist/version.js')
    .then((r) => r.text())
    .then((text) => {
      const m = text.match(/APP_VERSION\\s*=\\s*['\"]([^'\"]+)['\"]/);
      const version = (m && m[1]) ? m[1] : '0';
      return 'fitbaus-trainer-' + version;
    })
    .catch(() => 'fitbaus-trainer-unknown');
  return _cacheNamePromise;
}

// Install event - cache resources
self.addEventListener('install', (event) => {
  event.waitUntil(
    getCacheName()
      .then((cacheName) => {
        console.log('Opened cache', cacheName);
        return caches.open(cacheName).then((cache) => {
          return Promise.allSettled(
            urlsToCache.map((url) => cache.add(url).catch((err) => console.warn('Cache miss:', url, err)))
          );
        });
      })
      .catch((error) => {
        console.error('Cache failed:', error);
      })
  );
  self.skipWaiting(); // Activate immediately
});

// Activate event - clean up old caches, then claim clients
self.addEventListener('activate', (event) => {
  event.waitUntil(
    getCacheName()
      .then((currentName) => {
        return caches.keys().then((cacheNames) => {
          return Promise.all(
            cacheNames.map((cacheName) => {
              if (cacheName !== currentName) {
                console.log('Deleting old cache:', cacheName);
                return caches.delete(cacheName);
              }
            })
          );
        });
      })
      .then(() => self.clients.claim())
  );
});

// Listen for skip waiting message from client
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// Fetch event - network-first for HTML, cache-first for assets
self.addEventListener('fetch', (event) => {
  // IMPORTANT: do not interfere with cross-origin requests (e.g., SISU sync).
  // If we handle them here and the network request fails (TLS/mixed-content/etc),
  // our fallback Response(503) masks the real browser error and makes debugging impossible.
  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin) {
    return; // Let the browser handle it normally.
  }

  // IMPORTANT: Always fetch version from the network (or SW can get "stuck" on an old cache name).
  if (requestUrl.pathname === '/dist/version.js') {
    event.respondWith(
      fetch(event.request, { cache: 'no-store' }).catch(() => caches.match(event.request))
    );
    return;
  }

  // Network-first strategy for HTML documents to get updates immediately
  if (event.request.destination === 'document' || 
      event.request.url.endsWith('.html') ||
      event.request.url.endsWith('/')) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const responseClone = response.clone();
          getCacheName().then((cacheName) => {
            caches.open(cacheName).then((cache) => cache.put(event.request, responseClone));
          });
          return response;
        })
        .catch(() => {
          return getCacheName().then((cacheName) => {
            return caches.match(event.request).then((cachedResponse) => {
              if (!cachedResponse && event.request.destination === 'document') {
                return caches.match('/index.html');
              }
              return cachedResponse;
            });
          });
        })
    );
  } else if (
    requestUrl.pathname.startsWith('/dist/') ||
    requestUrl.pathname.endsWith('.js') ||
    requestUrl.pathname.endsWith('.css')
  ) {
    // Network-first for build outputs so updates apply immediately in development.
    event.respondWith(
      fetch(event.request)
        .then((networkResponse) => {
          const responseClone = networkResponse.clone();
          getCacheName().then((cacheName) => {
            caches.open(cacheName).then((cache) => cache.put(event.request, responseClone));
          });
          return networkResponse;
        })
        .catch(() => {
          return caches.match(event.request).then((cachedResponse) => cachedResponse || new Response('Offline', { status: 503 }));
        })
    );
  } else {
    // Cache-first strategy for other assets (images, manifest, etc.)
    event.respondWith(
      getCacheName().then((cacheName) => {
        return caches.match(event.request)
          .then((response) => {
            if (response) return response;
            return fetch(event.request)
              .then((networkResponse) => {
                const responseClone = networkResponse.clone();
                caches.open(cacheName).then((cache) => cache.put(event.request, responseClone));
                return networkResponse;
              })
              .catch(() => new Response('Offline', { status: 503 }));
          });
      })
    );
  }
});
