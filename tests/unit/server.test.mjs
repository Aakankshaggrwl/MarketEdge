import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMockAnthropic, textMessage } from '../helpers/mock-anthropic.mjs';

let mock;
let base;
let httpServer;
let respond = () => textMessage('{}');

const sow = { engagement_summary: 'Test engagement.', milestones: [] };
const intake = { brief: 'AI software for GCC food processors', industry: 'Food Tech', stage: 'Idea stage', market: 'Middle East / GCC', goal: 'Raise funding' };

const research = {
  generatedAt: '2026-10-01T00:00:00.000Z',
  marketSummary: 'Growing.',
  sources: [{ id: 'S1', title: 'Market Report', url: 'https://reports.example.com/gcc' }, { id: 'S2', title: 'Rival', url: 'https://rival.example.com' }],
  facts: [{ sourceId: 'S1', category: 'market_size', claim: 'GCC food AI market is $775M in 2026.', published: '2026' }],
  competitors: [{ name: 'Rival Inc', website: 'rival.example.com', description: 'ERP for food.', pricing: '$500/mo', funding: 'Series A', sourceId: 'S2' }],
  gaps: [],
};

const financialSummary = {
  revenue: [288000, 1200000, 2880000, 9600000, 18000000], clients: [8, 20, 30, 80, 150], acv: [36000, 60000, 96000, 120000, 120000],
  grossProfit: [1, 2, 3, 4, 5], totalCosts: [1, 2, 3, 4, 5], ebitda: [-900000, -400000, 200000, 3000000, 8000000],
  ebitdaMargin: [-3, -0.3, 0.07, 0.31, 0.44], cumulativeCash: [-900000, -1300000, -1100000, 1900000, 9900000], headcount: [5, 9, 14, 30, 50],
  tamM: [775, 1040, 1400, 1880, 2520], samM: [97, 120, 150, 190, 250], somM: [0.29, 1.2, 2.9, 9.6, 18], ltvCac: [3, 5, 8, 12, 15], cacPaybackMonths: [12, 10, 8, 6, 5],
  grossMargin: 0.78, churnRate: 0.08, recommendedRaise: 3000000, preMoneyY1: 2880000, peakFundingGap: 1300000, breakEvenYear: 3, primaryMarketName: 'GCC Food AI',
};

before(async () => {
  mock = await startMockAnthropic((body, i) => respond(body, i));
  process.env.ANTHROPIC_BASE_URL = mock.url;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  process.env.BOOKING_URL = 'https://cal.example.com/marketedge';
  const { default: app } = await import('../../server.js');
  httpServer = app.listen(0);
  await new Promise(r => httpServer.once('listening', r));
  base = `http://127.0.0.1:${httpServer.address().port}`;
});

after(async () => {
  httpServer?.close();
  await mock?.close();
});

const post = async (path, body) => {
  const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: r.status === 204 ? null : await r.json() };
};

test('research resumes a paused search turn and keeps only verified sources', async () => {
  const start = mock.requests.length;
  respond = (body, i) => {
    if (i === start) {
      return {
        stop_reason: 'pause_turn',
        usage: { input_tokens: 4000, output_tokens: 300, server_tool_use: { web_search_requests: 3 } },
        content: [
          { type: 'text', text: 'Searching the market.' },
          { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'gcc food ai market size' } },
          { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [
            { type: 'web_search_result', url: 'https://reports.example.com/gcc-food-ai', title: 'GCC Food AI Report', encrypted_content: 'abc', page_age: '2026' },
            { type: 'web_search_result', url: 'https://rival.example.com/', title: 'Rival Inc', encrypted_content: 'def' },
          ] },
        ],
      };
    }
    return {
      usage: { input_tokens: 5000, output_tokens: 900, server_tool_use: { web_search_requests: 2 } },
      content: [{ type: 'text', text: JSON.stringify({
        marketSummary: 'A growing market.',
        facts: [
          { category: 'market_size', claim: 'The GCC food AI market is $775M in 2026.', source_url: 'https://reports.example.com/gcc-food-ai', published: '2026' },
          { category: 'growth', claim: 'Hallucinated 90% CAGR.', source_url: 'https://never-searched.example.org/x' },
        ],
        competitors: [
          { name: 'Rival Inc', website: 'rival.example.com', description: 'ERP for food.', pricing: '$500/mo', funding: 'Series A', source_url: 'https://www.rival.example.com' },
          { name: 'Ghost Ltd', website: 'ghost.example', description: 'Made up.', source_url: 'https://ghost.example' },
        ],
        gaps: ['Churn benchmarks for the region'],
      }) }],
    };
  };

  const { status, body } = await post('/api/research', { sow, intake, businessName: 'Drizzla' });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.research.facts.length, 1);
  assert.deepEqual(body.research.competitors.map(c => c.name), ['Rival Inc']);
  assert.equal(body.research.droppedUnverified, 2);
  assert.equal(body.usage.webSearches, 5);
  assert.equal(body.usage.inputTokens, 9000);
  assert.ok(body.usage.usd > 0);

  const [first, second] = mock.requests.slice(start);
  assert.equal(first.tools[0].type, 'web_search_20260209');
  assert.equal(first.tools[0].max_uses, 10);
  assert.equal(first.stream, true);
  // The continuation re-sends the paused assistant content, with no extra user turn.
  assert.equal(second.messages.length, 2);
  assert.equal(second.messages[1].role, 'assistant');
  assert.equal(second.messages[1].content[2].type, 'web_search_tool_result');
});

