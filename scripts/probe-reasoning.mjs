#!/usr/bin/env node
/**
 * Which `reasoning_effort` a model actually honours, measured rather than read.
 *
 * Ollama enables thinking for any capable model unless told not to, and its
 * documented mapping — none off, low/medium/high on with rising effort — is
 * reported wrong on the cloud endpoint for at least one model
 * (ollama/ollama#18121), where low and high behaved like off and medium like
 * on. So the value to use is a question about this model on this endpoint, and
 * the answer costs four small requests.
 *
 *   REVIEWPASS_API_KEY=… node scripts/probe-reasoning.mjs \
 *     https://ollama.com/v1 deepseek-v4-flash:0731
 */
const [endpoint, model] = process.argv.slice(2);
const key = process.env.REVIEWPASS_API_KEY ?? process.env.OLLAMA_API_KEY;
if (!endpoint || !model || !key) {
  console.error('usage: REVIEWPASS_API_KEY=… node scripts/probe-reasoning.mjs <endpoint> <model>');
  process.exit(2);
}

// Small, and shaped like the real thing: a schema-constrained object is what
// the reviewer asks for, and it is what the model reasons its way towards.
const schema = {
  type: 'object', additionalProperties: false, required: ['findings'],
  properties: { findings: { type: 'array', items: { type: 'string' } } },
};

async function probe(effort) {
  const body = {
    model,
    messages: [
      { role: 'system', content: 'You review code. Answer with JSON matching the schema.' },
      { role: 'user', content: 'Return an empty findings array. Nothing else.' },
    ],
    max_tokens: 2048,
    response_format: { type: 'json_schema', json_schema: { name: 'findings', strict: true, schema } },
    ...(effort ? { reasoning_effort: effort } : {}),
  };
  const started = Date.now();
  let res, json;
  try {
    res = await fetch(`${endpoint}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { effort: effort ?? '(unset)', error: String(err).slice(0, 60), ms: Date.now() - started };
  }
  // The status and the elapsed time are the two columns worth having when a
  // gateway answers with HTML or nothing at all, so the body is parsed
  // separately and its failure does not take them with it.
  const text = await res.text().catch(() => '');
  try { json = JSON.parse(text); } catch {
    return {
      effort: effort ?? '(unset)', http: res.status, finish: 'non-JSON body',
      content: 0, reasoning: 0, tokens: 0, ms: Date.now() - started,
    };
  }
  const choice = json?.choices?.[0];
  const msg = choice?.message ?? {};
  // `||`, not `??`. An empty `reasoning_content` beside a populated `thinking`
  // is not null, so nullish coalescing stops at the empty string and reports a
  // thinking request as though thinking were off — which is precisely the
  // measurement this script exists to make.
  const reasoning = msg.reasoning_content || msg.thinking || msg.reasoning || '';
  return {
    effort: effort ?? '(unset)',
    http: res.status,
    finish: choice?.finish_reason ?? '-',
    content: (msg.content ?? '').trim().length,
    reasoning: reasoning.length,
    tokens: json?.usage?.completion_tokens ?? 0,
    ms: Date.now() - started,
    err: json?.error?.message?.slice(0, 40),
  };
}

console.log(`  ${model} @ ${endpoint}\n`);
console.log(`  ${'effort'.padEnd(10)}${'http'.padStart(5)}${'finish'.padStart(9)}${'content'.padStart(9)}${'reasoning'.padStart(11)}${'tokens'.padStart(8)}${'ms'.padStart(7)}`);
for (const effort of [undefined, 'none', 'low', 'medium', 'high']) {
  const r = await probe(effort);
  if (r.error || r.err) { console.log(`  ${String(r.effort).padEnd(10)}  ${r.error ?? r.err}`); continue; }
  console.log(
    `  ${String(r.effort).padEnd(10)}${String(r.http).padStart(5)}${String(r.finish).padStart(9)}`
    + `${String(r.content).padStart(9)}${String(r.reasoning).padStart(11)}${String(r.tokens).padStart(8)}${String(r.ms).padStart(7)}`,
  );
}
console.log('\n  Want: content > 0, finish=stop, reasoning small. A row with content 0 is the failure you are seeing.');
