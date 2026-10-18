/**
 * The launcher hands each child exactly its own credential — plan item A9 (remainder), finding A-14.
 *
 * Structural: the boot script keys every node it spawns and registers the key by role before the
 * spawn, passes the operator's token to no child, gives the insurer its own token, scrubs its
 * environment for every child including the explorer and the proof workers, and spawns without a
 * shell. The start scripts read their key and watch their parent.
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

  test('passes the operator token to no child; the insurer gets a token of its own', () => {
    expect(boot).not.toMatch(/ZKTRIDENT_ADMIN_TOKEN: adminToken/);
    expect(boot).toMatch(/ZKTRIDENT_ADMIN_TOKEN: insurerAdminToken/);
    expect(boot).toMatch(/env\.ZKTRIDENT_INSURER_ADMIN_TOKEN\s*\n?\s*\?\? \(adminToken \? deriveNodeAdminToken\(adminToken, 'insurer'\)/);
    // the three nodes without admin routes get no token at all
    for (const role of ['prescriber', 'pharmacy', 'member']) {
      const call = boot.slice(boot.indexOf(`spawnEntity('${role}'`), boot.indexOf('});', boot.indexOf(`spawnEntity('${role}'`)));
      expect(call).not.toMatch(/ADMIN_TOKEN/);
    }
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
