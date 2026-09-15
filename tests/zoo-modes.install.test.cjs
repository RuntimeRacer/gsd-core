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

// ─── Zoo loader fidelity (#4746 follow-up) ─────────────────────────────────────
//
// Reproduces Zoo's ACTUAL mode-loading pipeline from the shipped bundle
// (zoocodeorganization.zoo-code-3.82.1, CustomModesManager):
//   1. strip a leading BOM
//   2. cleanInvisibleCharacters() over the RAW text BEFORE parsing:
//      U+00A0→space, U+200B-200D deleted, U+2018/2019→', U+201C/201D→",
//      U+2010-2015 + U+2212→'-'
//   3. YAML parse (any error ⇒ whole document discarded)
//   4. zod schema over the WHOLE {customModes:[...]} document — ONE violating
//      mode fails safeParse and Zoo returns [] (falls back to default modes):
//      slug /^[a-zA-Z0-9-]+$/, name min 1, roleDefinition min 1,
//      whenToUse/description/customInstructions optional strings, groups ⊆
//      [read,edit,command,mcp,modes] (or [group, {fileRegex, description}]
//      tuples) with no duplicate group keys, source ∈ {global, project},
//      no duplicate slugs (document-level refine).
// This suite exists because the real-world global install shipped 29 dotted
// `.compact` slugs that Zoo's schema silently discarded wholesale.
const ZOO_SLUG_RE = /^[a-zA-Z0-9-]+$/;
const ZOO_GROUP_ENUM = new Set(['read', 'edit', 'command', 'mcp', 'modes']);
// Built from char codes (not a literal class): the U+200B-200D members make
// eslint's no-misleading-character-class reject a regex literal character
// class, and semantically we want exactly these code points regardless of how
// an editor/font renders them.
const ZOO_PROBLEMATIC = new RegExp(
  '[' + [0x00a0, 0x200b, 0x200c, 0x200d, 0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015, 0x2212, 0x2018, 0x2019, 0x201c, 0x201d]
    .map((c) => String.fromCharCode(c)).join('') + ']',
  'g',
);

function zooCleanInvisible(text) {
  return text.replace(ZOO_PROBLEMATIC, (r) => {
    switch (r) {
      case '\u00A0': return ' ';
      case '\u200B': case '\u200C': case '\u200D': return '';
      case '\u2018': case '\u2019': return "'";
      case '\u201C': case '\u201D': return '"';
      default: return '-';
    }
  });
}

/** Parse + schema-validate exactly like Zoo's CustomModesManager. Returns
 *  `{ modes, violations, parseError }` — Zoo loads `modes` only when both
 *  `violations` and `parseError` are empty. */
function simulateZooLoad(rawText) {
  const yaml = require('js-yaml');
  const text = rawText.charCodeAt(0) === 0xfeff ? rawText.slice(1) : rawText;
  let doc;
  try {
    doc = yaml.load(zooCleanInvisible(text));
  } catch (e) {
    return { modes: [], violations: [], parseError: e.message };
  }
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.customModes)) {
    return { modes: [], violations: ['document: customModes array missing'], parseError: '' };
  }
  const violations = [];
  const seenSlugs = new Set();
  for (const m of doc.customModes) {
    const where = `mode ${(m && m.slug) || '<no slug>'}`;
    if (typeof m.slug !== 'string' || !ZOO_SLUG_RE.test(m.slug)) violations.push(`${where}: slug fails /^[a-zA-Z0-9-]+$/`);
    if (seenSlugs.has(m.slug)) violations.push(`${where}: duplicate slug`);
    seenSlugs.add(m.slug);
    if (typeof m.name !== 'string' || m.name.length < 1) violations.push(`${where}: name min 1`);
    if (typeof m.roleDefinition !== 'string' || m.roleDefinition.length < 1) violations.push(`${where}: roleDefinition min 1`);
    if (m.source !== undefined && !['global', 'project'].includes(m.source)) violations.push(`${where}: source enum`);
    if (m.groups !== undefined) {
      if (!Array.isArray(m.groups)) violations.push(`${where}: groups not an array`);
      else {
        const seenGroups = new Set();
        for (const g of m.groups) {
          const key = Array.isArray(g) ? g[0] : g;
          if (seenGroups.has(key)) violations.push(`${where}: duplicate group ${key}`);
          seenGroups.add(key);
          if (typeof g === 'string') {
            if (!ZOO_GROUP_ENUM.has(g)) violations.push(`${where}: group '${g}' not in Zoo enum`);
          } else if (Array.isArray(g) && g.length === 2 && typeof g[0] === 'string' && ZOO_GROUP_ENUM.has(g[0]) && g[1] && typeof g[1] === 'object') {
            // [group, {fileRegex, description}] tuple — valid
          } else {
            violations.push(`${where}: malformed group entry ${JSON.stringify(g)}`);
          }
        }
      }
    }
  }
  return { modes: doc.customModes, violations, parseError: '' };
}

