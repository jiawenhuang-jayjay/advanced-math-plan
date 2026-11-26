const CACHE_PREFIX = "gaoshu-plan-";
const CACHE_NAME = CACHE_PREFIX + "v6";
const START_URL = new URL("./", self.location.href);
const LEGACY_START_URL = new URL("index.html", START_URL);
const CORE_ASSETS = [
  START_URL.href,
  "./progress.js",
  "./apple-touch-icon.png",
  "./manifest.json"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      await cache.addAll(CORE_ASSETS.map(url => new Request(url, { cache: "reload" })));
      await cache.add("./question_bank.js").catch(() => {});
      await self.skipWaiting();
    })
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
        .map((key) => caches.delete(key)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (url.pathname === "/api/progress") return;
  if (request.method !== "GET" || url.origin !== START_URL.origin) return;

  const isNavigation = request.mode === "navigate";
  if (isNavigation && url.pathname !== START_URL.pathname && url.pathname !== LEGACY_START_URL.pathname) return;

  // 已添加到桌面的旧图标可能仍请求 index.html。
  const cacheKey = isNavigation ? START_URL.href : request;
  const cache = caches.open(CACHE_NAME).catch(() => null);
  const network = fetch(request).catch(() => Response.error());
  event.waitUntil(network.then((response) => {
    if (!response.ok) return;
    const copy = response.clone();
    return cache.then((store) => store?.put(cacheKey, copy));
  }).catch(() => {}));
  event.respondWith(
    cache.then((store) => store?.match(cacheKey)).catch(() => null)
      .then((cached) => cached || network)
  );
});
