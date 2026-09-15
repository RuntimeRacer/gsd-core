'use strict';

/**
 * Zoo Code (#4746) — config + artifact-conversion unit tests.
 *
 * Ported from harmony-ai-solutions/gsd-roo-code tests/roo-config.test.cjs (the
 * archived Roo Code fork), adapted to the Zoo Code runtime names/shapes
 * (convertClaudeCommandToZooCommand / convertClaudeAgentToZooModeEntry) and to
 * gsd-core test standards: every env/home interaction injects a tmpdir (never
 * the real home), and assertions target frozen values / function returns.
 *
 * The path-replacement vectors are exercised THROUGH
 * convertClaudeCommandToZooCommand: replacePathsForZoo is deliberately not part
 * of the compiled module's export surface (#4746 Phase 3 exposes the command
 * converter), and the old fork's standalone path-rewrite shape is exactly the
 * command converter's step 4.
 */

process.env.GSD_TEST_MODE = '1';

const { test, describe, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fc = require('./helpers/fast-check-setup.cjs');

const {
  convertClaudeCommandToZooCommand,
  convertClaudeAgentToZooModeEntry,
} = require('../gsd-core/bin/lib/runtime-artifact-conversion.cjs');

const { getGlobalConfigDir } = require('../gsd-core/bin/lib/runtime-homes.cjs');
const { canonicalizeRuntimeName } = require('../gsd-core/bin/lib/runtime-name-policy.cjs');

const { scrubConfigLocationEnv, createTempDir, cleanup } = require('./helpers.cjs');

// Trailing-slash path prefix the ported path-rewrite emits for the
// `~/.claude` / `$HOME/.claude` forms (old-fork vector shape).
const ROO_PREFIX = '/home/user/.roo/';

// ─── replacePathsForZoo vectors (via convertClaudeCommandToZooCommand) ───────

describe('#4746 Zoo path replacement (ported replacePathsForRoo vectors)', () => {
  test('~/.claude/file.md tilde path replaced', () => {
    const input = 'Read ~/.claude/file.md';
    assert.strictEqual(convertClaudeCommandToZooCommand(input, ROO_PREFIX), `Read ${ROO_PREFIX}file.md`);
  });

  test('$HOME/.claude/ path replaced (the 4134ae8 regression vector)', () => {
    const input = 'INIT=$(node "$HOME/.claude/get-shit-done/bin/gsd-tools.cjs" init)';
    const expected = `INIT=$(node "${ROO_PREFIX}get-shit-done/bin/gsd-tools.cjs" init)`;
    assert.strictEqual(convertClaudeCommandToZooCommand(input, ROO_PREFIX), expected);
  });

  test('bare ~/.claude with no trailing slash replaced (the 4134ae8 no-trailing-slash fix)', () => {
    const input = 'Use ~/.claude';
    assert.strictEqual(convertClaudeCommandToZooCommand(input, ROO_PREFIX), `Use ${ROO_PREFIX}`);
  });

  test('mixed tilde / $HOME / local forms in one string', () => {
    const input = '~/.claude/a and $HOME/.claude/b and ./.claude/c';
    assert.strictEqual(
      convertClaudeCommandToZooCommand(input, ROO_PREFIX),
      `${ROO_PREFIX}a and ${ROO_PREFIX}b and ./.roo/c`,
    );
  });

  test('./.claude/config local path replaced', () => {
    assert.strictEqual(convertClaudeCommandToZooCommand('Check ./.claude/config', ROO_PREFIX), 'Check ./.roo/config');
  });

  test('a non-path prefix (layout name-dispatch) leaves paths untouched (#4746 decision C)', () => {
    const input = 'Read ~/.claude/file.md';
    assert.strictEqual(convertClaudeCommandToZooCommand(input, 'gsd-execute-phase'), input);
  });
});

// ─── convertClaudeCommandToZooCommand ─────────────────────────────────────────

describe('#4746 convertClaudeCommandToZooCommand command conversion', () => {
  test('frontmatter rebuilt to description-only (name/tools/argument-hint dropped)', () => {
    const input = [
      '---',
      'name: gsd-test',
      'description: "A test command"',
      'tools: Read, Write, Bash, Task',
      'argument-hint: "phase"',
      '---',
      '',
      'Body stays.',
    ].join('\n');
    const result = convertClaudeCommandToZooCommand(input, ROO_PREFIX);
    assert.ok(result.startsWith('---\ndescription: "A test command"\n---\n'), 'frontmatter rebuilt description-only');
    assert.ok(!result.includes('name: gsd-test'), 'name: dropped from frontmatter');
    assert.ok(!result.includes('tools:'), 'tools: dropped from frontmatter');
    assert.ok(!result.includes('argument-hint'), 'argument-hint: dropped from frontmatter');
    assert.ok(result.includes('Body stays.'), 'body preserved');
  });

  test('bullet tool mapping covers all 9 tools', () => {
    const toolMap = {
      Read: 'read_file',
      Write: 'write_to_file',
      Edit: 'apply_diff',
      Bash: 'execute_command',
      Glob: 'list_files',
      Grep: 'search_files',
      Task: 'new_task',
      AskUserQuestion: 'ask_followup_question',
      TodoWrite: 'update_todo_list',
    };
    const lines = ['---', 'description: tools', '---', ''];
    for (const claude of Object.keys(toolMap)) lines.push(`- ${claude} x`);
    const result = convertClaudeCommandToZooCommand(lines.join('\n'), ROO_PREFIX);
    for (const [claude, zoo] of Object.entries(toolMap)) {
      assert.ok(result.includes(`- ${zoo} x`), `${claude} must map to ${zoo}`);
      assert.ok(!result.includes(`- ${claude} x`), `${claude} must not survive a bullet`);
    }
  });

  test('NON-bullet prose tool mentions are NOT rewritten', () => {
    const result = convertClaudeCommandToZooCommand('Use the Read tool and the Bash tool', ROO_PREFIX);
    assert.ok(result.includes('Use the Read tool and the Bash tool'), 'prose tool names preserved');
  });

  test('/gsd:colon namespace converted to /gsd-hyphen', () => {
    const result = convertClaudeCommandToZooCommand('Run /gsd:execute-phase then /gsd:verify-work', ROO_PREFIX);
    assert.ok(result.includes('/gsd-execute-phase'), 'colon form converted');
    assert.ok(result.includes('/gsd-verify-work'), 'colon form converted');
    assert.ok(!result.includes('/gsd:'), 'no colon-namespace ref survives');
  });

  test('CRLF input emits LF output', () => {
    const input = '---\r\ndescription: "x"\r\n---\r\n\r\n- Read a\r\n';
    const result = convertClaudeCommandToZooCommand(input, ROO_PREFIX);
    assert.ok(!result.includes('\r'), 'output must be LF-only');
    assert.ok(result.startsWith('---\ndescription: "x"\n---\n'), 'frontmatter LF-normalized');
    assert.ok(result.includes('- read_file a'), 'body LF-normalized and converted');
  });

  test('"Claude Code" brand swapped to "Zoo Code"', () => {
    const result = convertClaudeCommandToZooCommand('Claude Code guidance', ROO_PREFIX);
    assert.ok(result.includes('Zoo Code'), 'brand swapped');
    assert.ok(!result.includes('Claude Code'), 'Claude Code brand removed');
  });

  test('full old-fork vector: frontmatter + tools + slash + path (port of convertCommandForRoo)', () => {
    const input = '---\r\nname: gsd-test\r\ndescription: "A test command"\r\ntools: Read, Write, Bash, Task\r\n---\r\n\r\n- Read a file\r\n- Write a file\r\n- Bash command\r\n- Task spawn\r\n- /gsd:execute-phase\r\n- $HOME/.claude/bin/gsd-tools.cjs\r\n';
    const result = convertClaudeCommandToZooCommand(input, ROO_PREFIX);
    assert.ok(result.startsWith('---\ndescription: "A test command"\n---\n'), 'frontmatter rebuilt correctly');
    assert.ok(result.includes('- read_file a file'), 'Read -> read_file');
    assert.ok(result.includes('- write_to_file a file'), 'Write -> write_to_file');
    assert.ok(result.includes('- execute_command command'), 'Bash -> execute_command');
    assert.ok(result.includes('- new_task spawn'), 'Task -> new_task');
    assert.ok(result.includes('/gsd-execute-phase'), 'slash command converted');
    assert.ok(result.includes(`${ROO_PREFIX}bin/gsd-tools.cjs`), 'path replaced in body');
  });

  test('property: conversion never leaves .claude paths or colon-namespace refs (fc)', () => {
    fc.assert(fc.property(
      fc.constant(ROO_PREFIX),
      fc.array(fc.constantFrom('~/.claude/a', '$HOME/.claude/b', '/gsd:execute-phase', 'plain prose', '- Read x', '- Bash y', 'Claude Code'), { minLength: 1 }),
      (prefix, lines) => {
        const out = convertClaudeCommandToZooCommand(lines.join('\n'), prefix);
        assert.ok(!out.includes('~/.claude'), 'no tilde .claude path survives');
        assert.ok(!out.includes('$HOME/.claude'), 'no $HOME .claude path survives');
        assert.ok(!out.includes('/gsd:'), 'no colon-namespace ref survives');
      },
    ));
  });
});

// ─── convertClaudeAgentToZooModeEntry ─────────────────────────────────────────

describe('#4746 convertClaudeAgentToZooModeEntry mode-entry conversion', () => {
  const SYNTHETIC_AGENT = [
    '---',
    'name: gsd-executor',
    'description: Executes GSD plans with atomic commits',
    '---',
    '',
    'You are the GSD plan executor. Read ~/.claude/config and use /gsd:execute-phase.',
    'Claude Code is the host. Use the `Read` tool.',
  ].join('\n');

  test('produces slug/name/whenToUse/groups + transformed roleDefinition', () => {
    const entry = convertClaudeAgentToZooModeEntry(
      SYNTHETIC_AGENT,
      { pathPrefix: './.roo/' },
      { agentName: 'gsd-executor' },
    );
    assert.strictEqual(entry.slug, 'gsd-executor', 'slug from agent stem');
    assert.strictEqual(entry.name, 'gsd-executor', 'name from frontmatter');
    assert.strictEqual(entry.whenToUse, 'Executes GSD plans with atomic commits', 'whenToUse from description');
    assert.deepStrictEqual(entry.groups, ['read', 'edit', 'command', 'mcp'], 'generic groups');
    assert.ok(entry.roleDefinition.includes('./.roo/config'), '~/.claude path rewritten');
    assert.ok(entry.roleDefinition.includes('/gsd-execute-phase'), '/gsd: hyphenated');
    assert.ok(entry.roleDefinition.includes('Zoo Code is the host'), 'brand swapped');
    assert.ok(entry.roleDefinition.includes('`read_file` tool'), 'backtick tool swap');
    assert.ok(!entry.roleDefinition.includes('~/.claude'), 'no ~/.claude leftover');
    assert.ok(!entry.roleDefinition.includes('/gsd:'), 'no colon-namespace leftover');
  });

  test('whenToUse omitted when the agent has no description', () => {
    const agent = '---\nname: gsd-executor\n---\n\nBody here.';
    const entry = convertClaudeAgentToZooModeEntry(
      agent,
      { pathPrefix: './.roo/' },
      { agentName: 'gsd-executor' },
    );
    assert.strictEqual(entry.slug, 'gsd-executor');
    assert.ok(!('whenToUse' in entry), 'whenToUse must be absent without a description');
    assert.strictEqual(entry.roleDefinition, 'Body here.');
  });

  test('a non-gsd stem is re-prefixed to the gsd- namespace', () => {
    const agent = '---\ndescription: d\n---\n\nBody.';
    const entry = convertClaudeAgentToZooModeEntry(
      agent,
      { pathPrefix: './.roo/' },
      { agentName: 'executor' },
    );
    assert.strictEqual(entry.slug, 'gsd-executor', 'bare stem re-prefixed');
    assert.strictEqual(entry.name, 'Executor', 'stem-derived display name fallback');
  });

  // Zoo's roomodes schema pins slug to /^[a-zA-Z0-9-]+$/ (Dq zod regex in the
  // shipped bundle): ONE non-conforming slug fails safeParse for the WHOLE
  // customModes document and Zoo silently falls back to default modes — the
  // global-install regression #4746 follow-up (29 dotted .compact slugs).
  test('.compact variant stems sanitize to schema-conforming dashed slugs', () => {
    const agent = '---\nname: gsd-advisor-researcher.compact\ndescription: d\n---\n\nBody.';
    const entry = convertClaudeAgentToZooModeEntry(
      agent,
      { pathPrefix: './.roo/' },
      { agentName: 'gsd-advisor-researcher.compact' },
    );
    assert.strictEqual(entry.slug, 'gsd-advisor-researcher-compact', 'dot folded to dash');
    assert.match(entry.slug, /^[a-zA-Z0-9-]+$/, 'Zoo slug schema regex');
  });

  test('slug sanitation collapses any invalid run and trims edges', () => {
    const mk = (stem) => convertClaudeAgentToZooModeEntry(
      '---\ndescription: d\n---\n\nBody.',
      { pathPrefix: './.roo/' },
      { agentName: stem },
    );
    assert.strictEqual(mk('gsd-foo_bar.baz').slug, 'gsd-foo-bar-baz', 'underscore + dot runs fold');
    assert.strictEqual(mk('gsd--a---b..c').slug, 'gsd-a-b-c', 'repeated separators collapse');
    assert.strictEqual(mk('gsd-...').slug, 'gsd-agent', 'all-invalid stem falls back');
    assert.strictEqual(mk('gsd-a.b/..cd').slug, 'gsd-a-b-cd', 'path-ish stem stays one token');
    for (const stem of ['gsd-foo_bar.baz', 'gsd--a---b..c', 'gsd-a.b/..cd']) {
      assert.match(mk(stem).slug, /^[a-zA-Z0-9-]+$/, `sanitized slug conforms for ${stem}`);
    }
  });

  test('CRLF agent body normalized to LF in roleDefinition', () => {
    const agent = '---\r\nname: gsd-executor\r\ndescription: d\r\n---\r\n\r\n- Read ~/.claude/a\r\n';
    const entry = convertClaudeAgentToZooModeEntry(
      agent,
      { pathPrefix: './.roo/' },
      { agentName: 'gsd-executor' },
    );
    assert.ok(!entry.roleDefinition.includes('\r'), 'roleDefinition LF-only');
    assert.ok(entry.roleDefinition.includes('- Read ./.roo/a'), 'path rewritten, body intact');
  });

  test('a non-path pathPrefix skips path rewrites (layout name-dispatch, #4746 decision C)', () => {
    const agent = '---\nname: gsd-executor\ndescription: d\n---\n\nRead ~/.claude/config.';
    const entry = convertClaudeAgentToZooModeEntry(
      agent,
      { pathPrefix: 'gsd-executor' },
      { agentName: 'gsd-executor' },
    );
    assert.ok(entry.roleDefinition.includes('~/.claude/config'), 'path rewrite skipped for non-path prefix');
  });

  test('property: roleDefinition never leaks .claude paths or colon refs with a real prefix (fc)', () => {
    fc.assert(fc.property(
      fc.constant('./.roo/'),
      fc.array(fc.constantFrom('~/.claude/a', '/gsd:phase', 'body text', '- Write x'), { minLength: 1 }),
      (prefix, bodyLines) => {
        const entry = convertClaudeAgentToZooModeEntry(
          `---\nname: gsd-agent\ndescription: d\n---\n\n${bodyLines.join('\n')}`,
          { pathPrefix: prefix },
          { agentName: 'gsd-agent' },
        );
        assert.ok(entry.slug.startsWith('gsd-'), 'slug stays in the gsd- namespace');
        assert.ok(!entry.roleDefinition.includes('~/.claude'), 'no tilde .claude in roleDefinition');
        assert.ok(!entry.roleDefinition.includes('/gsd:'), 'no colon-namespace in roleDefinition');
      },
    ));
  });
});

// ─── canonicalizeRuntimeName aliases ──────────────────────────────────────────

describe('#4746 runtime-name canonicalization (Roo family -> zoo)', () => {
  test('all five zoo/roo aliases canonicalize to zoo', () => {
    for (const alias of ['zoo', 'zoo-code', 'roo', 'roo-code', 'roo-cline']) {
      assert.strictEqual(canonicalizeRuntimeName(alias), 'zoo', `${alias} must canonicalize to zoo`);
    }
  });

  test('the canonical id round-trips', () => {
    assert.strictEqual(canonicalizeRuntimeName('ZOO'), 'zoo', 'case-insensitive');
  });

  test('an unrelated runtime id is unaffected', () => {
    assert.strictEqual(canonicalizeRuntimeName('cline'), 'cline');
  });
});

// ─── zoo global config-dir precedence ─────────────────────────────────────────

describe('#4746 zoo global config-dir precedence (--config-dir > ZOO_CONFIG_DIR > ROO_CONFIG_DIR > ~/.roo)', () => {
  // Hermetic home: os.homedir() resolves from USERPROFILE on win32 / HOME on
  // POSIX, so pointing both at a tmpdir keeps every default-branch assertion
  // off the developer's real home (never-real-home rule).
  let sandboxHome;
  let restoreConfigEnv;
  let savedHome;
  let savedUserProfile;

  before(() => {
    sandboxHome = createTempDir('gsd-zoo-confighome-');
  });
  after(() => cleanup(sandboxHome));

  beforeEach(() => {
    restoreConfigEnv = scrubConfigLocationEnv();
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
    process.env.HOME = sandboxHome;
    process.env.USERPROFILE = sandboxHome;
  });

  afterEach(() => {
    restoreConfigEnv();
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
  });

  test('explicit --config-dir wins over every env override', () => {
    process.env.ZOO_CONFIG_DIR = path.join(sandboxHome, 'from-zoo-env');
    process.env.ROO_CONFIG_DIR = path.join(sandboxHome, 'from-roo-env');
    const explicit = path.join(sandboxHome, 'explicit-dir');
    assert.strictEqual(getGlobalConfigDir('zoo', explicit), explicit);
  });

  test('ZOO_CONFIG_DIR beats ROO_CONFIG_DIR', () => {
    process.env.ZOO_CONFIG_DIR = path.join(sandboxHome, 'zoo-dir');
    process.env.ROO_CONFIG_DIR = path.join(sandboxHome, 'roo-dir');
    assert.strictEqual(getGlobalConfigDir('zoo'), path.join(sandboxHome, 'zoo-dir'));
  });

  test('ROO_CONFIG_DIR fallback when ZOO_CONFIG_DIR absent', () => {
    process.env.ROO_CONFIG_DIR = path.join(sandboxHome, 'roo-dir');
    assert.strictEqual(getGlobalConfigDir('zoo'), path.join(sandboxHome, 'roo-dir'));
  });

  test('default ~/.roo when neither env var is set', () => {
    assert.strictEqual(getGlobalConfigDir('zoo'), path.join(sandboxHome, '.roo'));
  });

  test('empty-string env overrides fall back to the default, never a bogus path', () => {
    process.env.ZOO_CONFIG_DIR = '';
    process.env.ROO_CONFIG_DIR = '';
    assert.strictEqual(getGlobalConfigDir('zoo'), path.join(sandboxHome, '.roo'));
  });

  test('a tilde-prefixed ZOO_CONFIG_DIR expands against the sandbox HOME', () => {
    process.env.ZOO_CONFIG_DIR = '~/zoo-alt';
    assert.strictEqual(getGlobalConfigDir('zoo'), path.join(sandboxHome, 'zoo-alt'));
  });
});