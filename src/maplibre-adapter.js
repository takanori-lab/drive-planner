import { MAPLIBRE_CSS_URL, MAPLIBRE_SCRIPT_URL } from './map-config';

let loading;
export function loadMapLibre(documentObject = document) {
  if (globalThis.maplibregl) return Promise.resolve(globalThis.maplibregl);
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    if (!documentObject.querySelector(`link[href="${MAPLIBRE_CSS_URL}"]`)) {
      const link = documentObject.createElement('link'); link.rel = 'stylesheet'; link.href = MAPLIBRE_CSS_URL; documentObject.head.append(link);
    }
    const script = documentObject.createElement('script'); script.src = MAPLIBRE_SCRIPT_URL; script.async = true;
    script.onload = () => globalThis.maplibregl ? resolve(globalThis.maplibregl) : reject(new Error('MapLibre could not be loaded'));
    script.onerror = () => reject(new Error('MapLibre could not be loaded'));
    documentObject.head.append(script);
  }).catch((error) => { loading = undefined; throw error; });
  return loading;
}

