import JSZip from 'jszip';
import XLSX from 'xlsx';
import { test, expect, mockApi, startEngagement, readDownload, RESEARCH } from './fixtures.mjs';

const sidebarStep = (page, label) => page.locator('.sidebar-step', { hasText: label });

test('full engagement: consent, research, chained milestones, plan, deck and strategy book', async ({ page }) => {
  const calls = await mockApi(page);
  await startEngagement(page);

  const generate = page.getByRole('button', { name: /Generate SOW/ });
  await expect(generate).toBeDisabled();
  await page.locator('.consent input[type="checkbox"]').check();
  await generate.click();
  await page.getByRole('button', { name: /Approve SOW/ }).click();

  // Research step runs automatically and shows what it verified.
  await expect(page.locator('.research-stat').first()).toContainText(String(RESEARCH.sources.length));
  await expect(page.getByText('The GCC AI food cloud market is worth $775M in 2026.')).toBeVisible();
  await expect(page.getByText(/couldn't verify/i)).toBeVisible();
  await page.getByRole('button', { name: /Continue to Milestones/ }).click();

  // Milestone 1: citations link to their sources, with a disclaimer and sources list.
  const cite = page.locator('.report-highlight a.cite').first();
  await expect(cite).toHaveAttribute('href', RESEARCH.sources[0].url);
  await expect(page.locator('.ai-disclaimer')).toBeVisible();
  await expect(page.locator('.sources-panel summary')).toContainText('(1)');
  await expect(sidebarStep(page, 'Customer Deep Dive')).toHaveClass(/completed/);
  // AI usage cost is tracked internally but never shown to the client.
  await expect(page.getByText(/AI cost/)).toHaveCount(0);
  await expect(page.locator('.page-header h1')).toHaveText('Customer Deep Dive');
  await expect(page.locator('.contents-table')).toContainText('Key Findings');
  await expect(page.locator('.contents-table')).toContainText('Finding One');

  const firstReport = calls.find(c => c.endpoint === 'generate-milestone-report');
  expect(firstReport.body.research.sources).toHaveLength(2);
  expect(firstReport.body.priorContext).toEqual([]);

  // Competitor milestone: matrix export carries a verification column and a Sources sheet.
  await page.getByRole('button', { name: 'Next →' }).click();
  await expect(page.getByRole('button', { name: /Competitor Comparison/ })).toBeVisible();
  const [matrixDl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Competitor Comparison/ }).click()]);
  const matrixWb = XLSX.read(await readDownload(matrixDl));
  expect(matrixWb.SheetNames).toEqual(['Competitor Comparison', 'Notes', 'Sources']);
  const matrixRows = XLSX.utils.sheet_to_json(matrixWb.Sheets['Competitor Comparison'], { header: 1 });
  expect(matrixRows[1].at(-1)).toBe('Verified Source');
  expect(matrixRows[2].at(-1)).toContain('https://rival.example.com/pricing');
  expect(matrixRows[3].at(-1)).toMatch(/Not verified/);
  // Counts on the Notes sheet are formulas over the matrix, not typed-in numbers.
  expect(matrixWb.Sheets.Notes.B6.f).toMatch(/^COUNTIF\('Competitor Comparison'!/);
  expect(matrixWb.Sheets.Notes.B6.v).toBe(1);

  // Jump straight to Business Plan: the financial model is generated first, then the plan
  // is written on top of the model's figures and earlier milestones.
  await sidebarStep(page, 'Business Plan').click();
  await expect(page.locator('.report-section h3')).toHaveText('Test Co — Business Plan');
  // Generating the model as part of this milestone must not flag the plan as out of date.
  await expect(page.getByText(/changed after this report was written/)).toHaveCount(0);
  const modelCall = calls.find(c => c.endpoint === 'generate-financial-model');
  expect(modelCall.body.priorContext.map(p => p.name)).toEqual(['Customer Deep Dive', 'Competitive Intelligence']);
  const planCall = calls.find(c => c.endpoint === 'generate-milestone-report' && c.body.milestoneKey === 'bizplan');
  expect(planCall.body.financialSummary.revenue[0]).toBe(8 * 36000);
  expect(planCall.body.financialSummary.clients[4]).toBe(150);
  expect(planCall.body.businessName).toBe('Test Co');
  await expect(page.locator('.report-section .report-table').first()).toContainText('Funding Ask');
  await expect(page.locator('.report-highlight .report-table')).toContainText('$288K');

  const [planPdf] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Download Full Report/ }).click()]);
  expect(planPdf.suggestedFilename()).toBe('Test-Co-Business-Plan.pdf');
  expect((await readDownload(planPdf)).subarray(0, 4).toString()).toBe('%PDF');

  // The Financial milestone reuses the same model rather than generating another one.
  await sidebarStep(page, 'Financial Projections').click();
  await expect(page.locator('.report-highlight .report-table').first()).toContainText('TAM — Total Addressable');
  expect(calls.filter(c => c.endpoint === 'generate-financial-model')).toHaveLength(1);
  const [modelDl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Financial Model \(Excel\)/ }).click()]);
  const modelWb = XLSX.read(await readDownload(modelDl), { cellStyles: true });
  expect(modelWb.SheetNames[0]).toBe('Cover');
  expect(modelWb.SheetNames.at(-1)).toBe('Sources');
  expect(modelWb.Sheets.Assumptions.H5.v).toContain('[S1]');
  // Key outputs on the cover are live formulas into the P&L.
  const coverFormulas = Object.values(modelWb.Sheets.Cover).filter(c => c?.f).map(c => c.f);
  expect(coverFormulas.some(f => f.includes("'Profit & Loss'!G"))).toBe(true)

  // Pitch deck: a real PPTX with native charts.
  await sidebarStep(page, 'Pitch Deck').click();
  const deckButton = page.getByRole('button', { name: /Download Pitch Deck/ });
  await expect(deckButton).toBeVisible();
  const [deckDl] = await Promise.all([page.waitForEvent('download'), deckButton.click()]);
  expect(deckDl.suggestedFilename()).toBe('Test-Co-Pitch-Deck.pptx');
  const zip = await JSZip.loadAsync(await readDownload(deckDl));
  const slides = Object.keys(zip.files).filter(f => /^ppt\/slides\/slide\d+\.xml$/.test(f));
  expect(slides).toHaveLength(21); // 20 planned slides + Sources
  expect(Object.keys(zip.files).filter(f => /^ppt\/charts\/chart\d+\.xml$/.test(f)).length).toBeGreaterThanOrEqual(5);
  const allText = (await Promise.all(slides.map(s => zip.file(s).async('string')))).join(' ');
  expect(allText).toContain('$18.00M'); // Year 5 ARR, drawn from the model
  expect(allText).toContain('GCC Food AI Market Report 2026');
  for (const heading of ['OUR MISSION', 'OUR VISION', 'THE PROBLEM', 'OUR SOLUTION', 'Halal processors', 'Gap We Exploit', 'KPI: 30% conversion', 'of Year 1 costs are people', 'Largest other costs', 'Q3 2027', 'MARKET OPPORTUNITY', 'Serviceable Obtainable Market', 'INVESTOR PRESENTATION']) {
    expect(allText).toContain(heading);
  }

  // Strategy Book + follow-up booking on the completion screen.
  await sidebarStep(page, 'Strategy Book').click();
  await expect(page.locator('.expert-card').getByRole('button', { name: /Connect to a Strategy Expert/ })).toBeVisible();
  const [book] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Download Strategy Book \(5 milestones\)/ }).click()]);
  expect(book.suggestedFilename()).toBe('Test-Co-Strategy-Book.pdf');
  expect((await readDownload(book)).length).toBeGreaterThan(10_000);
});

