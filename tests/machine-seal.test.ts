/**
 * Sealing a node's master to the machine it runs on — owner, 2026-11-05: a server that had its key from setup comes
 * back after a restart by itself; "if it shuts down and restarts we dont need keys to have it come back online".
 *
 * The key holders provision a node once (or again on a replaced machine); the node then seals its master with what the
 * machine offers, and every later start opens it with no person and no network. A copy of the node's disk taken to
 * another machine or another account opens nothing. On Windows the seal is DPAPI under the account the node runs as,
 * reached through PowerShell with the data on stdin, never on a command line; a boot without one refuses unless it is
 * an unsecure development boot, whose "seal" keeps the master in the clear and says so.
 */
import { randomBytes } from 'crypto';
import { resolveMachineSeal, testOnlyMachineSeal, dpapiSeal, developmentSeal } from '../src/keys/machine-seal.js';

const CONTEXT = 'zpk.care/node-master/2026-11-05-0001/insurer';

describe('the test seal (another instance stands for another machine)', () => {
  test('opens what it sealed, for the same context only', async () => {
    const seal = testOnlyMachineSeal();
    const secret = randomBytes(32);
    const blob = await seal.seal(secret, CONTEXT);
    expect(blob.includes(secret)).toBe(false);
    expect((await seal.open(blob, CONTEXT)).equals(secret)).toBe(true);
    await expect(seal.open(blob, CONTEXT + '-other')).rejects.toThrow(/could not be opened/);
  });

  test('another machine opens nothing', async () => {
    const blob = await testOnlyMachineSeal().seal(randomBytes(32), CONTEXT);
    await expect(testOnlyMachineSeal().open(blob, CONTEXT)).rejects.toThrow(/could not be opened/);
  });
});

describe('resolveMachineSeal', () => {
  test('Windows uses DPAPI by default', () => {
    expect(resolveMachineSeal({}, 'win32').kind).toBe('dpapi');
    expect(resolveMachineSeal({ ZKTRIDENT_KEY_SEAL: 'dpapi' }, 'win32').kind).toBe('dpapi');
  });

  test('a platform without a seal refuses a secured boot', () => {
    expect(() => resolveMachineSeal({}, 'linux')).toThrow(/no machine seal/);
    expect(() => resolveMachineSeal({ ZKTRIDENT_KEY_SEAL: 'dpapi' }, 'linux')).toThrow(/Windows/);
  });

  test('the development seal is only for an unsecure boot', () => {
    expect(() => resolveMachineSeal({ ZKTRIDENT_KEY_SEAL: 'development' }, 'win32')).toThrow(/unsecure/);
    expect(resolveMachineSeal({ ZKTRIDENT_KEY_SEAL: 'development', ZKTRIDENT_UNSECURE: 'true' }, 'win32').kind).toBe('development');
    expect(resolveMachineSeal({ ZKTRIDENT_UNSECURE: 'true' }, 'linux').kind).toBe('development');
  });

  test('an unknown seal is refused', () => {
    expect(() => resolveMachineSeal({ ZKTRIDENT_KEY_SEAL: 'rot13' }, 'win32')).toThrow(/rot13/);
  });
});

describe('the development seal', () => {
  test('says what it is and keeps the master in the clear', async () => {
    const seal = developmentSeal();
    expect(seal.description).toMatch(/in the clear/);
    const secret = randomBytes(32);
    const blob = await seal.seal(secret, CONTEXT);
    expect((await seal.open(blob, CONTEXT)).equals(secret)).toBe(true);
    await expect(seal.open(blob, CONTEXT + '-other')).rejects.toThrow(/another purpose/);
  });
});

const onWindows = process.platform === 'win32' ? describe : describe.skip;

onWindows('DPAPI (Windows only)', () => {
  test('opens what it sealed, for the same context only, and the blob does not carry the secret', async () => {
    const seal = dpapiSeal();
    const secret = randomBytes(32);
    const blob = await seal.seal(secret, CONTEXT);
    expect(blob.length).toBeGreaterThan(secret.length);
    expect(blob.includes(secret)).toBe(false);
    expect((await seal.open(blob, CONTEXT)).equals(secret)).toBe(true);
    await expect(seal.open(blob, CONTEXT + '-other')).rejects.toThrow(/could not be opened/);
  }, 30_000);

  test('a changed blob is refused', async () => {
    const seal = dpapiSeal();
    const blob = await seal.seal(randomBytes(32), CONTEXT);
    blob[blob.length - 5] ^= 0xff;
    await expect(seal.open(blob, CONTEXT)).rejects.toThrow(/could not be opened/);
  }, 30_000);
});
