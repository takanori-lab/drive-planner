import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MapPicker } from './MapPicker';
import { DEFAULT_MAP_VIEW, MAP_STYLE_URL } from './map-config';
import { loadMapLibre } from './maplibre-adapter';

describe('MapPicker', () => {
  it('未指定では確定を無効化し、キャンセル操作を表示する', () => {
    const html = renderToStaticMarkup(<MapPicker place={{ name: '勝浦駅', location: null }} onCancel={() => undefined} onConfirm={() => undefined} />);
    expect(html).toContain('勝浦駅の場所'); expect(html).toContain('この場所に決定'); expect(html).toContain('disabled=""'); expect(html).toContain('キャンセル');
  });
  it('指定済み座標をdraftとして再表示できる', () => {
    const html = renderToStaticMarkup(<MapPicker place={{ name: '勝浦駅', location: { latitude: 35.15, longitude: 140.31 } }} onCancel={() => undefined} onConfirm={() => undefined} />);
    expect(html).not.toContain('class="primary" disabled');
  });
  it('provider設定を一箇所に集約する', () => {
    expect(MAP_STYLE_URL).toBe('https://tiles.openfreemap.org/styles/liberty'); expect(DEFAULT_MAP_VIEW).toEqual({ center: [139.7671, 35.6812], zoom: 8 });
  });
  it('MapLibre読込失敗をrejectし、再試行可能にする', async () => {
    const appended = []; const documentMock = { querySelector: () => null, createElement: () => ({}), head: { append: (node) => appended.push(node) } };
    const pending = loadMapLibre(documentMock); appended.find((node) => node.src)?.onerror();
    await expect(pending).rejects.toThrow('MapLibre');
  });
});