test('research failure can be skipped, and reports then flag that figures are estimates', async ({ page }) => {
  await mockApi(page, {
    research: (route, body, json) => json(route, 502, { error: "Web research didn't return any verifiable sources." }),
  });
  await startEngagement(page, 'No Research Co');
  await page.locator('.consent input[type="checkbox"]').check();
  await page.getByRole('button', { name: /Generate SOW/ }).click();
  await page.getByRole('button', { name: /Approve SOW/ }).click();

  await expect(page.getByText(/Research failed/)).toBeVisible();
  await page.getByRole('button', { name: /Continue Without Research/ }).click();
  await expect(page.locator('.notice')).toContainText('no live web research');
  await expect(page.locator('.report-highlight')).toBeVisible();
  // [S1] has no source to link to, so it is not rendered as a link.
  await expect(page.locator('a.cite')).toHaveCount(0);
});

test('regenerating an earlier milestone flags later ones as out of date', async ({ page }) => {
  await mockApi(page);
  await startEngagement(page, 'Upstream Co');
  await page.locator('.consent input[type="checkbox"]').check();
  await page.getByRole('button', { name: /Generate SOW/ }).click();
  await page.getByRole('button', { name: /Approve SOW/ }).click();
  await page.getByRole('button', { name: /Continue to Milestones/ }).click();
  await expect(page.locator('.report-highlight')).toBeVisible();

  await page.getByRole('button', { name: 'Next →' }).click();
  await expect(page.getByRole('button', { name: /Competitor Comparison/ })).toBeVisible();
  await expect(page.getByText(/changed after this report was written/)).toHaveCount(0);

  await page.getByRole('button', { name: '← Previous' }).click();
  await page.getByRole('button', { name: /Regenerate This Milestone/ }).click();
  await page.getByRole('button', { name: /^🔄 Regenerate$/ }).click();
  await expect(page.getByRole('button', { name: /Regenerate This Milestone/ })).toBeEnabled();

  await page.getByRole('button', { name: 'Next →' }).click();
  await expect(page.getByText(/changed after this report was written/)).toBeVisible();
});

