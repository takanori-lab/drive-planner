import { describe, expect, it } from 'vitest';
import { missingSecrets, REQUIRED_SECRETS } from '../scripts/check-secrets.mjs';

describe('deploy secret check', () => {
  it('ORS_API_KEYを含む不足Secretを報告する', () => {
    const entries = REQUIRED_SECRETS
      .filter((name) => name !== 'ORS_API_KEY')
      .map((name) => ({ name, type: 'secret_text' }));

    expect(missingSecrets(entries)).toEqual(['ORS_API_KEY']);
  });

  it('required Secretがすべて登録済みならdeployを許可する', () => {
    expect(missingSecrets(REQUIRED_SECRETS.map((name) => ({ name })))).toEqual([]);
  });
});
