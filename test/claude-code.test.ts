/**
 * The Claude Code backend: one isolated `claude -p` per call, on the
 * subscription and never on an API key, with the schema's answer handed back as
 * the JSON the rest of reviewpass expects.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeArgs, claudeEnv, readReply, splitMessages, ClaudeLimitError } from '../src/model/claude-code.js';
import { ModelClient } from '../src/model/client.js';
import { loadConfig } from '../src/config/index.js';
import { classifyBlocker } from '../src/model/blocked.js';

afterEach(() => { for (const k of ['REVIEWPASS_BACKEND', 'REVIEWPASS_CLAUDE_COMMAND', 'ANTHROPIC_API_KEY']) delete process.env[k]; });

test('a call is single-turn, tool-free and isolated, and never runs in bare mode', () => {
  const args = claudeArgs({ model: 'sonnet', schema: { type: 'object' }, effort: 'none' }, '/tmp/s.md');
  assert.ok(!args.includes('--bare'), 'bare mode accepts only an API key: the subscription would not be used');
  for (const flag of ['-p', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence']) assert.ok(args.includes(flag), flag);
  assert.deepEqual(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2), ['--tools', '']);
  assert.deepEqual(args.slice(args.indexOf('--setting-sources'), args.indexOf('--setting-sources') + 2), ['--setting-sources', '']);
  assert.deepEqual(args.slice(args.indexOf('--max-turns'), args.indexOf('--max-turns') + 2), ['--max-turns', '1']);
  assert.equal(args[args.indexOf('--json-schema') + 1], '{"type":"object"}');
  assert.ok(!args.includes('--effort'), '"none" is not a Claude Code effort level and is not sent');
  assert.equal(claudeArgs({ model: 'haiku', effort: 'low' }, '/tmp/s.md').at(-1), 'low');
});

test('the child never sees a key that would bill the API instead of the subscription', () => {
  const env = claudeEnv({ ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 't', CLAUDE_CODE_OAUTH_TOKEN: 'o', PATH: '/bin' });
  assert.deepEqual(env, { CLAUDE_CODE_OAUTH_TOKEN: 'o', PATH: '/bin' });
});

test('system messages become the system prompt, the rest the prompt', () => {
  assert.deepEqual(splitMessages([{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }]), { system: 'S', prompt: 'U' });
  assert.match(splitMessages([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }]).prompt,
    /## user\n\na\n\n## assistant\n\nb\n\n## user\n\nc/);
});

test('the reply: structured output, usage, limits and failures', () => {
  const ok = readReply(JSON.stringify({ subtype: 'success', is_error: false, structured_output: { a: 1 }, result: 'x',
    usage: { input_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 1, output_tokens: 3 } }), '', 0);
  assert.deepEqual(ok, { value: '{"a":1}', stopReason: undefined, promptTokens: 16, completionTokens: 3 });
  assert.equal(readReply(JSON.stringify({ subtype: 'success', result: 'Fix the rate limit reached handler' }), '', 0).value,
    'Fix the rate limit reached handler', 'a review that mentions a limit is not a limit');
  assert.throws(() => readReply(JSON.stringify({ subtype: 'success', is_error: true, result: "You've hit your session limit · resets 11am" }), '', 1),
    ClaudeLimitError);
  assert.throws(() => readReply('', 'Invalid API key · Please run /login', 1), /without a JSON reply/);
  assert.throws(() => readReply(JSON.stringify({ subtype: 'error_max_turns', is_error: true }), '', 1), /error_max_turns/);
});

test('ModelClient routes through the CLI: the schema answer comes back parsed, and no API key reaches it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fake-claude-'));
  const record = join(dir, 'record.json');
  const fake = join(dir, 'claude');
  writeFileSync(fake, `#!/usr/bin/env node
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  require('fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args: process.argv.slice(2), input, cwd: process.cwd(), key: process.env.ANTHROPIC_API_KEY ?? null }));
  process.stdout.write(JSON.stringify({ subtype: 'success', is_error: false, structured_output: { findings: [] }, usage: { input_tokens: 7, output_tokens: 2 } }));
});
`);
  chmodSync(fake, 0o755);
  process.env.REVIEWPASS_BACKEND = 'claude-code';
  process.env.REVIEWPASS_CLAUDE_COMMAND = fake;
  process.env.ANTHROPIC_API_KEY = 'must-not-be-used';
  const cfg = loadConfig(mkdtempSync(join(tmpdir(), 'reviewpass-cfg-')));
  cfg.model.name = 'sonnet';
  const client = new ModelClient(cfg);
  const r = await client.json<{ findings: unknown[] }>([{ role: 'system', content: 'Review.' }, { role: 'user', content: 'the diff' }],
    { type: 'object', required: ['findings'] });
  assert.deepEqual(r.value, { findings: [] });
  const seen = JSON.parse(readFileSync(record, 'utf8'));
  assert.equal(seen.key, null);
  assert.equal(seen.input, 'the diff');
  assert.equal(seen.args[seen.args.indexOf('--model') + 1], 'sonnet');
  assert.notEqual(seen.cwd, process.cwd(), 'the CLI runs in a directory of its own, not the checkout');
  assert.deepEqual(client.usage, { promptTokens: 7, completionTokens: 2 });
});

test('the backend is read from the environment, and a mistyped one fails loudly', () => {
  process.env.REVIEWPASS_BACKEND = 'claude-code';
  assert.equal(loadConfig(mkdtempSync(join(tmpdir(), 'reviewpass-cfg-'))).model.backend, 'claude-code');
  process.env.REVIEWPASS_BACKEND = 'claude';
  assert.throws(() => loadConfig(mkdtempSync(join(tmpdir(), 'reviewpass-cfg-'))), /unknown model backend/);
});

test('a review that could not run says why, in words the operator can act on', () => {
  assert.match(classifyBlocker(new Error('Claude subscription limit: hit your session limit'))!.message, /usage limit is reached/);
  assert.match(classifyBlocker(new Error('spawn claude ENOENT'))!.message, /not installed on this runner/);
  assert.match(classifyBlocker(new Error('claude exited 1 without a JSON reply: Invalid API key · Please run /login'))!.message, /CLAUDE_CODE_OAUTH_TOKEN/);
});