test('a failed regeneration keeps the saved report', async ({ page }) => {
  let reportCalls = 0;
  await mockApi(page, {
    'generate-milestone-report': (route, body, json) => {
      reportCalls++;
      return reportCalls === 1
        ? json(route, 200, { success: true, report: { title: 'Customer Deep Dive', sections: [{ heading: 'Executive Summary', content: 'Original saved summary.' }] } })
        : route.abort('connectionfailed');
    },
  });
  await startEngagement(page, 'Keep Co');
  await page.locator('.consent input[type="checkbox"]').check();
  await page.getByRole('button', { name: /Generate SOW/ }).click();
  await page.getByRole('button', { name: /Approve SOW/ }).click();
  await page.getByRole('button', { name: /Continue to Milestones/ }).click();
  await expect(page.locator('.report-highlight')).toContainText('Original saved summary.');

  await page.getByRole('button', { name: /Regenerate This Milestone/ }).click();
  await page.getByRole('button', { name: /^🔄 Regenerate$/ }).click();
  await expect(page.locator('.error')).toContainText("Couldn't get a response from the server");
  await expect(page.locator('.report-highlight')).toContainText('Original saved summary.');
});

test('legal pages are linked from the app', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.lp-footer a[href="/terms"]')).toBeVisible();
  await page.goto('/privacy');
  await expect(page.locator('h1')).toHaveText('Privacy Policy');
  await expect(page.getByText(/Anthropic's Claude API/)).toBeVisible();
});

test('landing page explains the company and shows the login with access details', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.topbar .brand')).toBeVisible();
  await expect(page.getByRole('heading', { name: /Board-ready strategy deliverables, in hours/ })).toBeVisible();
  await expect(page.locator('.lp-stats')).toContainText('more than 12 years of industry experience');
  await expect(page.locator('.lp-stats')).toContainText('500+');
  await expect(page.locator('.lp-stats')).toContainText('PDF, Excel and PowerPoint');
  await expect(page.locator('.lp-stats')).toContainText('scope of work tailored to every business');
  await expect(page.locator('.lp-stats')).not.toContainText('Strategy milestones');
  await expect(page.locator('#custom')).toContainText('Not one formula for all');
  await expect(page.locator('#deliverables')).toContainText('ready to download');
  await expect(page.locator('#expert')).toContainText('in two clicks');
  await expect(page.locator('#about')).toContainText('About MarketEdge');
  await expect(page.locator('#deliverables .lp-card')).toHaveCount(9);
  await expect(page.locator('.demo-access')).toContainText('demo@marketedge.com');
  await page.fill('#login-email', 'demo@marketedge.com');
  await page.fill('#login-password', 'wrong');
  await page.click('form.login-card button[type="submit"]');
  await expect(page.locator('.login-error')).toBeVisible();
  await page.fill('#login-password', 'Strategy2026');
  await page.click('form.login-card button[type="submit"]');
  await expect(page.locator('.db-hero h1')).toContainText('Let’s build your edge');
  await page.getByRole('button', { name: /Log out/ }).click();
  await expect(page.locator('form.login-card')).toBeVisible();
});

