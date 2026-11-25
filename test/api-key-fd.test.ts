/**
 * A wrapper hands the model key over on a file descriptor so that nothing this
 * process starts can read it: not from the environment, and not from the
 * descriptor, which a child inherits while it is open.
 *
 * Each case runs in a child process, because the descriptor has to be one the
 * process was started with, and loading the key is once per process.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { openRouterProvider } from '../src/model/client.js';

const src = (p: string) => pathToFileURL(join(import.meta.dirname, '..', 'src', p)).href;

/** Run `script` with `fd3` written to descriptor 3 and `env` added; its stdout and exit code. */
function child(script: string, fd3: string | null, env: Record<string, string>) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const p = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      env: { ...process.env, REVIEWPASS_API_KEY: '', WARREN_API_KEY: '', ...env },
      stdio: ['ignore', 'pipe', 'pipe', fd3 === null ? 'ignore' : 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    p.stdout!.on('data', (c) => { stdout += c; });
    p.stderr!.on('data', (c) => { stderr += c; });
    if (fd3 !== null) (p.stdio[3] as NodeJS.WritableStream).end(fd3);
    p.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('the key read from the descriptor is sent, and neither the variable nor the descriptor survives', async () => {
  const seen: (string | undefined)[] = [];
  const server = createServer((req, res) => {
    seen.push(req.headers.authorization);
    req.resume();
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        choices: [{ message: { content: '{"findings":[]}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  try {
    const script = `
      import { fstatSync, mkdtempSync } from 'node:fs';
      import { tmpdir } from 'node:os';
      import { join } from 'node:path';
      import { loadApiKeyFromFd, loadConfig } from ${JSON.stringify(src('config/index.ts'))};
      import { ModelClient } from ${JSON.stringify(src('model/client.ts'))};
      loadApiKeyFromFd();
      let fdOpen = true;
      try { fstatSync(3); } catch { fdOpen = false; }
      const cfg = loadConfig(mkdtempSync(join(tmpdir(), 'reviewpass-cfg-')));
      cfg.model.backend = 'openai';
      cfg.model.endpoint = 'http://127.0.0.1:${port}/v1';
      cfg.model.endpoints = [cfg.model.endpoint];
      await new ModelClient(cfg).json([{ role: 'user', content: 'x' }], { type: 'object' });
      console.log(JSON.stringify({ fdOpen, envFd: process.env.REVIEWPASS_API_KEY_FD ?? null }));
    `;
    const r = await child(script, 'sk-or-v1-from-the-descriptor\n', { REVIEWPASS_API_KEY_FD: '3' });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { fdOpen: false, envFd: null });
    assert.deepEqual(seen, ['Bearer sk-or-v1-from-the-descriptor'], 'trimmed of the newline a shell adds');
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('an empty descriptor is an error, not a review without a key', async () => {
  const script = `import { loadApiKeyFromFd } from ${JSON.stringify(src('config/index.ts'))}; loadApiKeyFromFd();`;
  const r = await child(script, '\n', { REVIEWPASS_API_KEY_FD: '3' });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /descriptor 3 held no key/);
});

test('stdio is refused as the key descriptor', async () => {
  const script = `import { loadApiKeyFromFd } from ${JSON.stringify(src('config/index.ts'))}; loadApiKeyFromFd();`;
  const r = await child(script, null, { REVIEWPASS_API_KEY_FD: '0' });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /descriptor number of 3 or more/);
});

test('a schema request through OpenRouter requires providers that support the schema', () => {
  assert.deepEqual(openRouterProvider(undefined, true), { require_parameters: true });
  assert.deepEqual(openRouterProvider({ zdr: true }, true), { require_parameters: true, zdr: true });
  assert.deepEqual(openRouterProvider(undefined, false), {}, 'free text needs no structured outputs');
});

test('an operator who set require_parameters keeps their choice', () => {
  assert.deepEqual(openRouterProvider({ require_parameters: false }, true), { require_parameters: false });
});
