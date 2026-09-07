import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { canPreviewRoute, createRoutePreviewMap, handleRoutePreviewKeyDown, normalizeRouteGeometry, routeBounds, RoutePreview, unwrapRouteGeometry } from './RoutePreview';

const before = { name: '出発地', location: { latitude: 35, longitude: 139 } };
const after = { name: '到着地', location: { latitude: 36, longitude: 140 } };
const geometry = { type: 'LineString', coordinates: [[139.2, 35.1], [139.8, 35.7], [140.1, 36.1]] };
const result = { status: 'ok', distanceMeters: 12340, durationSeconds: 3900, geometry, majorRoads: ['国道1号', '県道2号'] };

function fakeMapLibre() {
  const handlers = {};
  const map = { on: vi.fn((name, handler) => { handlers[name] = handler; }), addSource: vi.fn(), addLayer: vi.fn(), fitBounds: vi.fn(), remove: vi.fn() };
  const markerInstances = [];
  const Marker = vi.fn(function Marker(options) {
    const marker = { options, setLngLat: vi.fn().mockReturnThis(), addTo: vi.fn().mockReturnThis(), remove: vi.fn() };
    markerInstances.push(marker); return marker;
  });
  return { maplibre: { Map: vi.fn(() => map), Marker }, map, handlers, markerInstances };
}
const documentObject = { createElement: () => ({ className: '', textContent: '' }) };

