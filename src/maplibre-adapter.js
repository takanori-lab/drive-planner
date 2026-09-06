import { MAPLIBRE_CSS_URL, MAPLIBRE_SCRIPT_URL } from './map-config';

const CSS_MARKER = 'data-maplibre-stylesheet';
const SCRIPT_MARKER = 'data-maplibre-script';
let loading;

function loadStylesheet(documentObject) {
  let link = documentObject.querySelector(`link[${CSS_MARKER}="true"]`);
  if (link?.dataset?.loaded === 'true' || link?.sheet) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (!link) {
      link = documentObject.createElement('link'); link.rel = 'stylesheet'; link.href = MAPLIBRE_CSS_URL;
      link.setAttribute(CSS_MARKER, 'true'); documentObject.head.append(link);
    }
    link.addEventListener('load', () => { link.dataset.loaded = 'true'; resolve(); }, { once: true });
    link.addEventListener('error', () => { link.remove(); reject(new Error('MapLibre stylesheet could not be loaded')); }, { once: true });
  });
}

function loadScript(documentObject) {
  if (globalThis.maplibregl) return Promise.resolve(globalThis.maplibregl);
  let script = documentObject.querySelector(`script[${SCRIPT_MARKER}="true"]`);
  return new Promise((resolve, reject) => {
    if (!script) {
      script = documentObject.createElement('script'); script.src = MAPLIBRE_SCRIPT_URL; script.async = true;
      script.setAttribute(SCRIPT_MARKER, 'true'); documentObject.head.append(script);
    }
    script.addEventListener('load', () => {
      if (globalThis.maplibregl) resolve(globalThis.maplibregl);
      else { script.remove(); reject(new Error('MapLibre could not be loaded')); }
    }, { once: true });
    script.addEventListener('error', () => { script.remove(); reject(new Error('MapLibre could not be loaded')); }, { once: true });
  });
}

export function loadMapLibre(documentObject = document) {
  if (loading) return loading;
  loading = Promise.all([loadStylesheet(documentObject), loadScript(documentObject)])
    .then(([, maplibre]) => maplibre)
    .catch((error) => { loading = undefined; throw error; });
  return loading;
}

export function resetMapLibreLoaderForTests() { loading = undefined; }
