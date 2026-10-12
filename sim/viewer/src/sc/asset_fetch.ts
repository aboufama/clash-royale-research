/**
 * Fetch for the baked assets. The Pages build loads the bundle as `dist/main.js?v=<commit>`; that
 * version rides on every asset request, so a new deploy never mixes with files a browser cached from
 * the previous one (GitHub Pages lets them be cached for 10 minutes). Locally there is no version.
 */
const VERSION = (() => {
  try { return new URL(import.meta.url).searchParams.get('v'); } catch { return null; }
})();

export function versionedUrl(url: string, v: string | null = VERSION): string {
  return v ? `${url}${url.includes('?') ? '&' : '?'}v=${encodeURIComponent(v)}` : url;
}

export function assetFetch(url: string): Promise<Response> {
  return fetch(versionedUrl(url));
}
