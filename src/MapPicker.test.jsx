import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { coordinateInputsFromLocation, createMapForDraft, MapPicker, locationFromCoordinateInputs } from './MapPicker';
import { DEFAULT_MAP_VIEW, MAP_STYLE_URL } from './map-config';
import { loadMapLibre, resetMapLibreLoaderForTests } from './maplibre-adapter';

function fakeDocument() {
  const nodes = [];
  const createElement = (tagName) => {
    const listeners = {}; const attributes = {};
    return { tagName, dataset: {}, sheet: null, setAttribute: (key, value) => { attributes[key] = value; },
      addEventListener: (type, listener) => { listeners[type] = listener; }, dispatch: (type) => listeners[type]?.(),
      remove() { const index = nodes.indexOf(this); if (index >= 0) nodes.splice(index, 1); }, attributes };
  };
  return { nodes, createElement, head: { append: (node) => nodes.push(node) }, querySelector(selector) {
    if (selector.startsWith('link')) return nodes.find((node) => node.tagName === 'link' && node.attributes['data-maplibre-stylesheet'] === 'true') ?? null;
    if (selector.startsWith('script')) return nodes.find((node) => node.tagName === 'script' && node.attributes['data-maplibre-script'] === 'true') ?? null;
    return null;
  } };
}
const node = (documentObject, tagName) => documentObject.nodes.find((item) => item.tagName === tagName);

