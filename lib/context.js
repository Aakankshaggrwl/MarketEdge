const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const five = (a) => (Array.isArray(a) ? a.slice(0, 5).map(num) : [0, 0, 0, 0, 0]);
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export function fmtUSD(n) {
  const v = num(n);
  const sign = v < 0 ? '-' : '';
  const a = Math.abs(v);
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${sign}$${Math.round(a / 1e3)}K`;
  return `${sign}$${Math.round(a)}`;
}
const fmtPct = (n) => `${(num(n) * 100).toFixed(1)}%`;
const fmtM = (n) => fmtUSD(num(n) * 1e6);

export function sanitizeFinancialSummary(fs) {
  if (!fs || typeof fs !== 'object') return null;
  return {
    revenue: five(fs.revenue), clients: five(fs.clients), acv: five(fs.acv),
    grossProfit: five(fs.grossProfit), totalCosts: five(fs.totalCosts), ebitda: five(fs.ebitda),
    ebitdaMargin: five(fs.ebitdaMargin), cumulativeCash: five(fs.cumulativeCash), headcount: five(fs.headcount),
    tamM: five(fs.tamM), samM: five(fs.samM), somM: five(fs.somM),
    ltvCac: five(fs.ltvCac), cacPaybackMonths: five(fs.cacPaybackMonths),
    grossMargin: num(fs.grossMargin), churnRate: num(fs.churnRate),
    recommendedRaise: num(fs.recommendedRaise), preMoneyY1: num(fs.preMoneyY1), peakFundingGap: num(fs.peakFundingGap),
    breakEvenYear: Number.isInteger(fs.breakEvenYear) ? fs.breakEvenYear : null,
    primaryMarketName: str(fs.primaryMarketName, 120),
  };
}

export function formatFinancialSummary(fs) {
  if (!fs) return '';
  const row = (label, arr, f) => `| ${label} | ${arr.map(f).join(' | ')} |`;
  return [
    `FINANCIAL MODEL — AUTHORITATIVE FIGURES. These come from the client's formula-linked 5-year model (the Excel workbook they will also receive). Use these exact numbers wherever you discuss revenue, costs, profitability, market size or funding, and never contradict them. Do not mark these "(est.)" — cite them as "per the financial model".`,
    `| Metric | Year 1 | Year 2 | Year 3 | Year 4 | Year 5 |`,
    `| --- | --- | --- | --- | --- | --- |`,
    row('ARR / revenue', fs.revenue, fmtUSD),
    row('Paying clients', fs.clients, (v) => String(Math.round(v))),
    row('Blended ACV', fs.acv, fmtUSD),
    row('Gross profit', fs.grossProfit, fmtUSD),
    row('Total operating costs', fs.totalCosts, fmtUSD),
    row('EBITDA', fs.ebitda, fmtUSD),
    row('EBITDA margin', fs.ebitdaMargin, fmtPct),
    row('Cumulative cash', fs.cumulativeCash, fmtUSD),
    row('Headcount', fs.headcount, (v) => String(Math.round(v))),
    row(`TAM${fs.primaryMarketName ? ` (${fs.primaryMarketName})` : ''}`, fs.tamM, fmtM),
    row('SAM', fs.samM, fmtM),
    row('SOM', fs.somM, fmtM),
    row('LTV : CAC', fs.ltvCac, (v) => `${v.toFixed(1)}x`),
    row('CAC payback (months)', fs.cacPaybackMonths, (v) => v.toFixed(1)),
    `Gross margin ${fmtPct(fs.grossMargin)}; annual churn ${fmtPct(fs.churnRate)}; recommended raise ${fmtUSD(fs.recommendedRaise)} at a ${fmtUSD(fs.preMoneyY1)} pre-money valuation; peak funding gap ${fmtUSD(fs.peakFundingGap)}; EBITDA break-even ${fs.breakEvenYear ? `in Year ${fs.breakEvenYear}` : 'not reached within the 5-year horizon'}.`,
  ].join('\n');
}

export function sanitizePriorContext(prior) {
  if (!Array.isArray(prior)) return [];
  return prior.slice(0, 9)
    .map(p => ({ name: str(p?.name, 80), summary: str(p?.summary, 9000) }))
    .filter(p => p.name && p.summary);
}

export function formatPriorContext(prior) {
  if (!prior.length) return '';
  return [
    `EARLIER MILESTONES ALREADY DELIVERED TO THIS CLIENT. Build on these — reuse their conclusions, chosen segments, beachhead, pricing and numbers, and never contradict them. Where this milestone changes an earlier conclusion, say so explicitly and why.`,
    ...prior.map(p => `\n=== ${p.name} — executive summary ===\n${p.summary}`),
  ].join('\n');
}
