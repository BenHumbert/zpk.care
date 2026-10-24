/**
 * The launcher hands each child exactly its own credential — plan item A9 (remainder), finding A-14.
 *
 * Structural: the boot script keys every node it spawns and registers the key by role before the
 * spawn, passes the operator's token to no child, gives the insurer and the prescriber tokens of
 * their own, scrubs its environment for every child including the explorer and the proof workers,
 * and spawns without a shell. The start scripts read their key and watch their parent.
 *
 * The prescriber's token (owner decision 2026-10-19): until provider sign-in (B4) the prescriber
 * node's patient-price and prior-authorization routes answer only that node's administrator, so a
 * prescriber node started without a token refused everyone and the feature could not be used on a
 * network the launcher booted.
 */
import fs from 'fs';
import path from 'path';

const REPO = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf8');

describe('start-leviathan.ts', () => {
  const boot = read('src/nodes/start-leviathan.ts');

  test('keys each child and registers the key with its role before spawning it', () => {
    expect(boot).toMatch(/const nodeKey = generateNodeKey\(name\);\s*\n\s*rpcServer\.registerNodeKey\(nodeKey\.nodeId, nodeKey\.publicKeyHex, role/);
    expect(boot).toMatch(/\[NODE_ID_ENV\]: nodeKey\.nodeId/);
    expect(boot).toMatch(/\[NODE_KEY_SEED_ENV\]: nodeKey\.seedHex/);
    expect(boot).toMatch(/childEnvironment\(process\.env, \{/);
  });

  test('passes the operator token to no child; the insurer and the prescriber get tokens of their own', () => {
    expect(boot).not.toMatch(/ZKTRIDENT_ADMIN_TOKEN: adminToken/);
    expect(boot).toMatch(/ZKTRIDENT_ADMIN_TOKEN: insurerAdminToken/);
    expect(boot).toMatch(/env\.ZKTRIDENT_INSURER_ADMIN_TOKEN\s*\n?\s*\?\? \(adminToken \? deriveNodeAdminToken\(adminToken, 'insurer'\)/);
    const spawnCall = (role: string) => boot.slice(boot.indexOf(`spawnEntity('${role}'`), boot.indexOf('});', boot.indexOf(`spawnEntity('${role}'`)));
    // the prescriber's own token, explicit or derived from the operator's as the insurer's is
    expect(spawnCall('prescriber')).toMatch(/ZKTRIDENT_ADMIN_TOKEN: prescriberAdminToken/);   // before: no token, every patient route 401
    expect(boot).toMatch(/env\.ZKTRIDENT_PRESCRIBER_ADMIN_TOKEN\s*\n?\s*\?\? \(adminToken \? deriveNodeAdminToken\(adminToken, 'prescriber'\)/);
    // the two nodes without admin routes get no token at all
    for (const role of ['pharmacy', 'member']) expect(spawnCall(role)).not.toMatch(/ADMIN_TOKEN/);
  });

  test('a node\'s own token variable is a secret that no child inherits', async () => {
    const { SECRET_ENV_KEYS, childEnvironment } = await import('../src/security/node-roles.js');
    for (const key of ['ZKTRIDENT_INSURER_ADMIN_TOKEN', 'ZKTRIDENT_PRESCRIBER_ADMIN_TOKEN']) {
      expect(SECRET_ENV_KEYS).toContain(key);
      expect(childEnvironment({ [key]: 'node-token', PATH: '/bin' }, {})).toEqual({ PATH: '/bin' });
    }
  });

  test('a secret is held back whatever the case of its name (Windows reads names case-insensitively)', async () => {
    const { childEnvironment } = await import('../src/security/node-roles.js');
    const env = childEnvironment({
      zktrident_node_key_seed: 'a'.repeat(64), Zktrident_Admin_Token: 'operator', zktrident_gossip_secret: 'gossip', PATH: '/bin',
    }, {});
    expect(env).toEqual({ PATH: '/bin' });                              // before: the three lower- and mixed-case names came through
  });

  test('spawns children under this Node with tsx, without a shell, and names itself as the parent', () => {
    expect(boot).not.toMatch(/spawn\('npx'/);
    expect(boot).not.toMatch(/shell: true/);
    expect((boot.match(/spawn\(process\.execPath, \['--import', 'tsx'/g) ?? []).length).toBe(3); // nodes, explorer, prover
    expect((boot.match(/ZKTRIDENT_PARENT_PID: String\(process\.pid\)/g) ?? []).length).toBe(3);
  });

  test('the explorer gets a scrubbed environment and no key', () => {
    const explorer = boot.slice(boot.indexOf("spawn(process.execPath, ['--import', 'tsx', explorerScript]"), boot.indexOf('entityChildren.push({ name: \'explorer\''));
    expect(explorer).toMatch(/childEnvironment\(process\.env, \{ ZKTRIDENT_EXPLORER_PORT/);
    expect(explorer).not.toMatch(/NODE_KEY_SEED|ADMIN_TOKEN/);
  });
});

describe('the start scripts', () => {
  for (const role of ['member', 'prescriber', 'pharmacy', 'insurer']) {
    test(`${role} reads its node key and watches its parent`, () => {
      const src = read(`src/nodes/start-${role}-nautilus.ts`);
      expect(src).toMatch(/nodeKey: nodeKeyFromEnv\(env\) \?\? undefined/);
      expect(src).toMatch(/watchParent\(\{/);
      expect(src).toMatch(/parentPidFromEnv\(\)/);
    });
  }

  test('no node presents a bearer token to the sequencer any more', () => {
    const nodeFiles = fs.readdirSync(path.join(REPO, 'src/nodes')).filter((f) => f.endsWith('.ts')).map((f) => `src/nodes/${f}`)
      .concat(fs.readdirSync(path.join(REPO, 'src/nodes/routes')).filter((f) => f.endsWith('.ts')).map((f) => `src/nodes/routes/${f}`));
    const offenders: string[] = [];
    for (const rel of nodeFiles) {
      const src = read(rel);
      if (/clientOptions: [^\n]*adminToken/.test(src)) offenders.push(`${rel}: clientOptions carries adminToken`);
      if (/Bearer \$\{(adminToken|insurerAdminToken)\}|'Bearer ' \+ adminToken/.test(src)) offenders.push(`${rel}: hand-built bearer header`);
    }
    expect(offenders).toEqual([]);
  });
});

describe('the proof workers', () => {
  test('are forked with a scrubbed environment', () => {
    for (const rel of ['src/adjudication/proof-pool.ts', 'src/l2/l2-proving-pool.ts', 'src/l2/l2-verify-pool.ts']) {
      expect(read(rel)).toMatch(/env: childEnvironment\(process\.env, \{\}\)/);
    }
  });
});
