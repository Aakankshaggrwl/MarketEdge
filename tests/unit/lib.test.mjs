import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repairTruncatedJSON, safeParseJSON } from '../../lib/json.js';
import { truncateToWordLimit, parseTextReport, parseKeyValueLines } from '../../lib/report.js';
import { addApiUsage, emptyUsage, usageCostUSD, finalizeUsage } from '../../lib/cost.js';
import { normalizeUrl, collectSearchSources, buildResearch, sanitizeResearch, formatFactBase } from '../../lib/research.js';
import { sanitizeFinancialSummary, formatFinancialSummary, fmtUSD, sanitizePriorContext } from '../../lib/context.js';
import { finalText } from '../../lib/claude.js';

test('repairTruncatedJSON salvages an array cut off mid-string', () => {
  const cut = '{"competitors":[{"name":"A","values":{"x":"1"}},{"name":"B","values":{"x":"unfinish';
  const parsed = JSON.parse(repairTruncatedJSON(cut));
  assert.equal(parsed.competitors[0].name, 'A');
});

test('repairTruncatedJSON drops a dangling key', () => {
  const parsed = JSON.parse(repairTruncatedJSON('{"a":1,"b":'));
  assert.deepEqual(parsed, { a: 1 });
});

test('safeParseJSON tolerates code fences and leading prose', () => {
  assert.deepEqual(safeParseJSON('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(safeParseJSON('Based on my research, here it is: {"a":2}'), { a: 2 });
});

test('truncateToWordLimit caps words and balances bold markers', () => {
  const text = Array.from({ length: 50 }, (_, i) => `word${i}.`).join(' ');
  const out = truncateToWordLimit(text, 10);
  assert.ok(out.split(/\s+/).length <= 10);
  assert.equal(truncateToWordLimit('short text', 10), 'short text');
  const bold = truncateToWordLimit('one **two three four', 3);
  assert.equal((bold.match(/\*\*/g) || []).length % 2, 0);
});

test('parseTextReport splits sections and caps the executive summary', () => {
  const longSummary = Array.from({ length: 1500 }, () => 'word').join(' ');
  const raw = `TITLE: My Report\n---SECTION---\nEXECUTIVE_SUMMARY: ${longSummary}\n---SECTION---\nKEY_FINDINGS: Findings here.`;
  const report = parseTextReport(raw, 'Fallback');
  assert.equal(report.title, 'My Report');
  assert.deepEqual(report.sections.map(s => s.heading), ['Executive Summary', 'Key Findings']);
  assert.ok(report.sections[0].content.split(/\s+/).length <= 1000);
});

test('parseKeyValueLines reads cover lines', () => {
  const rows = parseKeyValueLines('Company: Acme\n- **Funding Ask:** $750K\nnot a pair');
  assert.deepEqual(rows, [{ label: 'Company', value: 'Acme' }, { label: 'Funding Ask', value: '$750K' }]);
});

test('usage cost uses Sonnet 5 rates plus web search', () => {
  const u = emptyUsage();
  addApiUsage(u, { input_tokens: 1_000_000, output_tokens: 100_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 0, server_tool_use: { web_search_requests: 10 } });
  // $2 input + $1 output + $0.20 cache read + $0.10 searches
  assert.equal(Math.round(usageCostUSD(u) * 100) / 100, 3.3);
  assert.equal(finalizeUsage(u).usd, 3.3);
});

test('normalizeUrl compares URLs loosely but safely', () => {
  assert.equal(normalizeUrl('https://www.Example.com/a/?utm_source=x#frag'), 'example.com/a');
  assert.equal(normalizeUrl('javascript:alert(1)'), null);
  assert.equal(normalizeUrl('not a url'), null);
});

const searchBlocks = [
  { type: 'server_tool_use', id: 'srv1', name: 'web_search', input: { query: 'x' } },
  { type: 'web_search_tool_result', tool_use_id: 'srv1', content: [
    { type: 'web_search_result', url: 'https://www.marketsandmarkets.com/report', title: 'Market Report', page_age: '2025' },
    { type: 'web_search_result', url: 'https://competitor.io/pricing', title: 'Competitor Pricing' },
  ] },
  { type: 'code_execution_tool_result', content: { nested: [{ type: 'web_search_result', url: 'https://nested.org/data', title: 'Nested' }] } },
  { type: 'text', text: 'Summary', citations: [{ type: 'web_search_result_location', url: 'https://cited.com/page', title: 'Cited' }] },
];

test('collectSearchSources finds top-level, nested and cited URLs', () => {
  const map = collectSearchSources(searchBlocks);
  assert.deepEqual([...map.keys()].sort(), ['cited.com/page', 'competitor.io/pricing', 'marketsandmarkets.com/report', 'nested.org/data']);
});

test('buildResearch keeps only facts whose source was really returned by search', () => {
  const raw = {
    marketSummary: 'Growing market.',
    facts: [
      { category: 'market_size', claim: 'Market is $3.5B in 2025.', source_url: 'https://marketsandmarkets.com/report/', published: '2025' },
      { category: 'growth', claim: 'Invented fact.', source_url: 'https://made-up.example/report' },
      { category: 'pricing', claim: 'Competitor charges $99/mo.', source_url: 'https://competitor.io/pricing?utm_source=google' },
      { category: 'market_size', claim: 'Market is $3.5B in 2025.', source_url: 'https://marketsandmarkets.com/report' },
    ],
    competitors: [
      { name: 'Real Co', website: 'competitor.io', description: 'Does X.', source_url: 'https://competitor.io/pricing' },
      { name: 'Ghost Co', website: 'ghost.ai', description: 'Hallucinated.', source_url: 'https://ghost.ai' },
    ],
    gaps: ['Churn benchmarks'],
  };
  const r = buildResearch(raw, collectSearchSources(searchBlocks), { searchCount: 4 });
  assert.equal(r.facts.length, 2);
  assert.ok(r.facts.every(f => /^S\d+$/.test(f.sourceId)));
  assert.deepEqual(r.competitors.map(c => c.name), ['Real Co']);
  assert.equal(r.droppedUnverified, 2);
  assert.equal(r.sources.length, 2);
  assert.equal(r.facts[1].sourceId, r.competitors[0].sourceId);
  assert.equal(r.searchCount, 4);

  const text = formatFactBase(r);
  assert.match(text, /\[S1\] Market Report — https:\/\/www\.marketsandmarkets\.com\/report/);
  assert.match(text, /VERIFIED COMPETITORS/);
  assert.doesNotMatch(text, /Ghost Co|made-up/);
});

test('sanitizeResearch rejects tampered research', () => {
  assert.equal(sanitizeResearch(null), null);
  const r = sanitizeResearch({
    sources: [{ id: 'S1', title: 'ok', url: 'https://ok.com' }, { id: 'X', title: 'bad', url: 'https://bad.com' }, { id: 'S2', title: 'js', url: 'javascript:1' }],
    facts: [{ sourceId: 'S1', claim: 'kept' }, { sourceId: 'S9', claim: 'dropped' }],
    competitors: [],
  });
  assert.deepEqual(r.sources.map(s => s.id), ['S1']);
  assert.deepEqual(r.facts.map(f => f.claim), ['kept']);
  assert.match(formatFactBase(null), /none — live web research is not available/);
});

test('financial summary is sanitized and formatted with exact figures', () => {
  const fs = sanitizeFinancialSummary({
    revenue: [288000, 1200000, 'x', 5e6, 2.09e7], clients: [8, 20, 30, 80, 150], ebitda: [-5e5, -2e5, 1e5, 2e6, 1.1e7],
    breakEvenYear: 3, recommendedRaise: 3e6, grossMargin: 0.78,
  });
  assert.equal(fs.revenue[2], 0);
  assert.equal(fs.acv.length, 5);
  const text = formatFinancialSummary(fs);
  assert.match(text, /\| ARR \/ revenue \| \$288K \| \$1\.20M \| \$0 \| \$5\.00M \| \$20\.90M \|/);
  assert.match(text, /EBITDA break-even in Year 3/);
  assert.equal(fmtUSD(-1500000), '-$1.50M');
  assert.equal(sanitizeFinancialSummary('nope'), null);
});

test('prior context drops empty entries', () => {
  assert.deepEqual(sanitizePriorContext([{ name: 'A', summary: 's' }, { name: '', summary: 'x' }, null]), [{ name: 'A', summary: 's' }]);
  assert.deepEqual(sanitizePriorContext('x'), []);
});

test('finalText returns only the answer written after the last search', () => {
  const blocks = [
    { type: 'text', text: 'Let me search.' },
    { type: 'server_tool_use' },
    { type: 'web_search_tool_result' },
    { type: 'thinking', thinking: '' },
    { type: 'text', text: '{"a":' },
    { type: 'text', text: '1}' },
  ];
  assert.equal(finalText(blocks), '{"a":1}');
  assert.equal(finalText([{ type: 'text', text: 'plain' }]), 'plain');
});
