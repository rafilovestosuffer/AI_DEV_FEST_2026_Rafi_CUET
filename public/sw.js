// Offline support: network first, cached copy when there is no internet.
// Only the app's own files and its Bangla web font are cached; tender documents are never cached here.
const CACHE = 'tpb-v1'

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))

self.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  const sameOrigin = url.origin === self.location.origin
  const font = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com'
  if (!sameOrigin && !font) return
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && (res.ok || res.type === 'opaque')) {
          const copy = res.clone()
          caches.open(CACHE).then((c) => c.put(req, copy))
        }
        return res
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match('./index.html'))),
  )
})