test('research with no verifiable sources returns a clear error', async () => {
  respond = () => textMessage(JSON.stringify({ facts: [{ claim: 'x', source_url: 'https://nowhere.example' }], competitors: [] }));
  const { status, body } = await post('/api/research', { sow, intake });
  assert.equal(status, 502);
  assert.match(body.error, /continue without research/);
});

test('business plan request carries fact base, prior milestones and model figures', async () => {
  const start = mock.requests.length;
  respond = () => textMessage([
    'TITLE: Drizzla — Business Plan',
    '---SECTION---',
    'COVER: Company: Drizzla\nFunding Ask: $3.00M\nYear 5 Revenue: $18.00M ARR — 150 clients',
    '---SECTION---',
    'EXECUTIVE_SUMMARY: The plan in brief [S1].\n\n[[FIVE_YEAR_SNAPSHOT]]',
    '---SECTION---',
    'FINANCIAL_PLAN: ## Five-Year Financial Projections\n\n[[FINANCIAL_PROJECTIONS_TABLE]]',
  ].join('\n'), { usage: { input_tokens: 2000, output_tokens: 9000, cache_read_input_tokens: 3000 } });

  const { status, body } = await post('/api/generate-milestone-report', {
    milestoneKey: 'bizplan', milestoneName: 'Business Plan', sow, intake, businessName: 'Drizzla',
    research, financialSummary,
    priorContext: [{ name: 'Beachhead Selection', summary: 'Halal processors in the UAE are the beachhead.' }],
  });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.report.style, 'bizplan');
  assert.deepEqual(body.report.cover[0], { label: 'Company', value: 'Drizzla' });
  assert.deepEqual(body.report.sections.map(s => s.heading), ['Executive Summary', 'Financial Plan']);
  assert.equal(body.usage.cacheReadTokens, 3000);

  const req = mock.requests[start];
  const [shared, variable] = req.messages[0].content;
  assert.deepEqual(shared.cache_control, { type: 'ephemeral' });
  assert.match(shared.text, /Business name: Drizzla/);
  assert.match(shared.text, /\[S1\] Market Report — https:\/\/reports\.example\.com\/gcc/);
  assert.match(shared.text, /Rival Inc/);
  assert.match(variable.text, /Halal processors in the UAE/);
  assert.match(variable.text, /\| ARR \/ revenue \| \$288K/);
  assert.match(variable.text, /EBITDA break-even in Year 3/);
  assert.match(variable.text, /MARKET_OPPORTUNITY/);
  assert.match(req.system, /never invent a source/i);
  assert.equal(req.max_tokens, 20000);
});

test('shared prompt block is byte-identical across milestones so it can be cached', async () => {
  const start = mock.requests.length;
  respond = () => textMessage('TITLE: X\n---SECTION---\nEXECUTIVE_SUMMARY: Summary.');
  await post('/api/generate-milestone-report', { milestoneKey: 'customer', milestoneName: 'Customer Analysis', sow, intake, businessName: 'Drizzla', research });
  await post('/api/generate-milestone-report', { milestoneKey: 'gap', milestoneName: 'Gap Analysis', sow, intake, businessName: 'Drizzla', research, priorContext: [{ name: 'Customer Analysis', summary: 'Summary.' }] });
  const [a, b] = mock.requests.slice(start);
  assert.equal(a.system, b.system);
  assert.equal(a.messages[0].content[0].text, b.messages[0].content[0].text);
});

