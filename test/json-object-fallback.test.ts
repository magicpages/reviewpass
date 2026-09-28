/**
 * An endpoint that refuses strict json_schema must not turn found defects into
 * a clean file.
 *
 * reviewpass falls back to `json_object` when strict schema mode is refused,
 * which several hosted endpoints do for most of their models. `json_object`
 * promises some JSON, not this JSON:
 * measured, four of five models then answered with findings that had no
 * `start_line`/`end_line`, and `findInFile` dropped each one as drift. The review
 * found things and reported nothing - the false all-clear this reviewer exists
 * to avoid. Two defences: show the model the schema it lost, and refuse a reply
 * whose findings the pipeline cannot place.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelClient, withSchema, type ChatMessage } from '../src/model/client.js';
import { loadConfig } from '../src/config/index.js';
import { findInFile } from '../src/review/run.js';
import { FINDINGS_SCHEMA } from '../src/review/schemas.js';
import type { ChangedFile, PullRequestContext, ReviewUnit } from '../src/types.js';

type Body = Record<string, unknown>;
type Handler = (body: Body, res: ServerResponse) => void;

/** A stub model server: `handle` decides each reply; every request body is kept. */
async function withStub(handle: Handler, fn: (base: string, bodies: Body[]) => Promise<void>) {
  const bodies: Body[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw) as Body;
      bodies.push(body);
      handle(body, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  try {
    await fn(`http://127.0.0.1:${port}/v1`, bodies);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

function reply(res: ServerResponse, content: string) {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({
    choices: [{ message: { content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  }));
}

function config(endpoint: string) {
  const cfg = loadConfig(mkdtempSync(join(tmpdir(), 'reviewpass-cfg-')));
  cfg.model.endpoint = endpoint;
  cfg.model.endpoints = [endpoint];
  cfg.review.findSamples = 1;
  return cfg;
}

const file: ChangedFile = {
  path: 'src/a.ts', status: 'modified', additions: 1, deletions: 0,
  patch: '@@ -9,1 +10,1 @@\n+const total = items.length;', addedLines: [10],
};
const unit: ReviewUnit = {
  path: file.path, file, context: '', instructions: [], learnings: [], toolFindings: [],
};
const pr: PullRequestContext = {
  owner: 'o', repo: 'r', number: 1, title: 'a change', body: '', author: 'someone',
  baseSha: 'base', headSha: 'head', baseRef: 'main', files: [file],
  reviewedFrom: 'base', reviewedTo: 'head', isIncremental: false, linkedIssues: [],
  closed: false, merged: false,
};

test('withSchema writes the schema into the system prompt without touching the input', () => {
  const messages: ChatMessage[] = [{ role: 'system', content: 'Review.' }, { role: 'user', content: 'code' }];
  const out = withSchema(messages, FINDINGS_SCHEMA);
  assert.match(out[0]!.content, /^Review\.\n\n/);
  assert.ok(out[0]!.content.includes(JSON.stringify(FINDINGS_SCHEMA)));
  assert.deepEqual(out[1], messages[1]);
  assert.equal(messages[0]!.content, 'Review.', 'the caller\'s messages must not be mutated');
});

test('withSchema adds a system message when there is none', () => {
  const out = withSchema([{ role: 'user', content: 'code' }], FINDINGS_SCHEMA);
  assert.equal(out.length, 2);
  assert.equal(out[0]!.role, 'system');
  assert.ok(out[0]!.content.includes('"start_line"'));
});

test('a refused json_schema is retried as json_object with the schema in the prompt', async () => {
  await withStub((body, res) => {
    const format = body.response_format as { type?: string } | undefined;
    if (format?.type === 'json_schema') {
      res.statusCode = 400;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: { message: "The model 'x' does not support JSON schema mode. Use 'json_object' mode" } }));
      return;
    }
    reply(res, '{"findings":[]}');
  }, async (base, bodies) => {
    const client = new ModelClient(config(base));
    const r = await client.json<{ findings: unknown[] }>(
      [{ role: 'system', content: 'Review.' }, { role: 'user', content: 'code' }], FINDINGS_SCHEMA,
    );
    assert.deepEqual(r.value, { findings: [] });
    assert.equal(bodies.length, 2);
    assert.deepEqual(bodies[1]!.response_format, { type: 'json_object' });
    const system = (bodies[1]!.messages as ChatMessage[])[0]!;
    assert.ok(system.content.includes(JSON.stringify(FINDINGS_SCHEMA)),
      'without the schema a json_object reply invents its own keys');
  });
});

test('a reply whose findings all lack line numbers is a failure, not a clean file', async () => {
  const noLines = JSON.stringify({ findings: [
    { title: 'Guard the empty list', body: 'items may be empty.' },
    { title: 'Name the constant', body: 'Magic number.' },
  ] });
  await withStub((_b, res) => reply(res, noLines), async (base) => {
    const cfg = config(base);
    await assert.rejects(findInFile(new ModelClient(cfg), cfg, pr, unit), /no line numbers, title or body/);
  });
});

test('usable findings survive when others in the same reply are malformed', async () => {
  const mixed = JSON.stringify({ findings: [
    { start_line: 10, end_line: 10, title: 'Guard the empty list', body: 'items may be empty.' },
    { title: 'No lines here', body: 'dropped' },
    { start_line: 10, end_line: 10 },
  ] });
  await withStub((_b, res) => reply(res, mixed), async (base) => {
    const cfg = config(base);
    const found = await findInFile(new ModelClient(cfg), cfg, pr, unit);
    assert.equal(found.length, 1);
    assert.equal(found[0]!.title, 'Guard the empty list');
  });
});
