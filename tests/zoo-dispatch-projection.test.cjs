'use strict';

/**
 * #4746 follow-up — Zoo Code native `new_task` dispatch projection.
 *
 * Zoo Code's dispatch primitive is `new_task(mode, message)` — a subtask
 * launched in a named custom mode. The parent task PAUSES while the subtask
 * runs and resumes via `finishSubTask()`; there is no background/parallel
 * variant and no per-call model parameter (docs:
 * https://docs.zoocode.dev/advanced-usage/available-tools/new-task).
 *
 * Prior to this follow-up the staged workflow corpus shipped VERBATIM Claude
 * dispatch syntax (`Agent(prompt="...", subagent_type="gsd-x", model="...")`)
 * even though Zoo has no Agent tool. `convertClaudeToZooWorkflowMarkdown`
 * projects it onto `new_task(mode=..., message=...)` via the SAME generic
 * #2284 machinery hermes uses, driven by capabilities/zoo/capability.json's
 * `hostIntegration.dispatch` facts + the caller-supplied tool vocabulary.
 *
 * Covers:
 *   1. Converter contract across ALL THREE real corpus call-argument shapes:
 *      multi-line one-key-per-line, single-line object-literal (`Agent({...})`),
 *      and single-line compact (`Agent(subagent_type="x", model="y", prompt="...")`).
 *   2. Named-dispatch `mode=` / `message=` key mapping (Zoo's native parameter
 *      names differ from the corpus's Claude-shaped `subagent_type`/`prompt`).
 *   3. `model=` stripping (no per-call model) and `run_in_background=` stripping
 *      (dispatch.background: false — new_task pauses the parent).
 *   4. Fail-closed role resolution — a referenced gsd-* role prompt missing from
 *      the shipped agents/ directory aborts conversion with an explicit error.
 *   5. The post-projection guard — fails loud on any residual subagent_type /
 *      leaked model= / unprojected Agent( the projection did not anticipate.
 *   6. `"Agent tool"` prose rename to the real primitive name.
 */

process.env.GSD_TEST_MODE = '1';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  convertClaudeToZooWorkflowMarkdown,
  projectNamedDispatchToStructuralDelegate,
  _hostIntegrationDispatch,
  _resolveAvailableGsdRoles,
  ZOO_DISPATCH_TOOL_CONFIG,
  maskStringLiterals,
  findDispatchCallSpans,
  _assertProjectionComplete,
} = require('../bin/install.js');

const ZOO_DISPATCH = _hostIntegrationDispatch('zoo');

function zooToolConfig(overrides = {}) {
  return Object.assign({}, ZOO_DISPATCH_TOOL_CONFIG, {
    availableRoles: _resolveAvailableGsdRoles(),
    runtime: 'zoo',
  }, overrides);
}

// Representative fixture prose mirroring the real shape found in
// gsd-core/workflows/plan-phase.md — the "Agent tool IS available" contract
// assertion followed by a literal, multi-arg Agent(...) dispatch call whose
// subagent_type resolves to a real shipped role.
const FIXTURE_ASSERTION_AND_CALL = [
  'The Agent tool IS available in a top-level Claude Code session. Always spawn',
  'gsd-phase-researcher, gsd-planner, and gsd-plan-checker as separate Agent() calls.',
  '',
  '```',
  'Agent(',
  '  prompt=filled_research_hook_fragment,',
  '  subagent_type="gsd-planner",',
  '  model="{researcher_model}",',
  '  description="Research Phase {phase}"',
  ')',
  '```',
  '',
  '> **ORCHESTRATOR RULE — ALL RUNTIMES**: After calling Agent() above, stop working on this task immediately.',
  'Wait for the subagent to return its result. Only resume when the subagent result is available.',
].join('\n');

// ─── 0. Descriptor facts driving the projection ──────────────────────────────

