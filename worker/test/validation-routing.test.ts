import { describe, expect, it } from 'vitest';
import { validateRoutingRequest } from '../src/validation';

const request = (before = { latitude: 35.681, longitude: 139.767 }, after = { latitude: 35.498, longitude: 138.769 }) => ({ requestId: 'route', condition: 'recommended', before, after });
describe('routing座標validation', () => {
  it('有限で範囲内の座標だけを受理する', () => expect(validateRoutingRequest(request())).toEqual(request()));
  it.each([{ latitude: 91, longitude: 0 }, { latitude: -91, longitude: 0 }, { latitude: Number.NaN, longitude: 0 }])('不正latitudeを拒否する: %o', (coordinate) => expect(() => validateRoutingRequest(request(coordinate))).toThrow());
  it.each([{ latitude: 0, longitude: 181 }, { latitude: 0, longitude: -181 }, { latitude: 0, longitude: Number.POSITIVE_INFINITY }])('不正longitudeを拒否する: %o', (coordinate) => expect(() => validateRoutingRequest(request(coordinate))).toThrow());
  it('地点名やGoogle Maps情報をrouting contractで拒否する', () => expect(() => validateRoutingRequest(request({ latitude: 35, longitude: 139, name: '東京駅' } as any))).toThrow());
});
