import { useEffect, useRef, useState } from 'react';
import { DEFAULT_MAP_VIEW, MAP_STYLE_URL } from './map-config';
import { loadMapLibre } from './maplibre-adapter';
import { isValidLocation } from './model';

export function locationFromCoordinateInputs(latitude, longitude) {
  if (typeof latitude !== 'string' || typeof longitude !== 'string' || !latitude.trim() || !longitude.trim()) return null;
  const location = { latitude: Number(latitude), longitude: Number(longitude) };
  return isValidLocation(location) ? location : null;
}

export const coordinateInputsFromLocation = (location) => isValidLocation(location)
  ? { latitude: String(location.latitude), longitude: String(location.longitude) }
  : { latitude: '', longitude: '' };

export const isAiReferenceMarkerEvent = (event) => Boolean(event?.originalEvent?.target?.closest?.('.ai-reference-marker'));

export function createMapForDraft(maplibre, container, draft, referenceLocation = null, documentObject = globalThis.document, onSelectReference = () => undefined) {
  const hasDraft = isValidLocation(draft);
  const hasReferenceLocation = isValidLocation(referenceLocation);
  const initialView = hasDraft ? draft : hasReferenceLocation ? referenceLocation : null;
  const map = new maplibre.Map({ container, style: MAP_STYLE_URL,
    center: initialView ? [initialView.longitude, initialView.latitude] : DEFAULT_MAP_VIEW.center,
    zoom: initialView ? 14 : DEFAULT_MAP_VIEW.zoom, attributionControl: true });
  const marker = hasDraft ? new maplibre.Marker().setLngLat([draft.longitude, draft.latitude]).addTo(map) : null;
  let referenceMarker = null;
  if (hasReferenceLocation) {
    const element = documentObject.createElement('button');
    element.type = 'button';
    element.className = 'ai-reference-marker';
    element.textContent = 'AI参考位置';
    element.setAttribute('aria-label', 'AI参考位置を選択');
    element.addEventListener('click', (event) => {
      // MapLibreのgeneric clickへ伝播させず、参考座標そのものを選択する。
      event.stopPropagation();
      onSelectReference();
    });
    referenceMarker = new maplibre.Marker({ element, anchor: 'bottom' })
      .setLngLat([referenceLocation.longitude, referenceLocation.latitude]).addTo(map);
  }
  return { map, marker, referenceMarker };
}

export function MapPicker({ place, onCancel, onConfirm, mapLoader = loadMapLibre }) {
  const containerRef = useRef(null); const mapRef = useRef(null); const markerRef = useRef(null); const referenceMarkerRef = useRef(null); const maplibreRef = useRef(null);
  const initialLocation = isValidLocation(place.location) ? place.location : null;
  // 確定済み座標がある場合、AI参考座標は表示にもdraftにも利用しない。
  const referenceLocation = !initialLocation && isValidLocation(place.referenceLocation) ? place.referenceLocation : null;
  const initialInputs = coordinateInputsFromLocation(initialLocation);
  const [draft, setDraft] = useState(initialLocation);
  const draftRef = useRef(initialLocation);
  const [latitudeInput, setLatitudeInput] = useState(initialInputs.latitude);
  const [longitudeInput, setLongitudeInput] = useState(initialInputs.longitude);
  const [error, setError] = useState('');
  const placeMarker = (location) => {
    markerRef.current?.remove(); markerRef.current = null;
    if (location && mapRef.current && maplibreRef.current) markerRef.current = new maplibreRef.current.Marker()
      .setLngLat([location.longitude, location.latitude]).addTo(mapRef.current);
  };
  const updateFromInputs = (latitude, longitude) => {
    setLatitudeInput(latitude); setLongitudeInput(longitude);
    const location = locationFromCoordinateInputs(latitude, longitude);
    draftRef.current = location; setDraft(location); placeMarker(location);
  };
  const selectReferenceLocation = () => {
    if (!referenceLocation) return;
    const location = { latitude: referenceLocation.latitude, longitude: referenceLocation.longitude };
    const inputs = coordinateInputsFromLocation(location);
    draftRef.current = location; setDraft(location); setLatitudeInput(inputs.latitude); setLongitudeInput(inputs.longitude); placeMarker(location);
  };
  useEffect(() => {
    let disposed = false;
    mapLoader().then((maplibre) => {
      if (disposed || !containerRef.current) return;
      maplibreRef.current = maplibre;
      const latestDraft = draftRef.current;
      const initialized = createMapForDraft(maplibre, containerRef.current, latestDraft, referenceLocation, globalThis.document, selectReferenceLocation);
      const map = initialized.map; markerRef.current = initialized.marker; referenceMarkerRef.current = initialized.referenceMarker;
      mapRef.current = map; map.addControl(new maplibre.NavigationControl(), 'top-right');
      const placeMapMarker = (location) => {
        markerRef.current?.remove();
        markerRef.current = new maplibre.Marker().setLngLat([location.longitude, location.latitude]).addTo(map);
      };
      map.on('click', (event) => {
        if (isAiReferenceMarkerEvent(event)) return;
        const location = { latitude: event.lngLat.lat, longitude: event.lngLat.lng };
        const inputs = coordinateInputsFromLocation(location);
        draftRef.current = location; setDraft(location); setLatitudeInput(inputs.latitude); setLongitudeInput(inputs.longitude); placeMapMarker(location);
      });
      map.on('error', () => setError('地図を読み込めませんでした。時間をおいて再度お試しください。'));
    }).catch(() => !disposed && setError('地図を表示できません。その他の編集はそのまま利用できます。'));
    return () => { disposed = true; markerRef.current?.remove(); referenceMarkerRef.current?.remove(); mapRef.current?.remove(); };
  }, [mapLoader]);
  return <div className="map-picker-backdrop" role="presentation">
    <section className="map-picker" role="dialog" aria-modal="true" aria-labelledby="map-picker-title">
      <header><div><span className="eyebrow">SELECT A PLACE</span><h2 id="map-picker-title">{place.name}の場所</h2></div><button type="button" className="close" aria-label="キャンセル" onClick={onCancel}>×</button></header>
      <p>地図をタップしてピンを置いてください。</p>
      {referenceLocation && <aside className="ai-reference-guide">
        <p><strong>AI参考位置</strong><br />AIによる参考位置です。正しい場所か地図で確認してください。</p>
        <button type="button" className="secondary" onClick={selectReferenceLocation}>この参考位置を選択</button>
      </aside>}
      <div className="map-canvas" ref={containerRef} aria-label="場所を指定する地図" />
      {error && <p className="map-error" role="alert">{error}</p>}
      <details className="coordinate-inputs">
        <summary>緯度・経度で指定</summary>
        <div><label htmlFor="place-latitude">緯度（-90〜90）</label><input id="place-latitude" type="number" min="-90" max="90" step="any" inputMode="decimal" value={latitudeInput} onChange={(event) => updateFromInputs(event.target.value, longitudeInput)} /></div>
        <div><label htmlFor="place-longitude">経度（-180〜180）</label><input id="place-longitude" type="number" min="-180" max="180" step="any" inputMode="decimal" value={longitudeInput} onChange={(event) => updateFromInputs(latitudeInput, event.target.value)} /></div>
      </details>
      <div className="map-picker-actions"><button type="button" className="secondary" onClick={onCancel}>キャンセル</button><button type="button" className="primary" disabled={!isValidLocation(draft)} onClick={() => onConfirm(draft)}>この場所に決定</button></div>
    </section>
  </div>;
}
