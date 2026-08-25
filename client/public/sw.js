// No offline caching — just registering a controlling service worker is
// what makes browsers treat the manifest as installable.
self.addEventListener('fetch', () => {});