describe('#4746 zoo native dispatch — descriptor facts the projection reads', () => {
  test('capabilities/zoo/capability.json dispatch facts are the native new_task posture', () => {
    assert.strictEqual(ZOO_DISPATCH.namedDispatch, true, 'new_task resolves the mode slug itself');
    assert.strictEqual(ZOO_DISPATCH.nested, true, 'deeply nested subtasks are documented');
    assert.strictEqual(ZOO_DISPATCH.background, false, 'the parent PAUSES — not a background primitive');
    assert.strictEqual(ZOO_DISPATCH.backgroundDispatch, false, 'no fire-and-continue dispatch');
    assert.strictEqual(
      ZOO_DISPATCH.subagentToolkit,
      'full',
      'a subtask runs in its mode with that mode\'s tools (read/edit/command/mcp)',
    );
  });

  test('the tool config declares new_task / mode / message and no per-call model', () => {
    assert.strictEqual(ZOO_DISPATCH_TOOL_CONFIG.toolName, 'new_task');
    assert.strictEqual(ZOO_DISPATCH_TOOL_CONFIG.namedRoleParam, 'mode');
    assert.strictEqual(ZOO_DISPATCH_TOOL_CONFIG.promptContentParam, 'message');
    assert.strictEqual(ZOO_DISPATCH_TOOL_CONFIG.supportsPerCallModel, false);
    assert.strictEqual(ZOO_DISPATCH_TOOL_CONFIG.namedDispatchRenamesArgs, true);
  });

  test('structural/background vocabulary is inert (null) on the zoo path', () => {
    // Only the !namedDispatch structural branch reads structuralRoleParam/
    // leafRoleValue, and only dispatch.background:true reads backgroundParam —
    // zoo's facts never enter either path, so the values are deliberately null.
    assert.strictEqual(ZOO_DISPATCH_TOOL_CONFIG.structuralRoleParam, null);
    assert.strictEqual(ZOO_DISPATCH_TOOL_CONFIG.leafRoleValue, null);
    assert.strictEqual(ZOO_DISPATCH_TOOL_CONFIG.backgroundParam, null);
  });
});

// ─── 1. Direct converter contract ────────────────────────────────────────────

