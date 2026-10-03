import { test as base, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');

// The page loads its libraries from public CDNs; tests serve the identical packages from
// node_modules so they run offline and deterministically.
const CDN_LIBS = {
  'https://unpkg.com/react@18/umd/react.production.min.js': 'node_modules/react/umd/react.production.min.js',
  'https://unpkg.com/react-dom@18/umd/react-dom.production.min.js': 'node_modules/react-dom/umd/react-dom.production.min.js',
  'https://unpkg.com/@babel/standalone/babel.min.js': 'node_modules/@babel/standalone/babel.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js': 'node_modules/html2pdf.js/dist/html2pdf.bundle.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js': 'node_modules/xlsx/dist/xlsx.full.min.js',
  'https://cdn.jsdelivr.net/npm/pptxgenjs@4.0.1/dist/pptxgen.bundle.js': 'node_modules/pptxgenjs/dist/pptxgen.bundle.js',
};

const usage = (usd) => ({ inputTokens: 5000, outputTokens: 9000, cacheCreationTokens: 0, cacheReadTokens: 2000, webSearches: 0, model: 'claude-sonnet-5', usd });

export const RESEARCH = {
  generatedAt: '2026-10-01T10:00:00.000Z',
  marketSummary: 'The GCC food-manufacturing software market is growing quickly, driven by halal traceability rules.',
  sources: [
    { id: 'S1', title: 'GCC Food AI Market Report 2026', url: 'https://reports.example.com/gcc-food-ai' },
    { id: 'S2', title: 'Rival Inc — Pricing', url: 'https://rival.example.com/pricing' },
  ],
  facts: [
    { sourceId: 'S1', category: 'market_size', claim: 'The GCC AI food cloud market is worth $775M in 2026.', published: '2026' },
    { sourceId: 'S1', category: 'growth', claim: 'The market is growing at 34% a year.', published: '2026' },
  ],
  competitors: [{ name: 'Rival Inc', website: 'rival.example.com', description: 'ERP for food plants.', pricing: '$500/month', funding: 'Series A', sourceId: 'S2' }],
  gaps: ['Churn benchmarks for the region'],
  searchCount: 7,
  droppedUnverified: 1,
};

export const MODEL = {
  years: ['Year 1', 'Year 2', 'Year 3', 'Year 4', 'Year 5'],
  market: { primaryMarketName: 'GCC AI Food Cloud', primaryMarketSizeUSDM_Y1: 775.7, primaryMarketCAGR: 0.343, globalMarketName: 'Global AI F&B', globalMarketSizeUSDM_Y1: 18340, globalMarketCAGR: 0.37, sourceNote: 'Market size and CAGR per [S1].' },
  segmentFilters: [{ label: 'Food manufacturing share', percent: 0.43, rationale: 'r' }, { label: 'Software share', percent: 0.49, rationale: 'r' }],
  samPremium: { label: 'Halal compliance gap', amountUSDM: 20, rationale: 'r' },
  pricingTiers: [{ name: 'Compliance', monthlyPriceUSD: 1600, rationale: 'r' }, { name: 'Freshness AI', monthlyPriceUSD: 2000, rationale: 'r' }],
  blendedACVByYear: [36000, 60000, 96000, 120000, 120000],
  clientTargetsByYear: [8, 20, 30, 80, 150],
  churnRate: 0.08, nrr: 1.15, grossMargin: 0.78,
  segments: [{ name: 'Halal processors', clientsByYear: [5, 12, 18, 50, 90], entryACV: 19200, fullSuiteACV: 57600, icpNote: 'n' }],
  geographies: [{ name: 'USA', region: 'North America', tamPctOfGlobal: 0.28, cagr: 0.34, accessiblePct: 0.22, regulatoryPremiumUSDM: 35, entryTiming: 'Q4 2027', clientsByYear: [0, 1, 3, 10, 20], acvByYear: [0, 45000, 55000, 63000, 70000], regulatoryDriver: 'FSMA 204' }],
  salaryRoster: [
    { role: 'CEO', headcountByYear: [1, 1, 1, 1, 1], monthlySalaryY1USD: 8000, annualEscalationPct: 0.1, contractType: 'Full Time', notes: 'n' },
    { role: 'Engineer', headcountByYear: [2, 4, 6, 10, 16], monthlySalaryY1USD: 5000, annualEscalationPct: 0.1, contractType: 'Full Time', notes: 'n' },
  ],
  expenseCategories: [{ category: 'Technology', lineItems: [
    { description: 'Cloud hosting', driverType: 'escalating', y1AnnualUSD: 12000, escalationPct: 0.3, ratePerHead: 0, notes: 'n' },
    { description: 'Laptops', driverType: 'perNewHire', y1AnnualUSD: 0, escalationPct: 0, ratePerHead: 1500, notes: 'n' },
  ] }],
  funding: { revenueMultiple: 10, equityPctForRaise: 0.2, minimumRaiseUSD: 1500000, cacByYear: [8000, 6000, 5000, 4000, 3500], ltvHorizonYears: 3 },
};

export function reportFor(key, name) {
  if (key === 'bizplan') {
    return {
      title: 'Test Co — Business Plan',
      style: 'bizplan',
      cover: [
        { label: 'Company', value: 'Test Co' },
        { label: 'Offering', value: 'AI compliance software for food processors' },
        { label: 'Funding Ask', value: '$1.50M seed' },
      ],
      sections: [
        { heading: 'Executive Summary', content: 'Test Co sells halal-compliance software into a $775M market [S1].\n\n[[FIVE_YEAR_SNAPSHOT]]' },
        { heading: 'Competitive Landscape', content: 'The field is fragmented.\n\n| Competitor | Positioning | Pricing | Weakness We Exploit |\n| --- | --- | --- | --- |\n| Rival Inc | ERP for food | $500/mo [S2] | No halal module |' },
        { heading: 'Financial Plan', content: '## Five-Year Financial Projections\n\nThe plan reaches scale by Year 5.\n\n[[FINANCIAL_PROJECTIONS_TABLE]]\n\n## Unit Economics\n\n[[UNIT_ECONOMICS_TABLE]]' },
      ],
    };
  }
  const extra = key === 'financial'
    ? '\n\n## Market Sizing\n\nSized bottom-up.\n\n[[MARKET_SIZE_TABLE]]\n\n## Five-Year Projections\n\n[[FINANCIAL_PROJECTIONS_TABLE]]'
    : '';
  return {
    title: name,
    sections: [
      { heading: 'Executive Summary', content: `## Headline Conclusions\n\n${name} summary for this client. The market is worth **$775M** [S1] and growing 34% a year [S1]; churn is roughly 8% (est.).${extra}` },
      { heading: 'Key Findings', content: '### Finding One\n\nA finding.' },
    ],
  };
}

const DECK = {
  companyName: 'Test Co', tagline: 'AI compliance for food',
  slides: [
    { type: 'title', title: 'Test Co', subtitle: 'Investor Presentation' },
    { type: 'cards', title: 'Executive Summary', cards: [{ label: 'The Opportunity', text: '$775M market [S1]' }, { label: 'The Ask', text: 'Seed round' }] },
    { type: 'section', number: '01', title: 'Market & Competition' },
    { type: 'bigNumbers', title: 'The Problem', stats: [{ value: '$775M', label: 'GCC market 2026 [S1]' }, { value: '34%', label: 'Annual growth' }], note: 'Underserved.' },
    { type: 'table', title: 'Competitors', columns: ['Competitor', 'Pricing'], rows: [['Rival Inc', '$500/mo']] },
    { type: 'marketSize', title: 'TAM / SAM / SOM', takeaway: 'Big enough.' },
    { type: 'section', number: '03', title: 'Financial Model' },
    { type: 'chart', chart: 'arr', title: 'Revenue Model', takeaway: 'Fast ramp.' },
    { type: 'chart', chart: 'pnl', title: 'P&L', takeaway: 'Breakeven.' },
    { type: 'unitEconomics', title: 'Unit Economics', takeaway: 'Healthy.' },
    { type: 'chart', chart: 'headcount', title: 'Team', takeaway: 'Lean.' },
    { type: 'ask', title: 'The Ask', useOfFunds: [{ label: 'Product', pct: 60 }, { label: 'Sales', pct: 40 }], milestones: ['Launch pilot'] },
    { type: 'chart', chart: 'cash', title: 'Runway', takeaway: 'Covered.' },
    { type: 'bullets', title: 'Go-to-market', bullets: ['Free audit hook'], callout: 'Audit closes deals' },
    { type: 'closing', title: 'Next Steps', points: ['Close the round'] },
  ],
};

// Mocks every /api call the browser makes and records the request bodies.
export async function mockApi(page, overrides = {}) {
  const calls = [];
  const json = (route, status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const endpoint = url.pathname.replace('/api/', '');
    if (endpoint === 'config' || endpoint === 'log-error') return route.fallback();
    const body = route.request().postDataJSON();
    calls.push({ endpoint, body });
    if (overrides[endpoint]) return overrides[endpoint](route, body, json);
    switch (endpoint) {
      case 'generate-sow':
        return json(route, 200, { success: true, sow: { engagement_summary: 'A focused engagement.', milestones: [{ key: 'customer', name: 'Customer Analysis', rationale: 'Because.' }] }, usage: usage(0.03) });
      case 'research':
        return json(route, 200, { success: true, research: RESEARCH, usage: { ...usage(0.25), webSearches: 7 } });
      case 'generate-milestone-report':
        return json(route, 200, { success: true, report: reportFor(body.milestoneKey, body.milestoneName), usage: usage(0.12) });
      case 'generate-competitor-matrix':
        return json(route, 200, { success: true, matrix: { columns: [{ key: 'overview', label: 'Overview', category: 'Company Profile' }], competitors: [
          { name: 'Rival Inc', values: { overview: 'ERP [S2]' }, source: { id: 'S2', url: 'https://rival.example.com/pricing', title: 'Rival' } },
          { name: 'Other Co', values: { overview: 'Something (est.)' }, source: null },
        ] }, usage: usage(0.08) });
      case 'generate-financial-model':
        return json(route, 200, { success: true, model: MODEL, usage: usage(0.09) });
      case 'generate-pitch-deck':
        return json(route, 200, { success: true, deck: DECK, usage: usage(0.05) });
      default:
        return json(route, 404, { error: `unmocked ${endpoint}` });
    }
  });
  return calls;
}

export const test = base.extend({
  page: async ({ page }, use) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route(/^https:\/\/(unpkg\.com|cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net)\//, (route) => {
      const local = CDN_LIBS[route.request().url()];
      if (!local) return route.abort();
      return route.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(path.join(ROOT, local)) });
    });
    await use(page);
    expect(errors, `uncaught page errors: ${errors.join(' | ')}`).toEqual([]);
  },
});

export { expect };

export async function startEngagement(page, name = 'Test Co') {
  await page.goto('/');
  await page.fill('input[type="email"]', 'demo@marketedge.com');
  await page.fill('input[type="password"]', 'Strategy2026');
  await page.click('button:has-text("Login")');
  await page.fill('#newBusinessName', name);
  await page.click('button:has-text("Create")');
  await page.fill('textarea', 'We build AI compliance software for GCC food processors.');
  await page.click('input[placeholder="Select or type industry"]');
  await page.click('.combo-option:has-text("Manufacturing")');
}

export async function readDownload(download) {
  const file = await download.path();
  return fs.readFileSync(file);
}
