import { crc32 } from './crc32.js';

export type BrelloKeyMode = 'live' | 'test';

export type ApiKeyValidation =
  | { valid: true; mode: BrelloKeyMode; bearerKey: string }
  | { valid: false };

const issuedKey = /^(brl_(live|test)_|brello_)[A-Za-z0-9_-]{43}$/;
const checksummedKey = /^(brl_(live|test)_[A-Za-z0-9_-]{43})_([0-9a-f]{8})$/;

/**
 * Normalize project keys to the bearer format accepted by Ingest. The legacy
 * checksum detects typos and is removed before transmission. Only the server can
 * verify that a locally valid key is authorized for a project.
 */
export function parseApiKey(value: unknown): ApiKeyValidation {
  if (typeof value !== 'string') return { valid: false };
  const current = issuedKey.exec(value);
  if (current?.[0] === value) {
    return { valid: true, mode: current[2] === 'test' ? 'test' : 'live', bearerKey: value };
  }
  const legacy = checksummedKey.exec(value);
  if (legacy?.[0] === value && crc32(legacy[1]) === legacy[3]) {
    return { valid: true, mode: legacy[2] === 'test' ? 'test' : 'live', bearerKey: legacy[1] };
  }
  return { valid: false };
}

export function validateApiKey(value: unknown): { valid: true; mode: BrelloKeyMode } | { valid: false } {
  const result = parseApiKey(value);
  return result.valid ? { valid: true, mode: result.mode } : result;
}

/** Read process.env when available so edge runtimes can rely on explicit options. */
export function readNodeEnvironment(name: string): string | undefined {
  const runtime = globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> };
  };
  return runtime.process?.env?.[name];
}

