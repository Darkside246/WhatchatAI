import { argon2id } from 'hash-wasm';
import type { Argon2ParamsDto } from './api.js';

// OWASP-minimum Argon2id parameters for a new PIN. The server independently
// rejects anything weaker than this floor.
export const DEFAULT_ARGON2_PARAMS: Argon2ParamsDto = {
  memoryCostKib: 19_456,
  timeCost: 2,
  parallelism: 1,
  hashLengthBytes: 32,
};

export function generateSalt(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Runs real Argon2id in-browser via WASM. The raw PIN never leaves this
 * function call - only the resulting hex hash is sent to the server.
 */
export async function hashPin(pin: string, salt: string, params: Argon2ParamsDto = DEFAULT_ARGON2_PARAMS): Promise<string> {
  return argon2id({
    password: pin,
    salt,
    iterations: params.timeCost,
    parallelism: params.parallelism,
    memorySize: params.memoryCostKib,
    hashLength: params.hashLengthBytes,
    outputType: 'hex',
  });
}
