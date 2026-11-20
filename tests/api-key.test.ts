import { describe, expect, it } from 'vitest';
import { validateApiKey } from '../src/auth/api-key.js';
import { crc32 } from '../src/auth/crc32.js';
import { Brello } from '../src/client.js';

describe('CRC-32 checksum', () => {
  it('uses the standard CRC-32/ISO-HDLC result', () => {
    expect(crc32('123456789')).toBe('cbf43926');
  });
});

describe('Brello API key configuration', () => {
  const keyBody = `brl_test_${'A'.repeat(43)}`;
  const validTestKey = `${keyBody}_${crc32(keyBody)}`;

  it('accepts the project key format issued by the server', () => {
    expect(validateApiKey(keyBody)).toEqual({ valid: true, mode: 'test' });
    expect(validateApiKey(`brello_${'A'.repeat(43)}`)).toEqual({ valid: true, mode: 'live' });
  });

  it('accepts a correctly checksummed test key', () => {
    expect(validateApiKey(validTestKey)).toEqual({ valid: true, mode: 'test' });
  });

  it('rejects a key with a changed checksum', () => {
    const lastDigit = validTestKey.endsWith('0') ? '1' : '0';
    const invalidKey = `${validTestKey.slice(0, -1)}${lastDigit}`;

    expect(validateApiKey(invalidKey)).toEqual({ valid: false });
  });

  it('returns missing-key information instead of throwing', () => {
    const client = new Brello({ apiKey: '' });

    expect(client.apiKeyStatus).toBe('missing');
    expect(client.error?.code).toBe('API_KEY_MISSING');
  });

  it('returns invalid-key information instead of throwing', () => {
    const client = new Brello({ apiKey: 'brl_live_not-a-real-key' });

    expect(client.apiKeyStatus).toBe('invalid');
    expect(client.error?.code).toBe('API_KEY_INVALID');
  });
});