test('reports without research tell the model to label estimates', async () => {
  const start = mock.requests.length;
  respond = () => textMessage('TITLE: X\n---SECTION---\nEXECUTIVE_SUMMARY: Summary.');
  await post('/api/generate-milestone-report', { milestoneKey: 'customer', milestoneName: 'Customer Analysis', sow, intake });
  assert.match(mock.requests[start].messages[0].content[0].text, /live web research is not available/);
});

test('competitor matrix links verified competitors to their source', async () => {
  respond = () => textMessage(JSON.stringify({ competitors: [
    { name: 'Rival Inc', source_id: 'S2', values: { overview: 'ERP [S2]' } },
    { name: 'Other Co', source_id: '', values: { overview: 'Something (est.)' } },
    { name: 'Spoof', source_id: 'S99', values: { overview: 'x' } },
  ] }));
  const { status, body } = await post('/api/generate-competitor-matrix', { sow, intake, research });
  assert.equal(status, 200);
  assert.deepEqual(body.matrix.competitors[0].source, { id: 'S2', url: 'https://rival.example.com', title: 'Rival' });
  assert.equal(body.matrix.competitors[1].source, null);
  assert.equal(body.matrix.competitors[2].source, null);
  assert.equal(body.matrix.columns.length, 18);
});

test('pitch deck is sanitized to known slide types', async () => {
  respond = () => textMessage(JSON.stringify({
    companyName: 'Drizzla', tagline: 'AI food cloud',
    slides: [
      { type: 'title', title: 'Drizzla', subtitle: 'Investor Presentation' },
      { type: 'cards', title: 'Executive Summary', cards: [{ label: 'The Ask', text: '$3M seed' }] },
      { type: 'chart', chart: 'nonsense', title: 'ARR' },
      { type: 'script', title: '<script>' },
      { type: 'table', title: 'Risks', columns: ['Risk', 'Mitigation'], rows: [['A', 'B', 'extra']] },
      { type: 'ask', title: 'The Ask', useOfFunds: [{ label: 'Product', pct: 140 }], milestones: ['Launch'] },
      { type: 'closing', title: 'Next Steps', points: ['Sign'] },
    ],
  }));
  const { status, body } = await post('/api/generate-pitch-deck', { sow, intake, research, financialSummary });
  assert.equal(status, 200);
  assert.deepEqual(body.deck.slides.map(s => s.type), ['title', 'cards', 'chart', 'table', 'ask', 'closing']);
  assert.equal(body.deck.slides[2].chart, 'arr');
  assert.deepEqual(body.deck.slides[3].rows[0], ['A', 'B']);
  assert.equal(body.deck.slides[4].useOfFunds[0].pct, 100);
});

test('a refusal becomes a readable 422', async () => {
  respond = () => ({ content: [{ type: 'text', text: '' }], stop_reason: 'refusal' });
  const { status, body } = await post('/api/generate-milestone-report', { milestoneKey: 'customer', milestoneName: 'Customer Analysis', sow, intake });
  assert.equal(status, 422);
  assert.match(body.error, /declined/);
});

test('an API billing error is passed through with its status', async () => {
  respond = () => ({ httpError: { status: 400, error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } } });
  const { status, body } = await post('/api/generate-sow', { brief: 'x', industry: 'y', stage: 'z', market: 'India', goal: 'g' });
  assert.equal(status, 400);
  assert.match(body.error, /credit balance is too low/);
});

test('sow returns usage', async () => {
  respond = () => textMessage(JSON.stringify({ engagement_summary: 'S', milestones: [{ key: 'customer', name: 'Customer Analysis', rationale: 'r' }] }));
  const { status, body } = await post('/api/generate-sow', { brief: 'x', industry: 'y', stage: 'z', market: 'India', goal: 'g' });
  assert.equal(status, 200);
  assert.equal(body.usage.outputTokens, 50);
});

test('config and client error logging endpoints', async () => {
  const cfg = await (await fetch(base + '/api/config')).json();
  assert.equal(cfg.bookingUrl, 'https://cal.example.com/marketedge');
  const { status } = await post('/api/log-error', { kind: 'error', message: 'boom' });
  assert.equal(status, 204);
});

test('legal pages are served', async () => {
  for (const p of ['/terms', '/privacy']) {
    const r = await fetch(base + p);
    assert.equal(r.status, 200);
    assert.match(await r.text(), /MarketEdge/);
  }
});