describe('RoutePreview', () => {
  it('ok・有効なLineString・確認済み両地点のときだけ表示可能にする', () => {
    expect(canPreviewRoute(before, after, result)).toBe(true);
    expect(canPreviewRoute(before, after, { ...result, geometry: undefined })).toBe(false);
    expect(canPreviewRoute(before, after, { ...result, status: 'loading' })).toBe(false);
    expect(canPreviewRoute({ ...before, location: null }, after, result)).toBe(false);
    expect(canPreviewRoute(before, after, { status: 'ok', distanceMeters: 1, durationSeconds: 1 })).toBe(false);
  });
  it('不正geometryを安全に拒否する', () => {
    expect(normalizeRouteGeometry(null)).toBeNull();
    expect(normalizeRouteGeometry({ type: 'Point', coordinates: [139, 35] })).toBeNull();
    expect(normalizeRouteGeometry({ type: 'LineString', coordinates: [[139, 35]] })).toBeNull();
    expect(normalizeRouteGeometry({ type: 'LineString', coordinates: [[139, 35], [181, 36]] })).toBeNull();
    expect(normalizeRouteGeometry({ type: 'LineString', coordinates: [[139, 35], ['140', 36]] })).toBeNull();
  });
  it('geometry全体から安全なboundsを計算する', () => {
    expect(routeBounds(geometry)).toEqual([[139.2, 35.1], [140.1, 36.1]]);
  });
  it('日付変更線を跨ぐgeometryを短いlongitude範囲へunwrapする', () => {
    const crossing = { type: 'LineString', coordinates: [[179.4, 45], [-179.7, 46], [-179.2, 44]] };
    expect(routeBounds(crossing)).toEqual([[179.4, 44], [180.8, 46]]);
    expect(unwrapRouteGeometry(crossing)).toEqual({ type: 'LineString', coordinates: [[179.4, 45], [180.3, 46], [180.8, 44]] });
  });
  it('短いviewportでpanelをscroll可能にしmap高さを抑える', () => {
    const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
    expect(css).toContain('.route-preview{min-height:0;overflow-y:auto}');
    expect(css).toContain('@media(max-height:500px){.route-preview{padding:10px}');
    expect(css).toContain('.route-preview-map{height:35dvh;min-height:120px}');
  });
  it('地点名、距離・時間、主な経路と閉じる操作を表示する', () => {
    const html = renderToStaticMarkup(<RoutePreview before={before} after={after} routeResult={result} onClose={() => undefined} />);
    expect(html).toContain('出発地 → 到着地'); expect(html).toContain('12.3 km ・ 約1時間5分');
    expect(html).toContain('主な経路: 国道1号 → 県道2号'); expect(html).toContain('aria-label="閉じる"');
    expect(html).toContain('tabindex="-1"');
  });
  it('Escapeで閉じ、TabとShift+Tabをdialog内に閉じ込める', () => {
    const first = { focus: vi.fn(), hidden: false }; const last = { focus: vi.fn(), hidden: false };
    const dialog = { querySelectorAll: vi.fn(() => [first, last]), focus: vi.fn() }; const onClose = vi.fn();
    const preventDefault = vi.fn();
    handleRoutePreviewKeyDown({ key: 'Escape', preventDefault }, dialog, onClose, { activeElement: first });
    expect(preventDefault).toHaveBeenCalled(); expect(onClose).toHaveBeenCalledOnce();
    preventDefault.mockClear();
    handleRoutePreviewKeyDown({ key: 'Tab', shiftKey: false, preventDefault }, dialog, onClose, { activeElement: last });
    expect(preventDefault).toHaveBeenCalled(); expect(first.focus).toHaveBeenCalled();
    preventDefault.mockClear();
    handleRoutePreviewKeyDown({ key: 'Tab', shiftKey: true, preventDefault }, dialog, onClose, { activeElement: first });
    expect(preventDefault).toHaveBeenCalled(); expect(last.focus).toHaveBeenCalled();
  });
  it('LineString Feature source、line layer、確認済み地点marker、全体viewportを設定する', () => {
    const fake = fakeMapLibre();
    createRoutePreviewMap(fake.maplibre, 'container', geometry, before.location, after.location, vi.fn(), documentObject);
    fake.handlers.load();
    expect(fake.map.addSource).toHaveBeenCalledWith('route-preview', { type: 'geojson', data: { type: 'Feature', properties: {}, geometry } });
    expect(fake.map.addLayer).toHaveBeenCalledWith(expect.objectContaining({ id: 'route-preview-line', type: 'line', source: 'route-preview' }));
    expect(fake.markerInstances[0].setLngLat).toHaveBeenCalledWith([139, 35]);
    expect(fake.markerInstances[1].setLngLat).toHaveBeenCalledWith([140, 36]);
    expect(fake.map.fitBounds).toHaveBeenCalledWith([[139.2, 35.1], [140.1, 36.1]], expect.objectContaining({ padding: 48 }));
  });
  it('日付変更線を跨ぐrouteではsourceとboundsへ同じ短い経度範囲を使う', () => {
    const fake = fakeMapLibre();
    const crossing = { type: 'LineString', coordinates: [[179.4, 45], [-179.7, 46], [-179.2, 44]] };
    const expectedGeometry = { type: 'LineString', coordinates: [[179.4, 45], [180.3, 46], [180.8, 44]] };
    createRoutePreviewMap(fake.maplibre, 'container', crossing, before.location, after.location, vi.fn(), documentObject);
    fake.handlers.load();
    expect(fake.map.addSource).toHaveBeenCalledWith('route-preview', {
      type: 'geojson', data: { type: 'Feature', properties: {}, geometry: expectedGeometry },
    });
    expect(fake.map.fitBounds).toHaveBeenCalledWith([[179.4, 44], [180.8, 46]], expect.objectContaining({ padding: 48 }));
  });
  it('source追加失敗とmap errorを地図内エラーへ隔離する', () => {
    const fake = fakeMapLibre(); const onError = vi.fn(); fake.map.addSource.mockImplementation(() => { throw new Error('style failure'); });
    expect(() => createRoutePreviewMap(fake.maplibre, 'container', geometry, before.location, after.location, onError, documentObject)).not.toThrow();
    fake.handlers.load(); expect(onError).toHaveBeenCalledTimes(1);
    fake.handlers.error(); expect(onError).toHaveBeenCalledTimes(2);
  });
});