describe('#4746 Zoo loader fidelity — emitted modes must survive Zoo\'s real load pipeline', () => {
  let root;
  let agentsSrc;
  let project;

  beforeEach(() => {
    root = createTempDir('gsd-zoo-fidelity-');
    agentsSrc = path.join(root, 'agents');
    fs.mkdirSync(agentsSrc, { recursive: true });
    fs.writeFileSync(
      path.join(agentsSrc, 'gsd-executor.md'),
      '---\nname: gsd-executor\ndescription: Executes GSD plans\n---\n\nBody with an em-dash — and text.',
    );
    // A .compact.md payload variant in the source tree — it must NOT become a
    // mode (option A); it stays a file for the agent-skills seam.
    fs.writeFileSync(
      path.join(agentsSrc, 'gsd-advisor-researcher.compact.md'),
      '---\nname: gsd-advisor-researcher\ndescription: Compact advisor variant\n---\n\nCompact body.',
    );
    // Curly quotes + colon force the quoted branch AND Zoo's pre-parse cleaner.
    // The NBSP sits in `name` (frontmatter name passes through un-normalized,
    // unlike the toSingleLine'd description, where JS \s would collapse it).
    fs.writeFileSync(
      path.join(agentsSrc, 'gsd-curator.md'),
      '---\nname: gsd\u00A0curator\ndescription: Curates \u201Csmart\u201D quotes\u00A0and: colons\n---\n\nCurator body.',
    );
    project = path.join(root, 'project');
    fs.mkdirSync(project);
  });

  afterEach(() => cleanup(root));

  test('.compact variants are EXCLUDED from the modes surface — canonical agents only (option A; regression: 29 dotted slugs + inert same-named picker entries)', () => {
    const res = installZooModes(project, agentsSrc, false, { env: {}, home: root });
    assert.strictEqual(res.wrote, true);
    // gsd-executor + gsd-curator become modes; the .compact.md payload variant
    // does not (it stays a file in agentsSrc for the agent-skills seam).
    assert.strictEqual(res.modeCount, 2);

    const raw = fs.readFileSync(path.join(project, '.roomodes'), 'utf8');
    const { modes, violations, parseError } = simulateZooLoad(raw);
    assert.strictEqual(parseError, '', `Zoo parse failed: ${parseError}`);
    assert.deepStrictEqual(violations, [], 'Zoo schema violations');
    assert.strictEqual(modes.length, 2, 'only canonical agents load as modes');
    assert.ok(modes.some((m) => m.slug === 'gsd-executor'), 'canonical agent present');
    assert.ok(!modes.some((m) => m.slug.endsWith('-compact')), 'no compact-variant mode');
    assert.ok(!modes.some((m) => m.slug.includes('.')), 'no dotted slugs survive');
    assert.ok(!raw.includes('Compact advisor variant'), 'compact payload content not emitted as a mode');
  });

  test('curly quotes / NBSP in whenToUse survive Zoo\'s pre-parse cleaner with values intact', () => {
    installZooModes(project, agentsSrc, false, { env: {}, home: root });
    const raw = readFileNormalized(path.join(project, '.roomodes'));
    // The syntax-killer class — curly quotes — must never appear raw in a
    // QUOTED scalar line: Zoo's cleaner would turn them into unescaped ASCII
    // quotes inside our double-quoted string. (Raw dashes/NBSP inside
    // roleDefinition block bodies are content-safe and stay literal.)
    const quotedScalarLines = raw.split('\n').filter((l) => /: "/.test(l));
    for (const line of quotedScalarLines) {
      assert.ok(!/[\u2018\u2019\u201C\u201D]/.test(line), `raw curly quote in quoted scalar: ${line}`);
    }

    const { modes, violations, parseError } = simulateZooLoad(raw);
    assert.strictEqual(parseError, '', `Zoo parse failed: ${parseError}`);
    assert.deepStrictEqual(violations, [], 'Zoo schema violations');
    const curator = modes.find((m) => m.slug === 'gsd-curator');
    assert.ok(curator, 'curator mode present');
    assert.strictEqual(curator.name, 'gsd\u00A0curator', 'NBSP in name round-trips through the \\u00a0 escape');
    assert.strictEqual(
      curator.whenToUse,
      // toSingleLine collapses the NBSP (JS \s matches U+00A0) before emission;
      // the curly quotes survive verbatim via the \uXXXX escapes.
      'Curates \u201Csmart\u201D quotes and: colons',
      'escaped scalar decodes to the original value (NBSP normalized by toSingleLine)',
    );
  });

  test('global merge keeps a native Zoo-written user mode (nested groups, block customInstructions, emoji name) loadable', () => {
    // Shape lifted from a real Zoo-written custom_modes.yaml (v3.82): emoji
    // name, |- customInstructions, nested `groups: - - edit` fileRegex tuple.
    const nativeUserMode = [
      'customModes:',
      '  - slug: architect',
      '    name: \u{1F3EF} Solutions Architect',
      '    roleDefinition: You are Zoo, an experienced technical leader.',
      '    whenToUse: Use this mode to plan before implementation.',
      '    customInstructions: |-',
      '      1. Gather context.',
      '',
      '      2. Ask clarifying questions.',
      '    groups:',
      '      - read',
      '      - command',
      '      - mcp',
      '      - - edit',
      '        - fileRegex: \\.(md|toon)$',
      '          description: Markdown / TOON files only',
      '    source: global',
    ].join('\n') + '\n';

    const globalDir = path.join(root, 'roo-home');
    fs.mkdirSync(globalDir, { recursive: true });
    const modesPath = resolveZooModesPath(globalDir, true, { env: { APPDATA: path.join(root, 'appdata') }, home: root });
    fs.mkdirSync(path.dirname(modesPath), { recursive: true });
    fs.writeFileSync(modesPath, nativeUserMode);

    const res = installZooModes(globalDir, agentsSrc, true, { env: { APPDATA: path.join(root, 'appdata') }, home: root });
    assert.strictEqual(res.wrote, true);

    const merged = fs.readFileSync(modesPath, 'utf8');
    assert.ok(merged.includes('  - slug: architect'), 'native user mode block kept');
    assert.ok(merged.includes('- - edit'), 'nested group tuple preserved verbatim');
    assert.ok(!merged.includes('~/.claude'), 'no path leftovers');

    const { modes, violations, parseError } = simulateZooLoad(merged);
    assert.strictEqual(parseError, '', `Zoo parse failed: ${parseError}`);
    assert.deepStrictEqual(violations, [], 'merged document fully schema-valid');
    assert.strictEqual(modes.length, 3, 'user mode + 2 canonical gsd modes (compact variants excluded)');
    const architect = modes.find((m) => m.slug === 'architect');
    assert.strictEqual(architect.name, '\u{1F3EF} Solutions Architect', 'emoji name intact');
    assert.deepStrictEqual(
      architect.groups[3],
      ['edit', { fileRegex: '\\.(md|toon)$', description: 'Markdown / TOON files only' }],
      'nested group tuple parses to Zoo\'s [group, {fileRegex}] shape',
    );
  });

  test('slug sanitation collisions dedupe last-wins instead of emitting duplicate slugs Zoo would reject', () => {
    // Two CANONICAL (non-.compact) stems that sanitize onto the same slug:
    // space and underscore both fold to '-' (compact variants can no longer
    // collide — they are excluded from the modes surface entirely).
    fs.writeFileSync(
      path.join(agentsSrc, 'gsd-a b.md'),
      '---\ndescription: spaced sibling\n---\n\nSpaced body.',
    );
    fs.writeFileSync(
      path.join(agentsSrc, 'gsd-a_b.md'),
      '---\ndescription: underscore sibling sanitizes onto the same slug\n---\n\nUnderscore body.',
    );
    const res = installZooModes(project, agentsSrc, false, { env: {}, home: root });
    // gsd-executor + gsd-curator (compact variant excluded) + the two
    // colliding siblings folding into one entry.
    assert.strictEqual(res.modeCount, 3, 'collision folds to one entry');

    const raw = fs.readFileSync(path.join(project, '.roomodes'), 'utf8');
    const { modes, violations, parseError } = simulateZooLoad(raw);
    assert.strictEqual(parseError, '', `Zoo parse failed: ${parseError}`);
    assert.deepStrictEqual(violations, [], 'no duplicate-slug rejection');
    const folded = modes.filter((m) => m.slug === 'gsd-a-b');
    assert.strictEqual(folded.length, 1, 'single gsd-a-b entry (last wins)');
    // Block scalars clip-chomp to one trailing \n — compare trimmed.
    assert.strictEqual(folded[0].roleDefinition.trim(), 'Underscore body.', 'last entry wins');
  });
});