describe('#4746 convertClaudeToZooWorkflowMarkdown — converter contract', () => {
  test('no literal Agent( call syntax survives the projection', () => {
    const out = convertClaudeToZooWorkflowMarkdown(FIXTURE_ASSERTION_AND_CALL, { runtime: 'zoo' });
    assert.ok(!/\bAgent\(/.test(out), `literal Agent( survived:\n${out}`);
  });

  test('emits a new_task-shaped call with the named mode + message content', () => {
    const out = convertClaudeToZooWorkflowMarkdown(FIXTURE_ASSERTION_AND_CALL, { runtime: 'zoo' });
    assert.ok(/new_task\(/.test(out), 'new_task( call syntax present');
    assert.ok(/mode="gsd-planner"/.test(out), 'mode carries the named role slug');
    assert.ok(/message=/.test(out), 'message carries the dispatched task instructions');
    assert.ok(!/\bsubagent_type\b/.test(out), 'no subagent_type token survives');
  });

  test('drops per-call model forwarding (the mode\'s configured model applies)', () => {
    const out = convertClaudeToZooWorkflowMarkdown(FIXTURE_ASSERTION_AND_CALL, { runtime: 'zoo' });
    assert.ok(!/model="\{researcher_model\}"/.test(out), 'per-call model="{researcher_model}" line stripped');
    assert.ok(!/\bmodel=/.test(maskStringLiterals(out)), 'no model= parameter forwarded anywhere');
  });

  test('the "Agent tool IS available" assertion becomes an accurate new_task statement', () => {
    const out = convertClaudeToZooWorkflowMarkdown(FIXTURE_ASSERTION_AND_CALL, { runtime: 'zoo' });
    assert.ok(!/Agent tool IS available/.test(out), 'false Claude-shaped assertion removed');
    assert.ok(/The `new_task` tool IS available/.test(out), 'assertion references the real dispatch primitive');
    assert.ok(/as separate `new_task\(\)` calls/.test(out), 'roster rephrased onto new_task() calls');
  });

  test('async halt/resume wording is preserved (no busy-poll)', () => {
    const out = convertClaudeToZooWorkflowMarkdown(FIXTURE_ASSERTION_AND_CALL, { runtime: 'zoo' });
    assert.ok(/stop working on this task immediately/.test(out), 'halt-after-dispatch instruction preserved');
    assert.ok(/Wait for the subagent to return its result/.test(out), 'resume-on-completion instruction preserved');
  });

  test('preserves unrelated prose and the unknown description arg', () => {
    const fixture = 'Some unrelated prose.\n\nAgent(\n  prompt=x,\n  subagent_type="gsd-verifier",\n  description="d"\n)\n\nMore unrelated prose.';
    const out = convertClaudeToZooWorkflowMarkdown(fixture, { runtime: 'zoo' });
    assert.ok(out.includes('Some unrelated prose.'));
    assert.ok(out.includes('More unrelated prose.'));
    // Unknown args are left in place, mirroring the hermes precedent (the
    // #2284 scope is role/model/background, not every Claude-shaped arg).
    assert.ok(out.includes('description="d"'), 'unknown description arg left in place');
  });
});

// ─── 2. All three real corpus call-argument shapes ───────────────────────────

describe('#4746 all three real corpus Agent(...) call-argument shapes', () => {
  // (a) multi-line, one key= per line — plan-phase.md/execute-phase.md/etc.
  const MULTI_LINE = 'Agent(\n  prompt=x,\n  subagent_type="gsd-planner",\n  model="{researcher_model}",\n  description="d"\n)';
  // (b) single-line object-literal (colon syntax) — import.md/ingest-docs.md.
  const OBJECT_LITERAL = 'Agent({\n  subagent_type: "gsd-plan-checker",\n  prompt: "Validate the plan."\n})';
  // (c) single-line compact — code-review-fix.md/code-review.md/ship.md/etc.
  const SINGLE_LINE_COMPACT = 'Agent(subagent_type="gsd-code-fixer", model="{FIXER_MODEL}", prompt="Fix the findings.")';

  const forms = [
    ['multi-line one-key-per-line', MULTI_LINE, 'gsd-planner'],
    ['single-line object-literal', OBJECT_LITERAL, 'gsd-plan-checker'],
    ['single-line compact', SINGLE_LINE_COMPACT, 'gsd-code-fixer'],
  ];

  for (const [label, fixture, role] of forms) {
    test(`${label}: projects to new_task with mode= and message=`, () => {
      const out = convertClaudeToZooWorkflowMarkdown(fixture, { runtime: 'zoo' });
      assert.ok(/new_task\(/.test(out), `${label}: new_task( present`);
      assert.ok(out.includes(`mode="${role}"`) || out.includes(`mode: "${role}"`), `${label}: mode carries "${role}"`);
      assert.ok(/message\s*[=:]/.test(out), `${label}: message= injected`);
      assert.ok(!/\bsubagent_type\s*[=:]/.test(out), `${label}: subagent_type token gone:\n${out}`);
    });

    test(`${label}: no leaked model= (mode model, never forwarded)`, () => {
      const out = convertClaudeToZooWorkflowMarkdown(fixture, { runtime: 'zoo' });
      assert.ok(!/\bmodel\s*[=:]/.test(maskStringLiterals(out)), `${label}: no model= or model: token survives:\n${out}`);
    });

    test(`${label}: a bogus role triggers the fail-closed throw`, () => {
      const bogusFixture = fixture.replace(role, 'gsd-totally-fake-role-4746');
      assert.throws(
        () => convertClaudeToZooWorkflowMarkdown(bogusFixture, { runtime: 'zoo' }),
        /gsd-totally-fake-role-4746/,
        `${label}: expected an explicit fail-closed error naming the bogus role`,
      );
    });
  }

  test('object-literal wrapper braces are stripped (new_task is a flat kwarg call)', () => {
    const out = convertClaudeToZooWorkflowMarkdown(OBJECT_LITERAL, { runtime: 'zoo' });
    assert.ok(!/new_task\(\s*\{/.test(out), 'no leftover "{" immediately after new_task(');
    assert.ok(!/\}\s*\)\s*$/.test(out.trim()), 'no leftover "}" immediately before the closing )');
  });

  test('single-line-compact: a real corpus fixture identical to code-review-fix.md:201 shape', () => {
    const fixture = [
      'Agent(subagent_type="gsd-code-fixer", model="{FIXER_MODEL}", prompt="',
      '<files_to_read>',
      '${REVIEW_PATH}',
      '</files_to_read>',
      '',
      'Read REVIEW.md findings, apply fixes.',
      '${AGENT_SKILLS_FIXER}")',
    ].join('\n');
    const out = convertClaudeToZooWorkflowMarkdown(fixture, { runtime: 'zoo' });
    assert.ok(!/\bAgent\(/.test(out), 'no literal Agent( survives a multi-line-body compact-head call');
    assert.ok(/new_task\(/.test(out));
    assert.ok(out.includes('mode="gsd-code-fixer"'));
    assert.ok(!/\bmodel\s*[=:]/.test(maskStringLiterals(out)), 'model stripped even though the prompt body spans many lines');
    assert.ok(out.includes('<files_to_read>'), 'multi-line prompt BODY content is preserved verbatim');
    assert.ok(out.includes('${REVIEW_PATH}'), 'interpolation placeholders inside the prompt body are untouched');
  });

  test('a documentation TEMPLATE placeholder role (curly-brace interpolation) is renamed but NOT fail-closed validated', () => {
    const fixture = 'ALWAYS use `subagent_type: "gsd-{agent}"` (e.g., `gsd-phase-researcher`, `gsd-executor`).';
    assert.doesNotThrow(() => convertClaudeToZooWorkflowMarkdown(fixture, { runtime: 'zoo' }));
    const out = convertClaudeToZooWorkflowMarkdown(fixture, { runtime: 'zoo' });
    assert.ok(out.includes('mode: "gsd-{agent}"'), 'template placeholder renamed, value preserved verbatim');
  });

  test('a dynamic (non-literal) role expression is renamed but not statically validated', () => {
    const fixture = 'Agent(prompt=x, subagent_type=research_hook.ref.agent, model="{m}")';
    assert.doesNotThrow(() => convertClaudeToZooWorkflowMarkdown(fixture, { runtime: 'zoo' }));
    const out = convertClaudeToZooWorkflowMarkdown(fixture, { runtime: 'zoo' });
    assert.ok(out.includes('mode=research_hook.ref.agent'), 'dynamic role renamed in place');
  });

  test('disconnected prose mention (not part of any real Agent(...) call) is still renamed and validated', () => {
    const fixture = 'Use Agent tool with `subagent_type="gsd-codebase-mapper"` for parallel execution.';
    const out = convertClaudeToZooWorkflowMarkdown(fixture, { runtime: 'zoo' });
    assert.ok(out.includes('mode="gsd-codebase-mapper"'), 'prose mention renamed to mode=');
    assert.ok(!/\bsubagent_type\s*[=:]/.test(out));
  });

  test('"Agent tool" prose rename to the real primitive name', () => {
    const fixture = 'The Agent tool is used to spawn subagents.';
    const out = convertClaudeToZooWorkflowMarkdown(fixture, { runtime: 'zoo' });
    assert.ok(out.includes('The new_task is used'), '"Agent tool" renamed to new_task');
    assert.ok(!/Agent tool/.test(out), 'no "Agent tool" mention survives');
  });
});

// ─── 3. Background-flag stripping (dispatch.background: false) ───────────────

describe('#4746 run_in_background= is stripped (zoo background: false)', () => {
  test('the = form is stripped from a real call span', () => {
    const fixture = 'Agent(\n  prompt=x,\n  subagent_type="gsd-executor",\n  run_in_background=true,\n  description="d"\n)';
    const out = convertClaudeToZooWorkflowMarkdown(fixture, { runtime: 'zoo' });
    assert.ok(!/run_in_background/.test(out), 'Claude-native run_in_background= token gone');
    assert.ok(!/\bbackground\s*[=:]/.test(out), 'flag is stripped, never forwarded as background=');
    assert.ok(out.includes('mode="gsd-executor"'), 'the rest of the call still projects');
  });

  test('genuinely branches on dispatch.background: true — renames instead of stripping', () => {
    const fixture = 'Agent(\n  prompt=x,\n  subagent_type="gsd-executor",\n  run_in_background=true,\n  description="d"\n)';
    const out = projectNamedDispatchToStructuralDelegate(
      fixture,
      Object.assign({}, ZOO_DISPATCH, { background: true }),
      zooToolConfig({ backgroundParam: 'background' }),
    );
    assert.ok(!/run_in_background=/.test(out), 'Claude-native param name gone');
    assert.ok(/\bbackground=true\b/.test(out), 'renamed to the target background param when declared capable');
  });
});

// ─── 4. Post-projection guard (belt-and-suspenders, #2284 requirement 3) ─────

describe('#4746 post-projection guard — fails loud on any unanticipated residual form', () => {
  const toolConfig = zooToolConfig();

  test('throws when a residual subagent_type token survives (any syntax)', () => {
    assert.throws(
      () => _assertProjectionComplete('new_task(subagent_type="gsd-planner")', toolConfig, true),
      /residual subagent_type/i,
    );
    assert.throws(
      () => _assertProjectionComplete('new_task(subagent_type: "gsd-planner")', toolConfig, true),
      /residual subagent_type/i,
    );
  });

  test('throws when literal Agent( call syntax survives', () => {
    assert.throws(
      () => _assertProjectionComplete('Please call Agent() to dispatch.', toolConfig, true),
      /literal Agent\(/i,
    );
  });

  test('throws when a model= argument leaks inside a new_task(...) call', () => {
    assert.throws(
      () => _assertProjectionComplete('new_task(mode="gsd-planner", model="{m}")', toolConfig, true),
      /leaked model=/i,
    );
  });

  test('does NOT throw on a clean, fully-projected document', () => {
    const clean = 'new_task(mode="gsd-planner", message="x", description="d")';
    assert.doesNotThrow(() => _assertProjectionComplete(clean, toolConfig, true));
  });

  test('does NOT flag Agent( or subagent_type mentioned INSIDE a quoted string', () => {
    const proseInsideString = 'new_task(description="Chain stages via Agent() subagents, not subagent_type=x")';
    assert.doesNotThrow(() => _assertProjectionComplete(proseInsideString, toolConfig, true));
  });

  test('the completeness checks are genuinely gated — a claude-style named target keeps subagent_type', () => {
    // namedDispatchRenamesArgs:false is the claude-style named pass-through;
    // a residual subagent_type there is intended output, not a defect.
    const claudeStyle = zooToolConfig({ namedDispatchRenamesArgs: false });
    assert.doesNotThrow(() => _assertProjectionComplete('new_task(subagent_type="gsd-planner")', claudeStyle, true));
  });

  test('findDispatchCallSpans correctly balances parens across a quoted prompt body containing its own parens', () => {
    const fixture = 'new_task(mode="gsd-verifier", message="""\nAnalyze (e.g., "Technical Approach") the codebase.\n(3-5 areas, calibrated by tier)\n""")';
    const spans = findDispatchCallSpans(fixture, 'new_task');
    assert.strictEqual(spans.length, 1, 'exactly one call span found despite embedded parens');
    assert.strictEqual(spans[0].end, fixture.length, 'span correctly extends to the TRUE closing paren');
  });
});

// ─── 5. Structural vs named-dispatch branch isolation (no hermes regression) ──

describe('#4746 named-rename path does not disturb the structural path', () => {
  test('the hermes-style structural tool config keeps subagent_type→gsd_role (no prompt/message rename)', () => {
    const structural = {
      toolName: 'delegate_task',
      namedRoleParam: 'gsd_role',
      promptContentParam: 'gsd_role_prompt',
      structuralRoleParam: 'role',
      leafRoleValue: 'leaf',
      backgroundParam: 'background',
      supportsPerCallModel: false,
      availableRoles: _resolveAvailableGsdRoles(),
      runtime: 'hermes',
    };
    const fixture = 'Agent(\n  prompt=x,\n  subagent_type="gsd-executor",\n  description="d"\n)';
    const out = projectNamedDispatchToStructuralDelegate(fixture, { namedDispatch: false, background: true, subagentToolkit: 'read-only', maxDepth: 1, nested: true }, structural);
    assert.ok(out.includes('gsd_role="gsd-executor"'), 'structural path still renames to gsd_role');
    assert.ok(out.includes('gsd_role_prompt='), 'structural path still embeds the prompt-content instruction');
    assert.ok(!/\bmessage=/.test(out), 'no zoo-specific message= rename leaks into the structural path');
    assert.ok(out.includes('prompt=x'), 'the structural path leaves the prompt= arg as-is');
  });
});

// ─── 6. Zoo lexicon projection (Skill() calls, tool vocabulary, headers) ──────
//
// Vocabulary the #2284 machinery does not own because it is not Agent(...)
// call structure. Measured pre-fix against the shipped corpus: 59 live
// Skill( calls in 14 files, "Task tool" gates in 7, AskUserQuestion in 60,
// and the #3324 verbatim-inline mandate — all shipped broken on Zoo (no
// Skill tool, no TaskOutput, no inlining budget).

describe('#4746 zoo lexicon pass — Skill() dispatches project to inline workflow follow-through', () => {
  test('Skill(skill="gsd-x", args="y") becomes an inline workflow follow instruction', () => {
    const out = convertClaudeToZooWorkflowMarkdown('Skill(skill="gsd-plan-phase", args="{N} --auto")', { runtime: 'zoo' });
    assert.strictEqual(out, 'read and follow gsd-core/workflows/plan-phase.md inline (args: {N} --auto)');
  });

  test('the dynamic mixed form gsd-${ref.skill} survives with the template intact', () => {
    const out = convertClaudeToZooWorkflowMarkdown('Skill(skill="gsd-${ref.skill}", args="${PHASE} --auto ${GSD_WS}")', { runtime: 'zoo' });
    assert.strictEqual(out, 'read and follow gsd-core/workflows/${ref.skill}.md inline (args: ${PHASE} --auto ${GSD_WS})');
  });

  test('args-less and bare-string and single-quoted forms all project', () => {
    assert.strictEqual(
      convertClaudeToZooWorkflowMarkdown('Skill(skill="gsd-audit-milestone")', { runtime: 'zoo' }),
      'read and follow gsd-core/workflows/audit-milestone.md inline',
    );
    assert.strictEqual(
      convertClaudeToZooWorkflowMarkdown('Skill("gsd-plan-phase --reviews")', { runtime: 'zoo' }),
      'read and follow gsd-core/workflows/plan-phase.md inline (args: --reviews)',
    );
    assert.strictEqual(
      convertClaudeToZooWorkflowMarkdown("Skill(skill='gsd-review', args='--phase {PHASE}')", { runtime: 'zoo' }),
      'read and follow gsd-core/workflows/review.md inline (args: --phase {PHASE})',
    );
  });

  test('the backslash-escaped form inside an Agent() prompt string projects too', () => {
    const out = convertClaudeToZooWorkflowMarkdown(
      'Agent(prompt="Run it: Skill(skill=\\"gsd-plan-phase\\", args=\\"${PHASE_NUM}\\")", subagent_type="gsd-executor")',
      { runtime: 'zoo' },
    );
    assert.ok(out.includes('read and follow gsd-core/workflows/plan-phase.md inline (args: ${PHASE_NUM})'),
      'inner escaped Skill call is rewritten before the Agent span is projected');
    assert.ok(out.includes('new_task('), 'the outer Agent call is projected as usual');
  });

  test('a non-gsd skill name becomes an explicit handle-or-surface note, not a dangling call', () => {
    const out = convertClaudeToZooWorkflowMarkdown('Skill(skill="update-config")', { runtime: 'zoo' });
    assert.strictEqual(out, 'no Skill tool on this runtime — handle "update-config" inline or surface it to the user');
  });

  test('prose Skill() mentions without arguments survive (concept mentions, not calls)', () => {
    const out = convertClaudeToZooWorkflowMarkdown('Discuss phases run inline via Skill() — flat `Skill()` invocations', { runtime: 'zoo' });
    assert.ok(out.includes('via Skill()'), 'bare prose mention is untouched');
    assert.ok(out.includes('flat `Skill()` invocations'), 'backticked bare mention is untouched');
  });

  test('the fail-closed guard throws on an unanticipated Skill dispatch form', () => {
    // Shape (a1) requires a quoted name — an unquoted variable argument is a
    // form the lexicon does not anticipate and must abort, not ship.
    assert.throws(
      () => convertClaudeToZooWorkflowMarkdown('Skill(skill=ref.skill)', { runtime: 'zoo' }),
      /literal Skill\(\.\.\.\) dispatch call/i,
    );
  });
});

describe('#4746 zoo lexicon pass — Claude tool vocabulary and mode headers', () => {
  test('"Task tool" gates evaluate against new_task', () => {
    const out = convertClaudeToZooWorkflowMarkdown('<step name="s" condition="Task tool is NOT available">Go sequential.</step>', { runtime: 'zoo' });
    assert.ok(out.includes('new_task tool is NOT available'), 'Task tool renamed to the real primitive');
  });

  test('AskUserQuestion swaps to ask_followup_question', () => {
    const out = convertClaudeToZooWorkflowMarkdown('Ask the user via AskUserQuestion with 3 options.', { runtime: 'zoo' });
    assert.strictEqual(out, 'Ask the user via ask_followup_question with 3 options.');
  });

  test('<available_agent_types> headers describe modes, not .claude/agents/ files', () => {
    const hdr = '<available_agent_types>\nValid GSD subagent types (use exact names — do not fall back to \'general-purpose\'):\n- gsd-verifier — verifies\n</available_agent_types>';
    const out = convertClaudeToZooWorkflowMarkdown(hdr, { runtime: 'zoo' });
    assert.ok(out.includes('Valid GSD modes — dispatch each via new_task(mode="<slug>")'), 'header rewritten to mode vocabulary');
    assert.ok(!out.includes('subagent types'), 'subagent-type phrasing is gone');
  });

  test('agent FILE path references point at the mode role definition', () => {
    const out = convertClaudeToZooWorkflowMarkdown('Read ~/.claude/agents/gsd-security-auditor.md for instructions.', { runtime: 'zoo' });
    assert.ok(out.includes('the gsd-security-auditor custom mode role definition'), 'path rewritten to the modes surface');
    assert.ok(out.includes('new_task(mode="gsd-security-auditor")'), 'dispatch hint included');
    assert.ok(!out.includes('.claude/agents/'), 'no claude agents path survives');
  });

  test('Claude-only primitive lines (TaskOutput, run_in_background prose) are dropped', () => {
    const fixture = [
      '> **ORCHESTRATOR RULE — BACKGROUND DISPATCH**: After calling Agent() above with `run_in_background=true`, do NOT plan. Wait.',
      'Never pass an agent id to `TaskOutput` — an agent id is not a task id.',
      'This line survives untouched.',
    ].join('\n');
    const out = convertClaudeToZooWorkflowMarkdown(fixture, { runtime: 'zoo' });
    assert.ok(!out.includes('run_in_background'), 'background-flag line dropped (new_task has no background variant)');
    assert.ok(!out.includes('TaskOutput'), 'TaskOutput line dropped (no polling on Zoo)');
    assert.ok(out.includes('This line survives untouched.'), 'unrelated lines preserved');
  });

  test('the #3324 verbatim-inline mandate becomes a subtask self-reads instruction', () => {
    const mandate = '<execution_context>\nORCHESTRATOR build-time embed (NOT a sub-agent runtime step): before this dispatch, read each file listed below and replace this note with those files\' contents, inlined verbatim in this block in the listed order. Never leave `@`-include lines in the dispatched prompt — `@path` never expands inside an Agent() `prompt="..."` string (#3324), so an include arrives as literal text the executor never sees.\n- `~/.roo/gsd-core/workflows/execute-plan.md`\n</execution_context>';
    const out = convertClaudeToZooWorkflowMarkdown(mandate, { runtime: 'zoo' });
    assert.ok(out.includes('ZOO DISPATCH CONTEXT — subtask self-reads'), 'mandate replaced by the self-reads contract');
    assert.ok(out.includes('~/.roo/gsd-core/workflows/execute-plan.md'), 'the file list itself is preserved verbatim');
    assert.ok(!out.includes('inlined verbatim'), 'the inlining instruction is gone');
  });
});
