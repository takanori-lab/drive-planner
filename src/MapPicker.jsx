import { useEffect, useRef, useState } from 'react';
import { DEFAULT_MAP_VIEW, MAP_STYLE_URL } from './map-config';
import { loadMapLibre } from './maplibre-adapter';
import { isValidLocation } from './model';

export function MapPicker({ place, onCancel, onConfirm, mapLoader = loadMapLibre }) {
  const containerRef = useRef(null); const mapRef = useRef(null); const markerRef = useRef(null);
  const [draft, setDraft] = useState(isValidLocation(place.location) ? place.location : null);
  const [error, setError] = useState('');
  useEffect(() => {
    let disposed = false;
    mapLoader().then((maplibre) => {
      if (disposed || !containerRef.current) return;
      const center = draft ? [draft.longitude, draft.latitude] : DEFAULT_MAP_VIEW.center;
      const map = new maplibre.Map({ container: containerRef.current, style: MAP_STYLE_URL, center, zoom: draft ? 14 : DEFAULT_MAP_VIEW.zoom, attributionControl: true });
      mapRef.current = map; map.addControl(new maplibre.NavigationControl(), 'top-right');
      const placeMarker = (location) => {
        markerRef.current?.remove();
        markerRef.current = new maplibre.Marker().setLngLat([location.longitude, location.latitude]).addTo(map);
      };
      if (draft) placeMarker(draft);
      map.on('click', (event) => { const location = { latitude: event.lngLat.lat, longitude: event.lngLat.lng }; setDraft(location); placeMarker(location); });
      map.on('error', () => setError('地図を読み込めませんでした。時間をおいて再度お試しください。'));
    }).catch(() => !disposed && setError('地図を表示できません。その他の編集はそのまま利用できます。'));
    return () => { disposed = true; markerRef.current?.remove(); mapRef.current?.remove(); };
  }, [mapLoader]);
  return <div className="map-picker-backdrop" role="presentation">
    <section className="map-picker" role="dialog" aria-modal="true" aria-labelledby="map-picker-title">
      <header><div><span className="eyebrow">SELECT A PLACE</span><h2 id="map-picker-title">{place.name}の場所</h2></div><button type="button" className="close" aria-label="キャンセル" onClick={onCancel}>×</button></header>
      <p>地図をタップしてピンを置いてください。</p>
      <div className="map-canvas" ref={containerRef} aria-label="場所を指定する地図" />
      {error && <p className="map-error" role="alert">{error}</p>}
      <div className="map-picker-actions"><button type="button" className="secondary" onClick={onCancel}>キャンセル</button><button type="button" className="primary" disabled={!isValidLocation(draft)} onClick={() => onConfirm(draft)}>この場所に決定</button></div>
    </section>
  </div>;
}
