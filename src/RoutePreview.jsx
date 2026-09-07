import { useEffect, useRef, useState } from 'react';
import { formatDistance, formatDuration } from './App';
import { MAP_STYLE_URL } from './map-config';
import { loadMapLibre } from './maplibre-adapter';
import { isValidLocation } from './model';

export function normalizeRouteGeometry(geometry) {
  if (geometry?.type !== 'LineString' || !Array.isArray(geometry.coordinates) || geometry.coordinates.length < 2) return null;
  const coordinates = geometry.coordinates.map((coordinate) => {
    if (!Array.isArray(coordinate) || coordinate.length < 2) return null;
    const longitude = coordinate[0]; const latitude = coordinate[1];
    return Number.isFinite(longitude) && longitude >= -180 && longitude <= 180
      && Number.isFinite(latitude) && latitude >= -90 && latitude <= 90 ? [longitude, latitude] : null;
  });
  return coordinates.every(Boolean) ? { type: 'LineString', coordinates } : null;
}

export const unwrapRouteGeometry = (geometry) => {
  const valid = normalizeRouteGeometry(geometry);
  if (!valid) return null;
  let previousLongitude = valid.coordinates[0][0];
  const unwrapped = valid.coordinates.map(([longitude, latitude], index) => {
    if (index === 0) return [longitude, latitude];
    let nextLongitude = longitude;
    while (nextLongitude - previousLongitude > 180) nextLongitude -= 360;
    while (nextLongitude - previousLongitude < -180) nextLongitude += 360;
    previousLongitude = nextLongitude;
    return [nextLongitude, latitude];
  });
  return { type: 'LineString', coordinates: unwrapped };
};

const boundsFromUnwrappedGeometry = (geometry) => geometry.coordinates.reduce((bounds, [longitude, latitude]) => [
  [Math.min(bounds[0][0], longitude), Math.min(bounds[0][1], latitude)],
  [Math.max(bounds[1][0], longitude), Math.max(bounds[1][1], latitude)],
], [[Infinity, Infinity], [-Infinity, -Infinity]]);

export const routeBounds = (geometry) => {
  const unwrapped = unwrapRouteGeometry(geometry);
  if (!unwrapped) return null;
  return boundsFromUnwrappedGeometry(unwrapped);
};

export function canPreviewRoute(before, after, routeResult) {
  return routeResult?.status === 'ok' && Boolean(normalizeRouteGeometry(routeResult.geometry))
    && isValidLocation(before?.location) && isValidLocation(after?.location);
}

const FOCUSABLE_SELECTOR = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function handleRoutePreviewKeyDown(event, dialog, onClose, documentObject = document) {
  if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
  if (event.key !== 'Tab') return;
  const focusable = [...dialog.querySelectorAll(FOCUSABLE_SELECTOR)].filter((element) => !element.hidden);
  if (!focusable.length) { event.preventDefault(); dialog.focus(); return; }
  const first = focusable[0]; const last = focusable[focusable.length - 1];
  if (event.shiftKey && (documentObject.activeElement === first || documentObject.activeElement === dialog)) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && documentObject.activeElement === last) { event.preventDefault(); first.focus(); }
}

function markerElement(documentObject, label, kind) {
  const element = documentObject.createElement('div');
  element.className = `route-map-marker route-map-marker-${kind}`; element.textContent = label;
  return element;
}

export function createRoutePreviewMap(maplibre, container, geometry, start, end, onError, documentObject = document) {
  const unwrapped = unwrapRouteGeometry(geometry); const bounds = unwrapped && boundsFromUnwrappedGeometry(unwrapped);
  if (!unwrapped || !bounds || !isValidLocation(start) || !isValidLocation(end)) throw new Error('Invalid route preview data');
  const map = new maplibre.Map({ container, style: MAP_STYLE_URL, attributionControl: true });
  const markers = [];
  const fail = () => onError?.();
  map.on('error', fail);
  map.on('load', () => {
    try {
      map.addSource('route-preview', { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: unwrapped } });
      map.addLayer({ id: 'route-preview-line', type: 'line', source: 'route-preview', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#28734a', 'line-width': 5, 'line-opacity': 0.9 } });
      markers.push(new maplibre.Marker({ element: markerElement(documentObject, 'START', 'start') }).setLngLat([start.longitude, start.latitude]).addTo(map));
      markers.push(new maplibre.Marker({ element: markerElement(documentObject, 'END', 'end') }).setLngLat([end.longitude, end.latitude]).addTo(map));
      map.fitBounds(bounds, { padding: 48, maxZoom: 15, duration: 0 });
    } catch { fail(); }
  });
  return { map, markers };
}

export function RoutePreview({ before, after, routeResult, onClose, returnFocusRef, mapLoader = loadMapLibre }) {
  const containerRef = useRef(null); const mapRef = useRef(null); const markersRef = useRef([]);
  const dialogRef = useRef(null);
  const [mapError, setMapError] = useState('');
  useEffect(() => {
    dialogRef.current?.focus();
    return () => returnFocusRef?.current?.focus();
  }, [returnFocusRef]);
  useEffect(() => {
    let disposed = false;
    mapLoader().then((maplibre) => {
      if (disposed || !containerRef.current) return;
      try {
        const initialized = createRoutePreviewMap(maplibre, containerRef.current, routeResult.geometry,
          before.location, after.location, () => !disposed && setMapError('地図を読み込めませんでした。'));
        mapRef.current = initialized.map; markersRef.current = initialized.markers;
      } catch { if (!disposed) setMapError('地図を表示できませんでした。'); }
    }).catch(() => !disposed && setMapError('地図を表示できませんでした。'));
    return () => { disposed = true; markersRef.current.forEach((marker) => marker.remove()); mapRef.current?.remove(); };
  }, [before, after, routeResult, mapLoader]);
  return <div className="route-preview-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section ref={dialogRef} className="route-preview" role="dialog" aria-modal="true" aria-labelledby="route-preview-title" tabIndex="-1" onKeyDown={(event) => handleRoutePreviewKeyDown(event, dialogRef.current, onClose)}>
      <header><div><span className="eyebrow">ROUTE PREVIEW</span><h2 id="route-preview-title">{before.name} → {after.name}</h2></div><button type="button" className="close" aria-label="閉じる" onClick={onClose}>×</button></header>
      <div className="route-preview-details"><strong>{formatDistance(routeResult.distanceMeters)} ・ 約{formatDuration(routeResult.durationSeconds)}</strong>{routeResult.majorRoads?.length > 0 && <small>主な経路: {routeResult.majorRoads.join(' → ')}</small>}</div>
      <div className="route-preview-map" ref={containerRef} aria-label={`${before.name}から${after.name}までの経路地図`} />
      {mapError && <p className="map-error" role="alert">{mapError}<br />距離・時間などの経路情報は引き続き確認できます。</p>}
      <button type="button" className="secondary route-preview-close" onClick={onClose}>閉じる</button>
    </section>
  </div>;
}