test('the intake can be edited after reports exist; reports are kept and flagged', async ({ page }) => {
  const calls = await mockApi(page);
  await startEngagement(page, 'Edit Co');
  await page.locator('.consent input[type="checkbox"]').check();
  await page.getByRole('button', { name: /Generate SOW/ }).click();
  await page.getByRole('button', { name: /Approve SOW/ }).click();
  await page.getByRole('button', { name: /Continue to Milestones/ }).click();
  await expect(page.locator('.report-highlight')).toContainText('Customer Deep Dive summary');

  await sidebarStep(page, 'Business Intake').click();
  await expect(page.locator('.edit-banner')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  await page.fill('textarea[aria-label="Additional context"]', 'We already have 3 pilot conversations.');
  await page.getByRole('button', { name: 'Save changes' }).click();

  // Back on the milestone: the saved report is still there, flagged as out of date.
  await expect(page.locator('.page-header h1')).toHaveText('Customer Deep Dive');
  await expect(page.locator('.report-highlight')).toContainText('Customer Deep Dive summary');
  await expect(page.getByText(/changed after this report was written/)).toBeVisible();
  expect(calls.filter(c => c.endpoint === 'generate-milestone-report')).toHaveLength(1);

  // Regenerating sends the updated intake.
  await page.getByRole('button', { name: /Regenerate to bring it in line/ }).click();
  await expect(page.getByText(/changed after this report was written/)).toHaveCount(0);
  const regen = calls.filter(c => c.endpoint === 'generate-milestone-report').at(-1);
  expect(regen.body.intake.additional).toBe('We already have 3 pilot conversations.');

  // Save & rebuild scope regenerates the SOW from the edited intake.
  await sidebarStep(page, 'Business Intake').click();
  await page.getByRole('button', { name: /Save & rebuild scope/ }).click();
  await expect(page.locator('.page-header h1')).toHaveText('Scope of Work');
  expect(calls.filter(c => c.endpoint === 'generate-sow').at(-1).body.additional).toBe('We already have 3 pilot conversations.');
});

test('reports open with a whole-report summary; regenerate collects what went wrong and what to add', async ({ page }) => {
  const calls = await mockApi(page);
  await startEngagement(page, 'Summary Co');
  await page.locator('.consent input[type="checkbox"]').check();
  await page.getByRole('button', { name: /Generate SOW/ }).click();
  await page.getByRole('button', { name: /Approve SOW/ }).click();
  await page.getByRole('button', { name: /Continue to Milestones/ }).click();

  await sidebarStep(page, 'Gap Analysis').click();
  await expect(page.locator('.page-header h1')).toHaveText('Gap Analysis');
  await expect(page.locator('.bottom-line')).toContainText('halal traceability');
  await expect(page.locator('.takeaways li')).toHaveCount(2);
  await expect(page.locator('.next-step')).toContainText('Validate with 10 processors.');
  await expect(page.locator('.contents-table tbody tr')).toHaveCount(2);

  await page.getByRole('button', { name: /Regenerate This Milestone/ }).click();
  await expect(page.locator('.regen-card .mic-inline')).toHaveCount(2);
  await page.fill('textarea[aria-label="What went wrong"]', 'Market size looks too high.');
  await page.fill('textarea[aria-label="Improvements or additions"]', 'Add a conservative scenario.');
  await page.getByRole('button', { name: /^🔄 Regenerate$/ }).click();
  await expect(page.getByRole('button', { name: /Regenerate This Milestone/ })).toBeEnabled();
  const notes = calls.filter(c => c.endpoint === 'generate-milestone-report' && c.body.milestoneKey === 'gap').at(-1).body.notes;
  expect(notes).toContain('What was wrong with the previous version: Market size looks too high.');
  expect(notes).toContain('Improvements or additions required: Add a conservative scenario.');

  const [pdf] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Download Full Report/ }).click()]);
  expect((await readDownload(pdf)).subarray(0, 4).toString()).toBe('%PDF');
});

test('the executive brief shows its action roadmap as a visual timeline', async ({ page }) => {
  await mockApi(page);
  await startEngagement(page, 'Brief Co');
  await page.locator('.consent input[type="checkbox"]').check();
  await page.getByRole('button', { name: /Generate SOW/ }).click();
  await page.getByRole('button', { name: /Approve SOW/ }).click();
  await page.getByRole('button', { name: /Continue to Milestones/ }).click();
  await sidebarStep(page, 'Executive Brief').click();
  await expect(page.locator('.page-header h1')).toHaveText('Executive Brief');
  await expect(page.locator('.roadmap-phase')).toHaveCount(3);
  await expect(page.locator('.roadmap-phase').first()).toContainText('0-30 days');
  await expect(page.locator('.roadmap-phase').first().locator('.roadmap-actions li')).toHaveCount(2);
  const [pdf] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Download Full Report/ }).click()]);
  expect((await readDownload(pdf)).subarray(0, 4).toString()).toBe('%PDF');
});

