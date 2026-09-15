'use strict';

/**
 * Zoo Code (#4746) install suite — custom-modes surface writer + CLI wiring.
 *
 * Ported from harmony-ai-solutions/gsd-roo-code tests/roo-config.test.cjs
 * (the archived Roo Code fork) with the exported zoo surface
 * (installZooModes / uninstallZooModes / resolveZooModesPath /
 * mergeZooCustomModes / stripGsdBlocksFromZooModes), extended to gsd-core
 * install standards: hermetic env/home injected into tmpdirs for every
 * in-process call, and spawned `node bin/install.js --zoo` CLI runs with
 * sandboxed HOME/USERPROFILE/APPDATA (installerEnv) — the dominant pattern of
 * sibling install suites (cline/copilot/pi).
 */

process.env.GSD_TEST_MODE = '1';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  installZooModes,
  uninstallZooModes,
  resolveZooModesPath,
  mergeZooCustomModes,
  stripGsdBlocksFromZooModes,
} = require('../bin/install.js');

const { runNode } = require('./helpers/process-seam.cjs');
const {
  installerEnv,
  INSTALL_SCRIPT,
  runMinimalInstall,
} = require('./helpers/install-shared.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');
const { cleanup, createTempDir, readFileNormalized } = require('./helpers.cjs');
const { INSTALL_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

// Two gsd-* agents with deliberate .claude/path/colon/brand payloads so the
// emitted modes exercise every roleDefinition transform.
function makeAgentsSrc(root) {
  const agentsSrc = path.join(root, 'agents');
  fs.mkdirSync(agentsSrc, { recursive: true });
  fs.writeFileSync(
    path.join(agentsSrc, 'gsd-executor.md'),
    '---\nname: gsd-executor\ndescription: Executes GSD plans\n---\n\nRead ~/.claude/config. Use /gsd:execute-phase.\n',
  );
  fs.writeFileSync(
    path.join(agentsSrc, 'gsd-review.md'),
    '---\nname: gsd-review\ndescription: Reviews work\n---\n\nReview using the `Read` tool.\n',
  );
  return agentsSrc;
}

describe('#4746 installZooModes local — .roomodes emission + merge + uninstall', () => {
  let root;
  let agentsSrc;
  let project;

  beforeEach(() => {
    root = createTempDir('gsd-zoo-local-');
    agentsSrc = makeAgentsSrc(root);
    project = path.join(root, 'project');
    fs.mkdirSync(project);
  });

  afterEach(() => cleanup(root));

  test('fresh local install writes .roomodes with customModes: + 2-space slug entries + source: project', () => {
    const res = installZooModes(project, agentsSrc, false, { env: {}, home: root });
    assert.strictEqual(res.wrote, true);
    assert.strictEqual(res.modeCount, 2);
    assert.strictEqual(res.configPath, path.join(project, '.roomodes'));

    const yaml = readFileNormalized(path.join(project, '.roomodes'));
    const lines = yaml.split('\n');
    assert.strictEqual(lines[0], 'customModes:', 'top-level customModes: header');
    assert.match(lines[1], /^ {2}- slug: gsd-[a-z]+$/, '2-space slug entry');
    assert.ok(lines.includes('    roleDefinition: |'), 'roleDefinition literal block');
    assert.ok(lines.some((l) => /^ {6}/.test(l)), '6-space literal body indent');
    assert.ok(lines.includes('    - read'), 'groups: read');
    assert.ok(lines.includes('    - edit'), 'groups: edit');
    assert.ok(lines.includes('    - command'), 'groups: command');
    assert.ok(lines.includes('    - mcp'), 'groups: mcp');
    assert.ok(lines.includes('    source: project'), 'source: project');
    assert.ok(!yaml.includes('\r'), 'LF line endings only');
    assert.ok(!yaml.includes('~/.claude'), 'no ~/.claude leftover in emitted modes');
  });

  test('roleDefinition is path-rewritten and slash-command hyphenated', () => {
    installZooModes(project, agentsSrc, false, { env: {}, home: root });
    const yaml = readFileNormalized(path.join(project, '.roomodes'));
    assert.ok(yaml.includes('Read ./.roo/config. Use /gsd-execute-phase.'), 'path + colon rewrites in roleDefinition');
    assert.ok(yaml.includes('Review using the `read_file` tool.'), 'backtick tool swap in roleDefinition');
  });

  test('re-running installZooModes is byte-idempotent', () => {
    installZooModes(project, agentsSrc, false, { env: {}, home: root });
    const first = fs.readFileSync(path.join(project, '.roomodes'), 'utf8');
    installZooModes(project, agentsSrc, false, { env: {}, home: root });
    const second = fs.readFileSync(path.join(project, '.roomodes'), 'utf8');
    assert.strictEqual(second, first, 're-run must produce byte-identical .roomodes');
  });

  test('merge preserves a pre-existing user mode byte-for-byte', () => {
    const existing = [
      'customModes:',
      '  - slug: user-mode',
      '    name: User Mode',
      '    roleDefinition: |',
      '      Keep me.',
      '    groups:',
      '    - read',
    ].join('\n') + '\n';
    const merged = mergeZooCustomModes(existing, [
      { slug: 'gsd-executor', name: 'gsd-executor', roleDefinition: 'X', groups: ['read', 'edit', 'command', 'mcp'], source: 'project' },
    ]);
    assert.ok(merged.startsWith(existing), 'user block preserved verbatim');
    assert.ok(merged.includes('  - slug: gsd-executor'), 'gsd entry appended');
    assert.ok(!merged.includes('slug: gsd-old'), 'no stale gsd block');
  });

  test('install over a user-mode file preserves it and appends gsd modes', () => {
    const roomodes = path.join(project, '.roomodes');
    fs.writeFileSync(roomodes, 'customModes:\n  - slug: user-mode\n    name: User Mode\n    roleDefinition: |\n      Keep me.\n    groups:\n    - read\n');
    installZooModes(project, agentsSrc, false, { env: {}, home: root });
    const yaml = readFileNormalized(roomodes);
    assert.ok(yaml.includes('slug: user-mode'), 'user mode survives install');
    assert.ok(yaml.includes('slug: gsd-executor'), 'gsd mode added');
  });

  test('uninstall strips gsd-* blocks and keeps the user mode', () => {
    const roomodes = path.join(project, '.roomodes');
    fs.writeFileSync(roomodes, 'customModes:\n  - slug: user-mode\n    name: User Mode\n    roleDefinition: |\n      Keep me.\n    groups:\n    - read\n');
    installZooModes(project, agentsSrc, false, { env: {}, home: root });
    assert.ok(fs.readFileSync(roomodes, 'utf8').includes('slug: gsd-executor'), 'gsd mode present before uninstall');
    const rc = uninstallZooModes(project, false, { env: {}, home: root });
    assert.strictEqual(rc, 1);
    const after = readFileNormalized(roomodes);
    assert.ok(after.includes('slug: user-mode'), 'user mode intact');
    assert.ok(!after.includes('slug: gsd-executor'), 'gsd mode stripped');
    assert.ok(!after.includes('slug: gsd-review'), 'all gsd modes stripped');
  });

  test('uninstall deletes .roomodes when it becomes GSD-only', () => {
    const roomodes = path.join(project, '.roomodes');
    installZooModes(project, agentsSrc, false, { env: {}, home: root });
    assert.ok(fs.existsSync(roomodes));
    const rc = uninstallZooModes(project, false, { env: {}, home: root });
    assert.strictEqual(rc, 1);
    assert.ok(!fs.existsSync(roomodes), 'GSD-only .roomodes must be deleted');
  });

  test('uninstall returns 0 and leaves a gsd-free file untouched', () => {
    const roomodes = path.join(project, '.roomodes');
    const userOnly = 'customModes:\n  - slug: user-mode\n    name: User Mode\n';
    fs.writeFileSync(roomodes, userOnly);
    const rc = uninstallZooModes(project, false, { env: {}, home: root });
    assert.strictEqual(rc, 0);
    assert.strictEqual(fs.readFileSync(roomodes, 'utf8'), userOnly, 'file byte-identical');
  });

  test('installZooModes reports wrote:false when agentsSrc is absent/empty/non-gsd', () => {
    assert.deepStrictEqual(
      installZooModes(project, path.join(root, 'absent'), false, { env: {}, home: root }),
      { configPath: null, modeCount: 0, wrote: false },
    );
    const emptyAgents = path.join(root, 'empty-agents');
    fs.mkdirSync(emptyAgents);
    assert.deepStrictEqual(
      installZooModes(project, emptyAgents, false, { env: {}, home: root }),
      { configPath: null, modeCount: 0, wrote: false },
    );
    const userAgents = path.join(root, 'user-agents');
    fs.mkdirSync(userAgents);
    fs.writeFileSync(path.join(userAgents, 'user-agent.md'), '---\nname: user-agent\n---\n');
    assert.deepStrictEqual(
      installZooModes(project, userAgents, false, { env: {}, home: root }),
      { configPath: null, modeCount: 0, wrote: false },
    );
    assert.ok(!fs.existsSync(path.join(project, '.roomodes')), 'no .roomodes written on wrote:false');
  });

  test('stripGsdBlocksFromZooModes returns null for GSD-only content, else cleaned content', () => {
    const gsdOnly = 'customModes:\n  - slug: gsd-executor\n    name: X\n  - slug: gsd-review\n    name: Y\n';
    assert.strictEqual(stripGsdBlocksFromZooModes(gsdOnly), null, 'GSD-only -> null (caller deletes)');
    const mixed = 'customModes:\n  - slug: user-mode\n    name: U\n  - slug: gsd-executor\n    name: X\n';
    const cleaned = stripGsdBlocksFromZooModes(mixed);
    assert.ok(cleaned.includes('slug: user-mode'), 'user block kept');
    assert.ok(!cleaned.includes('slug: gsd-executor'), 'gsd block stripped');
  });
});

describe('#4746 installZooModes global — custom_modes.yaml + source: global', () => {
  let root;
  let agentsSrc;
  let env;

  beforeEach(() => {
    root = createTempDir('gsd-zoo-global-');
    agentsSrc = makeAgentsSrc(root);
    env = { APPDATA: path.join(root, 'appdata'), HOME: root, USERPROFILE: root };
  });

  afterEach(() => cleanup(root));

  test('writes the VS Code globalStorage modes file with source: global', () => {
    const targetDir = path.join(root, '.roo');
    const res = installZooModes(targetDir, agentsSrc, true, { env, home: root });
    assert.strictEqual(res.wrote, true);
    const modesPath = path.join(root, 'appdata', 'Code', 'User', 'globalStorage', 'zoocodeorganization.zoo-code', 'settings', 'custom_modes.yaml');
    assert.strictEqual(res.configPath, modesPath);
    assert.ok(fs.existsSync(modesPath), 'global modes file must exist');
    const yaml = readFileNormalized(modesPath);
    assert.ok(yaml.includes('customModes:'), 'customModes: header');
    assert.ok(yaml.includes('source: global'), 'source: global');
    assert.ok(!yaml.includes('~/.claude'), 'no ~/.claude leftover');
  });

  test('uninstall removes a GSD-only global modes file', () => {
    const targetDir = path.join(root, '.roo');
    installZooModes(targetDir, agentsSrc, true, { env, home: root });
    const modesPath = path.join(root, 'appdata', 'Code', 'User', 'globalStorage', 'zoocodeorganization.zoo-code', 'settings', 'custom_modes.yaml');
    assert.ok(fs.existsSync(modesPath));
    const rc = uninstallZooModes(targetDir, true, { env, home: root });
    assert.strictEqual(rc, 1);
    assert.ok(!fs.existsSync(modesPath), 'GSD-only global modes file must be deleted');
  });
});

describe('#4746 resolveZooModesPath platform branches', () => {
  const SUFFIX = path.join('globalStorage', 'zoocodeorganization.zoo-code', 'settings', 'custom_modes.yaml');

  test('win32 APPDATA branch (live shape on this Windows host)', () => {
    const env = { APPDATA: path.join('C:', 'Users', 'test', 'AppData', 'Roaming') };
    const p = resolveZooModesPath('/proj', true, { env, home: '/home/u', platform: 'win32' });
    assert.strictEqual(p, path.join(env.APPDATA, 'Code', 'User', SUFFIX));
  });

  test('win32 falls back to <home>/AppData/Roaming when APPDATA is unset', () => {
    const p = resolveZooModesPath('/proj', true, { env: {}, home: '/home/u', platform: 'win32' });
    assert.strictEqual(p, path.join('/home/u', 'AppData', 'Roaming', 'Code', 'User', SUFFIX));
  });

  test('darwin branch resolves ~/Library/Application Support/Code/User', () => {
    const p = resolveZooModesPath('/proj', true, { env: {}, home: '/Users/u', platform: 'darwin' });
    assert.strictEqual(p, path.join('/Users/u', 'Library', 'Application Support', 'Code', 'User', SUFFIX));
  });

  test('linux branch resolves ~/.config/Code/User', () => {
    const p = resolveZooModesPath('/proj', true, { env: {}, home: '/home/u', platform: 'linux' });
    assert.strictEqual(p, path.join('/home/u', '.config', 'Code', 'User', SUFFIX));
  });

  test('local branch resolves <targetDir>/.roomodes', () => {
    const p = resolveZooModesPath('/proj', false, { env: {}, home: '/home/u' });
    assert.strictEqual(p, path.join('/proj', '.roomodes'));
  });
});

describe('#4746 manifest vectors — flat commands/gsd-*.md, never nested commands/gsd/', () => {
  test('global install manifest tracks flat commands/gsd-*.md and not nested commands/gsd/', (t) => {
    const { manifest, root } = runMinimalInstall({ runtime: 'zoo', scope: 'global' });
    t.after(() => cleanup(root));
    const keys = Object.keys(manifest.files);
    const flat = keys.filter((k) => k.startsWith('commands/') && k.split('/').length === 2);
    assert.ok(flat.some((k) => k === 'commands/gsd-execute-phase.md'), 'flat commands/gsd-*.md tracked');
    assert.ok(flat.length > 0, 'flat commands surface tracked');
    const nested = keys.filter((k) => k.startsWith('commands/gsd/'));
    assert.deepStrictEqual(nested, [], 'nested commands/gsd/ must NOT be tracked');
  });

  test('global install manifest does not track the outside-configDir custom_modes.yaml', (t) => {
    const { manifest, root } = runMinimalInstall({ runtime: 'zoo', scope: 'global' });
    t.after(() => cleanup(root));
    const keys = Object.keys(manifest.files);
    assert.ok(!keys.some((k) => k.includes('custom_modes.yaml')), 'globalStorage modes file is not manifest-tracked');
  });

  test('local install manifest tracks .roomodes and .roo/commands/gsd-*.md', (t) => {
    const { manifest, root } = runMinimalInstall({ runtime: 'zoo', scope: 'local' });
    t.after(() => cleanup(root));
    const keys = Object.keys(manifest.files);
    assert.ok(keys.includes('.roomodes'), '.roomodes tracked at project root');
    assert.ok(keys.some((k) => k === '.roo/commands/gsd-execute-phase.md'), '.roo/commands/gsd-*.md tracked');
    assert.deepStrictEqual(keys.filter((k) => k.startsWith('commands/gsd/')), [], 'no nested commands/gsd/');
  });
});

describe('#4746 CLI smoke — spawned node bin/install.js --zoo', () => {
  function zooEnv(root) {
    return installerEnv({ HOME: root, USERPROFILE: root, APPDATA: path.join(root, 'appdata') });
  }

  function runZooCli(args, cwd, env) {
    return runNode([INSTALL_SCRIPT, ...args], { cwd, env, timeoutMs: INSTALL_TIMEOUT_MS });
  }

  test('--zoo --local emits .roomodes + .roo/commands/gsd-*.md with no .claude leftovers', (t) => {
    const root = createTempDir('gsd-zoo-cli-local-');
    t.after(() => cleanup(root));
    gitOrThrow(['init'], { cwd: root });
    const env = zooEnv(root);
    const res = runZooCli(['--zoo', '--local'], root, env);
    assert.strictEqual(res.exitCode, 0, `installer failed: ${res.stderr}`);

    const roomodes = path.join(root, '.roomodes');
    assert.ok(fs.existsSync(roomodes), '.roomodes must exist after --zoo --local');
    const modes = readFileNormalized(roomodes);
    assert.ok(modes.includes('customModes:'), 'customModes: header');
    assert.ok(modes.includes('source: project'), 'source: project');
    assert.ok(!modes.includes('~/.claude'), 'no ~/.claude in .roomodes');

    const commandsDir = path.join(root, '.roo', 'commands');
    assert.ok(fs.existsSync(commandsDir), '.roo/commands must exist');
    const cmdFiles = fs.readdirSync(commandsDir).filter((f) => f.startsWith('gsd-') && f.endsWith('.md'));
    assert.ok(cmdFiles.length > 0, 'gsd-*.md command files must exist');
    for (const file of cmdFiles) {
      const content = readFileNormalized(path.join(commandsDir, file));
      assert.ok(!content.includes('~/.claude/'), `${file} must not reference ~/.claude/`);
      assert.ok(!content.includes('$HOME/.claude/'), `${file} must not reference $HOME/.claude/`);
    }
  });

  test('--zoo --local --uninstall removes .roomodes and the gsd-*.md commands', (t) => {
    const root = createTempDir('gsd-zoo-cli-local-un-');
    t.after(() => cleanup(root));
    const env = zooEnv(root);
    const installRes = runZooCli(['--zoo', '--local'], root, env);
    assert.strictEqual(installRes.exitCode, 0, `install failed: ${installRes.stderr}`);
    assert.ok(fs.existsSync(path.join(root, '.roomodes')));
    assert.ok(fs.existsSync(path.join(root, 'gsd-file-manifest.json')));

    const uninstallRes = runZooCli(['--zoo', '--local', '--uninstall'], root, env);
    assert.strictEqual(uninstallRes.exitCode, 0, `uninstall failed: ${uninstallRes.stderr}`);
    assert.ok(!fs.existsSync(path.join(root, '.roomodes')), '.roomodes removed (was GSD-only)');
    assert.ok(!fs.existsSync(path.join(root, 'gsd-file-manifest.json')), 'manifest removed');
    const commandsDir = path.join(root, '.roo', 'commands');
    if (fs.existsSync(commandsDir)) {
      const remaining = fs.readdirSync(commandsDir).filter((f) => f.startsWith('gsd-') && f.endsWith('.md'));
      assert.deepStrictEqual(remaining, [], 'all gsd-*.md commands removed');
    }
  });

  test('--zoo --global writes globalStorage modes + ~/.roo/commands; uninstall removes them', (t) => {
    const root = createTempDir('gsd-zoo-cli-global-');
    t.after(() => cleanup(root));
    const env = zooEnv(root);
    const installRes = runZooCli(['--zoo', '--global'], root, env);
    assert.strictEqual(installRes.exitCode, 0, `install failed: ${installRes.stderr}`);

    const modesPath = path.join(root, 'appdata', 'Code', 'User', 'globalStorage', 'zoocodeorganization.zoo-code', 'settings', 'custom_modes.yaml');
    assert.ok(fs.existsSync(modesPath), 'global custom_modes.yaml must exist');
    const modes = readFileNormalized(modesPath);
    assert.ok(modes.includes('source: global'), 'source: global');
    assert.ok(!modes.includes('~/.claude'), 'no ~/.claude in global modes');

    const commandsDir = path.join(root, '.roo', 'commands');
    assert.ok(fs.existsSync(commandsDir), '~/.roo/commands must exist');
    const cmdFiles = fs.readdirSync(commandsDir).filter((f) => f.startsWith('gsd-') && f.endsWith('.md'));
    assert.ok(cmdFiles.length > 0, 'gsd-*.md commands under ~/.roo/commands');

    const uninstallRes = runZooCli(['--zoo', '--global', '--uninstall'], root, env);
    assert.strictEqual(uninstallRes.exitCode, 0, `uninstall failed: ${uninstallRes.stderr}`);
    assert.ok(!fs.existsSync(modesPath), 'GSD-only global modes file removed');
    if (fs.existsSync(commandsDir)) {
      const remaining = fs.readdirSync(commandsDir).filter((f) => f.startsWith('gsd-') && f.endsWith('.md'));
      assert.deepStrictEqual(remaining, [], 'all gsd-*.md commands removed');
    }
  });
});