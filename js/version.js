// Single source of truth for the app version. Bump on every deploy: it names
// the service-worker cache, so a new value is what makes installed apps
// pick up the new files. Classic script so both the page and sw.js can use it.
self.APP_VERSION = '0.3.5';