test('every milestone offers Connect to a Strategy Expert, which opens the booking link once configured', async ({ page }) => {
  await mockApi(page);
  await startEngagement(page, 'Expert Co');
  await page.locator('.consent input[type="checkbox"]').check();
  await page.getByRole('button', { name: /Generate SOW/ }).click();
  await page.getByRole('button', { name: /Approve SOW/ }).click();
  await page.getByRole('button', { name: /Continue to Milestones/ }).click();
  for (const name of ['Customer Deep Dive', 'Beachhead Strategy', 'Pitch Deck']) {
    await sidebarStep(page, name).click();
    await expect(page.locator('.page-header h1')).toHaveText(name);
    await expect(page.locator('.expert-card')).toContainText(`Want an expert view on your ${name}?`);
  }
  await page.context().route('https://cal.example.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<p>booking</p>' }));
  const [popup] = await Promise.all([page.waitForEvent('popup'), page.locator('.expert-card .expert-btn').click()]);
  await popup.waitForLoadState();
  expect(popup.url()).toContain('cal.example.com/marketedge');
});

test('without a booking link the expert button says booking opens soon', async ({ page }) => {
  await mockApi(page);
  await page.route('**/api/config', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.goto('/');
  await page.locator('#expert .expert-btn').click();
  await expect(page.locator('#expert .expert-soon')).toContainText('Expert booking opens soon');
});

test('the sidebar and navigation follow the milestones in this business’s SOW', async ({ page }) => {
  const calls = await mockApi(page, {
    'generate-sow': (route, body, json) => json(route, 200, { success: true, sow: {
      engagement_summary: 'A lean, funding-focused scope.',
      milestones: [
        { key: 'competitor', name: 'Competitor Landscape', rationale: 'r' },
        { key: 'financial', name: 'Financial Analysis', rationale: 'r' },
        { key: 'pitch', name: 'Investor Pitch Deck', rationale: 'r' },
      ],
    } }),
  });
  await startEngagement(page, 'Lean Co');
  await page.locator('.consent input[type="checkbox"]').check();
  await page.getByRole('button', { name: /Generate SOW/ }).click();
  await page.getByRole('button', { name: /Approve SOW/ }).click();
  await page.getByRole('button', { name: /Continue to Milestones/ }).click();

  // Exactly the SOW's milestones, in its order and under its names — nothing from the full catalog.
  await expect(page.locator('.sidebar-step .step-label')).toHaveText([
    'Business Intake', 'Scope of Work', 'Market Research',
    'Competitor Landscape', 'Financial Analysis', 'Investor Pitch Deck', 'Strategy Book',
  ]);
  await expect(page.locator('.page-header h1')).toHaveText('Competitor Landscape');
  await expect(page.locator('.page-header-kicker')).toHaveText('Milestone 1 of 3');
  await expect(page.locator('.report-highlight')).toContainText('Competitor Landscape summary');
  expect(calls.find(c => c.endpoint === 'generate-milestone-report').body.milestoneName).toBe('Competitor Landscape');

  await page.getByRole('button', { name: 'Next →' }).click();
  await expect(page.locator('.page-header h1')).toHaveText('Financial Analysis');
  await page.getByRole('button', { name: 'Next →' }).click();
  await expect(page.locator('.page-header h1')).toHaveText('Investor Pitch Deck');
  await expect(page.locator('.report-highlight')).toContainText('Investor Pitch Deck summary');
  await expect(page.getByRole('button', { name: /Complete/ })).toBeVisible();
  // The pitch deck builds on the milestones before it in this engagement.
  const pitch = calls.filter(c => c.endpoint === 'generate-milestone-report' && c.body.milestoneKey === 'pitch').at(-1);
  expect(pitch.body.priorContext.map(p => p.name)).toEqual(['Competitor Landscape', 'Financial Analysis']);

  await page.getByRole('button', { name: /Complete/ }).click();
  await expect(page.locator('.complete-table tr')).toHaveCount(3);
  await expect(page.locator('.page-header-status')).toHaveText('3 of 3 milestones');

  await page.getByRole('button', { name: /All engagements/ }).click();
  await expect(page.locator('.db-card.business-card .db-progress-row')).toContainText('3 / 3');
});
