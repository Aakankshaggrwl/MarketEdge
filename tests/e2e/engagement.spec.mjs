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
  await expect(page.locator('.sidebar-cost')).toContainText('AI cost so far: $0.40');

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
  const modelWb = XLSX.read(await readDownload(modelDl));
  expect(modelWb.SheetNames.at(-1)).toBe('Sources');
  expect(modelWb.Sheets.Assumptions.H5.v).toContain('[S1]');

  // Pitch deck: a real PPTX with native charts.
  await sidebarStep(page, 'Pitch Deck').click();
  const deckButton = page.getByRole('button', { name: /Download Pitch Deck/ });
  await expect(deckButton).toBeVisible();
  const [deckDl] = await Promise.all([page.waitForEvent('download'), deckButton.click()]);
  expect(deckDl.suggestedFilename()).toBe('Test-Co-Pitch-Deck.pptx');
  const zip = await JSZip.loadAsync(await readDownload(deckDl));
  const slides = Object.keys(zip.files).filter(f => /^ppt\/slides\/slide\d+\.xml$/.test(f));
  expect(slides).toHaveLength(16); // 15 planned slides + Sources
  expect(Object.keys(zip.files).filter(f => /^ppt\/charts\/chart\d+\.xml$/.test(f)).length).toBeGreaterThanOrEqual(5);
  const allText = (await Promise.all(slides.map(s => zip.file(s).async('string')))).join(' ');
  expect(allText).toContain('$18.00M'); // Year 5 ARR, drawn from the model
  expect(allText).toContain('GCC Food AI Market Report 2026');

  // Strategy Book + follow-up booking on the completion screen.
  await sidebarStep(page, 'Strategy Book').click();
  await expect(page.getByRole('button', { name: /Book Follow-up Call/ })).toBeVisible();
  await expect(page.locator('.complete-table').last()).toContainText('Market research');
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
  await expect(page.locator('.app-footer a[href="/terms"]')).toBeVisible();
  await page.goto('/privacy');
  await expect(page.locator('h1')).toHaveText('Privacy Policy');
  await expect(page.getByText(/Anthropic's Claude API/)).toBeVisible();
});