describe('MapPicker', () => {
  afterEach(() => { resetMapLibreLoaderForTests(); delete globalThis.maplibregl; });
  it('未指定では空の座標入力とlabelを表示し、確定を無効化する', () => {
    const html = renderToStaticMarkup(<MapPicker place={{ name: '勝浦駅', location: null }} onCancel={() => undefined} onConfirm={() => undefined} />);
    expect(html).toContain('緯度・経度で指定'); expect(html).toContain('for="place-latitude"'); expect(html).toContain('for="place-longitude"');
    expect(html).toContain('value=""'); expect(html).toContain('この場所に決定'); expect(html).toContain('disabled=""');
  });
  it('指定済み座標を入力へ同期して決定可能にする', () => {
    const html = renderToStaticMarkup(<MapPicker place={{ name: '勝浦駅', location: { latitude: 35.15, longitude: 140.31 } }} onCancel={() => undefined} onConfirm={() => undefined} />);
    expect(html).toContain('value="35.15"'); expect(html).toContain('value="140.31"'); expect(html).not.toContain('class="primary" disabled');
  });
  it('pointerを使わない入力でも両方が有効な場合だけdraft座標を作る', () => {
    expect(locationFromCoordinateInputs('35.15', '140.31')).toEqual({ latitude: 35.15, longitude: 140.31 });
    expect(locationFromCoordinateInputs('', '')).toBeNull(); expect(locationFromCoordinateInputs('91', '140')).toBeNull();
    expect(locationFromCoordinateInputs('35', '181')).toBeNull(); expect(locationFromCoordinateInputs('Infinity', '140')).toBeNull();
  });
  it('地図タップ相当のlocationを座標入力値へ同期できる', () => {
    expect(coordinateInputsFromLocation({ latitude: 35.123, longitude: 140.456 })).toEqual({ latitude: '35.123', longitude: '140.456' });
    expect(coordinateInputsFromLocation(null)).toEqual({ latitude: '', longitude: '' });
  });
  it('loader待機中に更新された最新draftで地図とmarkerを初期化する', async () => {
    let resolveLoader; let latestDraft = null;
    const loader = new Promise((resolve) => { resolveLoader = resolve; });
    const map = { addControl: vi.fn(), on: vi.fn() };
    const marker = { setLngLat: vi.fn().mockReturnThis(), addTo: vi.fn().mockReturnThis() };
    const maplibre = { Map: vi.fn(() => map), Marker: vi.fn(() => marker) };
    const initialized = loader.then((loaded) => createMapForDraft(loaded, 'map-container', latestDraft));
    latestDraft = { latitude: 35.153, longitude: 140.312 };
    resolveLoader(maplibre); await initialized;
    expect(maplibre.Map).toHaveBeenCalledWith(expect.objectContaining({ center: [140.312, 35.153], zoom: 14 }));
    expect(marker.setLngLat).toHaveBeenCalledWith([140.312, 35.153]); expect(marker.addTo).toHaveBeenCalledWith(map);
  });
  it('draftが更新されない場合はDEFAULT_MAP_VIEWを使いmarkerを置かない', () => {
    const map = {}; const maplibre = { Map: vi.fn(() => map), Marker: vi.fn() };
    createMapForDraft(maplibre, 'map-container', null);
    expect(maplibre.Map).toHaveBeenCalledWith(expect.objectContaining(DEFAULT_MAP_VIEW)); expect(maplibre.Marker).not.toHaveBeenCalled();
  });
  it('provider設定を一箇所に集約する', () => {
    expect(MAP_STYLE_URL).toBe('https://tiles.openfreemap.org/styles/liberty'); expect(DEFAULT_MAP_VIEW).toEqual({ center: [139.7671, 35.6812], zoom: 8 });
  });
  it('短いviewportでもdialogをscrollでき、操作部を到達可能に保つ', () => {
    const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
    expect(css).toContain('.map-picker{max-height:100dvh;min-height:0;overflow-y:auto}');
    expect(css).toContain('@media(max-height:500px)'); expect(css).toContain('.map-picker-actions{position:sticky;bottom:0');
  });
  it('JSとCSSの両方が成功してからload成功にする', async () => {
    const documentObject = fakeDocument(); const pending = loadMapLibre(documentObject); let settled = false; pending.then(() => { settled = true; });
    globalThis.maplibregl = { Map: vi.fn() }; node(documentObject, 'script').dispatch('load'); await Promise.resolve(); expect(settled).toBe(false);
    node(documentObject, 'link').dispatch('load'); await expect(pending).resolves.toBe(globalThis.maplibregl);
  });
  it('CSS失敗linkを除去し、次回は新しいlinkでretryする', async () => {
    const documentObject = fakeDocument(); const first = loadMapLibre(documentObject); const failedLink = node(documentObject, 'link');
    globalThis.maplibregl = {}; node(documentObject, 'script').dispatch('load'); failedLink.dispatch('error'); await expect(first).rejects.toThrow('stylesheet');
    expect(documentObject.nodes).not.toContain(failedLink); const second = loadMapLibre(documentObject); const retriedLink = node(documentObject, 'link');
    expect(retriedLink).not.toBe(failedLink); retriedLink.dispatch('load'); await expect(second).resolves.toBe(globalThis.maplibregl);
  });
  it('script失敗後も失敗scriptを除去してretryする', async () => {
    const documentObject = fakeDocument(); const first = loadMapLibre(documentObject); const failedScript = node(documentObject, 'script');
    node(documentObject, 'link').dispatch('load'); failedScript.dispatch('error'); await expect(first).rejects.toThrow('MapLibre');
    expect(documentObject.nodes).not.toContain(failedScript); const second = loadMapLibre(documentObject); const retriedScript = node(documentObject, 'script');
    expect(retriedScript).not.toBe(failedScript); globalThis.maplibregl = {}; retriedScript.dispatch('load'); await expect(second).resolves.toBe(globalThis.maplibregl);
  });
  it('同時呼び出しではscriptとlinkを重複生成しない', async () => {
    const documentObject = fakeDocument(); const first = loadMapLibre(documentObject); const second = loadMapLibre(documentObject);
    expect(second).toBe(first); expect(documentObject.nodes).toHaveLength(2);
    globalThis.maplibregl = {}; node(documentObject, 'script').dispatch('load'); node(documentObject, 'link').dispatch('load'); await first;
  });
});
