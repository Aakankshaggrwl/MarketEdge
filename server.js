import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { safeParseJSON } from './lib/json.js';
import { parseTextReport, parseKeyValueLines } from './lib/report.js';
import { runClaude, RefusalError } from './lib/claude.js';
import { collectSearchSources, buildResearch, sanitizeResearch, formatFactBase, CITATION_RULES } from './lib/research.js';
import { sanitizeFinancialSummary, formatFinancialSummary, sanitizePriorContext, formatPriorContext } from './lib/context.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
// Milestone requests carry the research fact base and earlier milestones' summaries.
app.use(express.json({ limit: '2mb' }));

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const SENIOR_VOICE = `You are a strategy consultant with 18 years of experience across market entry, growth strategy and fundraising. You write like a senior partner: specific, numeric where possible, decisive, never vague. You never write generic AI filler. Every claim is concrete. You use the client's own facts from their brief wherever possible.`;

const JSON_ONLY = ` Respond with ONLY valid JSON matching the exact structure requested. No markdown, no code fences, no prose before or after the JSON.`;

const MILESTONE_CATALOG = [
  { key: "customer", name: "Customer Analysis", desc: "Who buys, why they buy, and what they pay for" },
  { key: "competitor", name: "Competitor Landscape", desc: "Who you compete with and where they are weak" },
  { key: "gap", name: "Gap & Opportunity Analysis", desc: "Unserved needs your business can own" },
  { key: "beachhead", name: "Beachhead Selection", desc: "The first segment and market to win" },
  { key: "entry", name: "Market Entry Strategy", desc: "How and where to launch, in what sequence" },
  { key: "financial", name: "Financial Analysis", desc: "TAM/SAM/SOM, revenue model, P&L, funding needs" },
  { key: "bizplan", name: "Business Plan", desc: "The complete operating plan, investor-ready" },
  { key: "pitch", name: "Pitch Deck", desc: "The investor narrative, slide by slide" },
  { key: "execbrief", name: "Executive Brief", desc: "The whole strategy on two pages" },
];

// Per-milestone guidance for what the DETAILED_ANALYSIS section must specifically cover.
const MILESTONE_FOCUS = {
  customer: `Cover, at minimum, all of the following as clearly labeled sub-sections:
- Customer Segments: break the market into concrete segments (not generic personas) grounded in the client's brief, with the estimated size/reach of each.
- Approach Per Segment: for each segment, how to reach them, what messaging resonates, and what channel/motion fits their buying behavior.
- Economics Per Segment: expected price point, margin profile, and lifetime value per segment — call out which segments are more profitable and why.
- Psychographic & Sentiment Analysis: the underlying motivations, fears, and emotional drivers behind each segment's buying decision — what pain they are actually trying to escape, not just the functional need.
- Pain Points & Unmet Requirements: the specific frustrations with current alternatives (including doing nothing) that this business can exploit.
- Target Customer Recommendation: a clear, decisive call on which segment(s) to prioritize first and why, ranked by attractiveness.`,
  competitor: `Cover, at minimum, all of the following as clearly labeled "## " sub-sections:
- Competitor-by-Competitor Breakdown: a direct and indirect competitor-by-competitor rundown with each one's positioning, pricing, and target segment. Lead with the verified competitors from the fact base.
- Where Each Competitor Is Strong: what each named competitor structurally does well and why it is hard to attack there.
- Where Each Competitor Is Weak: the specific, structural weaknesses of each named competitor — not surface complaints.
- Gap & Opportunity vs. Competitors: the white space every competitor above is leaving open in this market, stated as concrete, named gaps — then a clear, decisive call on which gap(s) this client is best positioned to own and exactly how to differentiate against the field to own them.`,
  gap: `Cover, at minimum: the specific unserved or underserved needs in this market, evidence for why they are unserved, the size of the opportunity each gap represents, and which gaps this business is best positioned to own given its stated strengths.`,
  beachhead: `Cover, at minimum: 2-3 candidate beachhead segments compared head-to-head on reachability, willingness to pay, competitive intensity, and expansion potential (a markdown comparison table works well here); a decisive recommendation on the single best beachhead; and the specific wedge strategy to win it.`,
  entry: `Cover, at minimum: the recommended entry sequence (channel-by-channel or region-by-region), the rationale for that sequence, go-to-market motion (sales-led, PLG, partnerships, etc.), and the first 90 days of concrete entry actions.`,
  financial: `Cover, at minimum, as "## " sub-sections: "## Market Sizing" (explain how TAM/SAM/SOM were derived, then put the placeholder line [[MARKET_SIZE_TABLE]] on its own line), "## Revenue Model" (pricing, ACV build and customer ramp), "## Five-Year Projections" (put [[FINANCIAL_PROJECTIONS_TABLE]] on its own line, then interpret it), "## Unit Economics" (put [[UNIT_ECONOMICS_TABLE]] on its own line, then interpret it), and "## Funding Needs" (the raise, runway and the milestones it buys). Every number must come from the FINANCIAL MODEL figures provided.`,
  pitch: `Cover, at minimum: a slide-by-slide narrative outline (problem, solution, market, traction, business model, competition, team, financials, ask), with the specific proof points and numbers this client should lead with on each slide — the client also receives a companion PowerPoint deck built from the same figures.`,
  execbrief: `Cover, at minimum: a synthesis of every prior milestone into the 3-5 decisions that matter most, each with its supporting evidence, so a time-constrained reader gets the whole strategy without reading the underlying reports.`,
};

const REPORT_FORMAT_RULES = `Formatting rules for the content inside each section — follow these exactly, they map directly to a renderer that builds proper headings, bullet lists and tables from them:
- Write in full paragraphs of connected prose, 3-6 sentences each. Never leave a heading with no paragraph under it, and never write a bare list with no surrounding prose.
- Start a line with "## " for a named subsection heading — a short Title Case phrase, no numbering and no trailing colon (we add the numbers). Use it to break a long section into its logical parts, e.g. "## Customer Segments".
- Start a line with "### " for a short, numbered talking-point heading within a subsection — a short Title Case phrase, no numbering (we add the numbers). Use it for enumerable items like findings, recommendations, risks, or KPIs, immediately followed by an explanatory paragraph.
- Start a line with "- " for a bullet point. When a bullet states a discrete fact, lead with a short bold label using **Label:** followed by the explanation, e.g. "- **Target Segment:** mid-market retailers with 10-50 locations, most price-sensitive on logistics cost."
- Use a markdown table (header row, then a "| --- |" separator row, then data rows; at most 6 columns, short cell text) only where the content is genuinely tabular, e.g. a comparison or a timeline. Always introduce a table with a sentence.
- Lines of the form [[SOMETHING_TABLE]] or [[FIVE_YEAR_SNAPSHOT]] are placeholders the system replaces with tables computed from the financial model. Include each one exactly once where the instructions ask for it, alone on its own line, and never write that table yourself.
- Use **bold** only around a genuinely load-bearing term, number, or name inside a sentence — never bold a whole sentence.
- Never use single "#" headings or numbered markers you write yourself like "1." or "a)".
- Leave a blank line between every heading, paragraph, bullet group and table.`;

const REPORT_SYSTEM = SENIOR_VOICE + ` Respond with ONLY the formatted text report. No JSON. Use ---SECTION--- as separators between the sections listed in the prompt. Be comprehensive and detailed — this report should be long and substantive, not a summary.\n\n${REPORT_FORMAT_RULES}\n\n${CITATION_RULES}`;

const STANDARD_SECTIONS = (milestoneName, focus) => `TITLE: ${milestoneName}
---SECTION---
EXECUTIVE_SUMMARY: [700-1000 words — hard cap, do not exceed 1000 words, content beyond that will be cut off. This must stand alone as a complete summary of the whole report — it is what the client reads on-screen before ever opening the full document, so it needs to carry the real substance, not just tease it. Cover: the headline conclusions and why they matter to this client specifically; the 3-4 most important findings from the analysis; and the top decisive recommendation(s). Use "## " subsections to organize it (e.g. "## Headline Conclusions", "## Key Findings At A Glance", "## Top Recommendation") rather than one long block of prose.]
---SECTION---
MARKET_CONTEXT: [600-800 words. The landscape this client is operating in, grounded in their industry, stage, and target market. Use 2-3 "## " subsections for the distinct parts of the landscape (e.g. market size, dynamics, timing), each opened with a paragraph and, where there are concrete figures worth calling out, followed by "- **Label:** ..." bullets.]
---SECTION---
KEY_FINDINGS: [800-1000 words. Structure as 5-7 "### " headed findings, each followed by a full paragraph with supporting reasoning — never a one-line bullet standing alone.]
---SECTION---
DETAILED_ANALYSIS: [1800-2400 words. The core analytical work for this milestone. ${focus} Use a "## " subsection for each required topic above, each opened with a paragraph and, where the topic is naturally enumerable (segments, competitors, etc.), followed by "- **Label:** ..." bullets.]
---SECTION---
RECOMMENDATIONS: [1000-1200 words. Structure as 8-10 "### " headed recommendations, each followed by a paragraph covering the rationale, expected impact, and concrete next step.]
---SECTION---
IMPLEMENTATION_ROADMAP: [600-800 words. Use "## " subsections for sequenced phases (e.g. "Phase 1: 0-30 Days"), each opened with a paragraph and followed by "- " bullets for the concrete actions in that phase.]
---SECTION---
RISKS_AND_MITIGATIONS: [600-800 words. Structure as 4-6 "### " headed risks, each followed by a paragraph covering the risk and its mitigation.]
---SECTION---
METRICS: [400-500 words. Structure as 5-7 "### " headed KPIs, each followed by a short paragraph giving the target range and why it matters.]`;

// Mirrors the structure of an investor-grade business plan: a cover sheet of headline
// metrics, then 13 numbered sections with tables where the content is tabular. Financial
// tables are injected client-side from the model via the [[...]] placeholders so the plan
// can never disagree with the Excel workbook.
const BUSINESS_PLAN_SECTIONS = (businessName) => `TITLE: ${businessName ? `${businessName} — ` : ''}Business Plan
---SECTION---
COVER: [Exactly these eight lines, each "Label: value", value under 90 characters, no other text:
Company: the client's business name${businessName ? ` ("${businessName}")` : ''}
Offering: what they sell, in one line
Target Market: the beachhead market and geography
Stage: current stage and what is in progress now
Launch Timing: when the launch/pilot happens
Funding Ask: the recommended raise from the financial model
Year 5 Revenue: Year 5 ARR and paying clients from the financial model
EBITDA Break-even: the break-even year from the financial model]
---SECTION---
EXECUTIVE_SUMMARY: [700-1000 words — hard cap. The complete case in miniature: the problem, the solution, the market, the business model, the go-to-market, the financial trajectory and the ask. Prose paragraphs, no subsections. End with the placeholder line [[FIVE_YEAR_SNAPSHOT]] on its own line.]
---SECTION---
THE_PROBLEM: [500-700 words. Two or three "## " subsections, e.g. the specific failures customers live with today, what they cost, and why existing solutions do not solve them.]
---SECTION---
MARKET_OPPORTUNITY: [600-800 words. "## Market Size" — explain the sizing basis with citations, then put [[MARKET_SIZE_TABLE]] on its own line. "## Target Segments" — a markdown table with columns: # | Segment | Size / Count | ACV Range | Entry Timing, introduced and interpreted in prose. "## Why Now" — the forcing functions.]
---SECTION---
THE_PRODUCT: [600-800 words. "## " subsections for the core offering, the entry product/hook, how it works for the customer, and what is deliberately out of scope.]
---SECTION---
COMPETITIVE_LANDSCAPE: [600-800 words. Open with the structure of the field, then a markdown table with columns: Competitor | Positioning | Pricing | Weakness We Exploit — verified competitors first, with [S#] citations in the prose. Close with "## Our Differentiation".]
---SECTION---
BUSINESS_MODEL: [500-700 words. "## Revenue Model", "## Pricing" (a markdown pricing table consistent with the financial model's ACV), "## Key Business Model Metrics" (bullets: ACV, gross margin, churn, CAC payback, LTV:CAC — from the financial model).]
---SECTION---
GO_TO_MARKET_STRATEGY: [600-800 words. "## " subsections for the entry mechanism, acquisition channels, sales motion, and the first-year customer acquisition plan.]
---SECTION---
OPERATIONS_PLAN: [500-700 words. "## Team & Hiring Plan" (consistent with the model's headcount by year), "## Key Partners & Vendors", "## Compliance & Operating Controls" where relevant.]
---SECTION---
FINANCIAL_PLAN: [500-700 words. "## Five-Year Financial Projections" — put [[FINANCIAL_PROJECTIONS_TABLE]] on its own line, then interpret the trajectory. "## Unit Economics" — put [[UNIT_ECONOMICS_TABLE]] on its own line, then interpret. "## Break-Even Analysis" — when and why, plus one sensitivity. "## Key Assumptions" — "- " bullets.]
---SECTION---
FUNDING_REQUIREMENTS: [400-600 words. The raise (from the financial model), a markdown "use of funds" table (Category | Share | What It Buys), runway, and the milestones that trigger the next round.]
---SECTION---
KEY_MILESTONES: [400-600 words. A markdown table with columns: Timing | Milestone | Success Measure, covering the next 24-36 months, introduced and interpreted in prose.]
---SECTION---
RISK_ANALYSIS: [500-700 words. A markdown table with columns: Risk | Likelihood | Impact | Mitigation (5-7 rows), followed by prose on the two risks that matter most.]
---SECTION---
STRATEGIC_DECISIONS: [300-500 words. The 3-5 decisions leadership must make now, each as a "### " heading followed by a paragraph.]`;

function notesBlock(notes) {
  return typeof notes === 'string' && notes.trim()
    ? `\n\nThe client asked for this regenerated with the following changes — apply them throughout, overriding anything above they conflict with: ${notes.trim().slice(0, 2000)}`
    : '';
}

function briefLine(intake, businessName) {
  return `${businessName ? `Business name: ${businessName}. ` : ''}Client brief: ${intake.brief}. Industry: ${intake.industry}. Stage: ${intake.stage}. Market: ${intake.market}. Goal: ${intake.goal}.`;
}

// The first block (client + scope + verified fact base) is identical for every milestone of
// an engagement, so it is marked cacheable: later milestones re-read it at the cache rate.
// Everything that varies per request goes in the second block.
function contextBlocks({ intake, sow, businessName, research, prior, financial }, instructions) {
  const shared = `CLIENT: ${briefLine(intake, businessName)}\nSCOPE: ${sow.engagement_summary}\n\n${formatFactBase(research)}`;
  const variable = [formatPriorContext(prior), financial ? formatFinancialSummary(financial) : '', instructions]
    .filter(Boolean)
    .join('\n\n');
  return [
    { type: 'text', text: shared, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: variable },
  ];
}

function readContext(body) {
  return {
    intake: body.intake,
    sow: body.sow,
    businessName: typeof body.businessName === 'string' ? body.businessName.trim().slice(0, 120) : '',
    research: sanitizeResearch(body.research),
    prior: sanitizePriorContext(body.priorContext),
    financial: sanitizeFinancialSummary(body.financialSummary),
  };
}

function sendError(res, err, fallback) {
  console.error(`${fallback}:`, err?.message);
  if (err instanceof RefusalError) return res.status(422).json({ error: err.message });
  if (err instanceof Anthropic.RateLimitError) return res.status(429).json({ error: 'The AI service is busy right now. Wait a minute and try again.' });
  if (err instanceof Anthropic.APIError && err.status) {
    return res.status(err.status >= 500 ? 502 : err.status).json({ error: err.message || fallback });
  }
  res.status(500).json({ error: err?.message || fallback });
}

// CORS headers
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  next();
});

app.options('*', (req, res) => res.sendStatus(200));

app.get('/api/config', (req, res) => {
  res.json({
    bookingUrl: process.env.BOOKING_URL || '',
    sentryDsn: process.env.SENTRY_DSN || '',
  });
});

// Browser errors land here so they show up in the server/Vercel logs. Throttled per
// instance so a render loop can't flood the logs.
let errorLogWindowStart = 0;
let errorLogCount = 0;
app.post('/api/log-error', (req, res) => {
  const now = Date.now();
  if (now - errorLogWindowStart > 60_000) { errorLogWindowStart = now; errorLogCount = 0; }
  if (++errorLogCount > 30) return res.status(429).end();
  const b = req.body || {};
  const clip = (v, n) => (typeof v === 'string' ? v.slice(0, n) : undefined);
  console.error('[client-error]', JSON.stringify({
    kind: clip(b.kind, 40), message: clip(b.message, 1000), stack: clip(b.stack, 4000),
    context: clip(b.context, 500), url: clip(b.url, 300), userAgent: clip(req.headers['user-agent'], 300),
    at: new Date().toISOString(),
  }));
  res.status(204).end();
});

// Generate SOW (initial)
app.post('/api/generate-sow', async (req, res) => {
  try {
    const { brief, industry, stage, market, goal } = req.body;

    if (!brief?.trim() || !industry || !stage || !market || !goal) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const catalog = MILESTONE_CATALOG.map(m => `${m.key}: ${m.name} — ${m.desc}`).join("\n");

    const prompt = `A client filled our discovery intake. Design their engagement scope.

CLIENT BRIEF (their own words): "${brief}"
Industry: ${industry} | Stage: ${stage} | Target market: ${market} | Primary goal: ${goal}

Available milestones:
${catalog}

Select 4–9 milestones that this specific client needs, in the right order (analysis before strategy before documents). Anchor every rationale in facts from THEIR brief — quote their numbers and constraints. For each milestone's rationale, write 5-6 sentences that clearly explain: what this milestone will actually cover, the specific questions it will answer for THIS client, and why it matters given their brief — not a generic description of the milestone type. Respond ONLY with valid JSON (no markdown, no fences):
{"engagement_summary": "3-4 sentences describing this engagement in specific terms drawn from their brief","milestones": [{"key":"customer","name":"Customer Analysis","rationale":"5-6 sentences: what this milestone covers for THIS client, the specific questions it answers, and why it matters given their brief"}]}`;

    const result = await runClaude(client, {
      maxTokens: 4000,
      system: SENIOR_VOICE + JSON_ONLY,
      messages: [{ role: "user", content: prompt }],
    });

    if (!result.text.trim()) {
      return res.status(500).json({ error: "Empty response from Claude" });
    }

    const sow = safeParseJSON(result.text);

    if (!sow?.milestones || !Array.isArray(sow.milestones) || sow.milestones.length === 0) {
      return res.status(500).json({ error: "Invalid SOW structure: missing or empty milestones" });
    }

    res.status(200).json({ success: true, sow, usage: result.usage });
  } catch (err) {
    sendError(res, err, "Failed to generate SOW");
  }
});

// Unified SOW Management - handles questions and revisions
app.post('/api/sow-interaction', async (req, res) => {
  try {
    const { userMessage, sow, intake, interactionType } = req.body;

    if (!userMessage?.trim() || !sow || !intake) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const milestonesStr = sow.milestones.map(m => `- ${m.name}: ${m.rationale}`).join("\n");

    let prompt, responseType;

    if (interactionType === "question") {
      responseType = "answer";
      prompt = `You have designed this scope of work for a client, and they are now asking you a follow-up question directly, in conversation. Answer as the consultant who wrote this scope — specific, warm, and direct, the way you'd actually reply to a client on a call.

Client: ${briefLine(intake)}

Scope summary: ${sow.engagement_summary}

Milestones in this engagement:
${milestonesStr}

Client question: "${userMessage}"

Write a natural, conversational answer, 3-5 sentences. Ground it in the specifics of THIS client's brief and THIS scope — reference their actual business details, not generic advice. If the question is about something a specific milestone covers, name that milestone and briefly say what it will show them. If the question is about something genuinely not covered by any milestone, say so plainly and suggest how it could be added. Never answer with a generic non-answer — if you're not sure, make your best specific judgment call rather than deflecting.`;
    } else if (interactionType === "revision") {
      responseType = "revised_sow";
      prompt = `A client filled our discovery intake. Current scope of work:

Summary: ${sow.engagement_summary}

Current milestones:
${milestonesStr}

Client feedback/request: "${userMessage}"

Make the requested changes. Keep every unchanged milestone's rationale exactly as it was. For any milestone that is new or whose scope changed, write a 5-6 sentence rationale covering what it will cover for this client, the specific questions it answers, and why it matters given their brief. Return ONLY valid JSON (no markdown, no explanation):
{"engagement_summary": "updated summary if changed, otherwise keep original","milestones": [{"key":"...","name":"...","rationale":"5-6 sentences, see above"}],"changes_made": "Clear summary of changes: what was added, removed, or modified. Be specific."}`;
    } else {
      return res.status(400).json({ error: "Invalid interaction type" });
    }

    const system = responseType === "answer"
      ? SENIOR_VOICE + ` Respond with a concise plain-text answer only — no JSON, no markdown, no section headers.`
      : SENIOR_VOICE + JSON_ONLY;

    const result = await runClaude(client, {
      maxTokens: 4000,
      system,
      messages: [{ role: "user", content: prompt }],
    });

    if (!result.text) {
      return res.status(500).json({ error: "Empty response from Claude" });
    }

    if (responseType === "answer") {
      res.status(200).json({ success: true, type: "answer", response: result.text, usage: result.usage });
    } else {
      let revisedData;
      try {
        revisedData = safeParseJSON(result.text.replace(/\r?\n/g, " "));
      } catch (parseErr) {
        return res.status(500).json({ error: `Failed to parse revisions: ${parseErr.message}` });
      }

      res.status(200).json({ success: true, type: "revision", sow: revisedData, usage: result.usage });
    }
  } catch (err) {
    sendError(res, err, "Failed to process request");
  }
});

// Live market research, run once per engagement. The model searches the web and returns
// a fact base; every fact and competitor is kept only if its source URL was actually
// returned by the search tool in this response.
app.post('/api/research', async (req, res) => {
  try {
    const { sow, intake } = req.body;
    if (!sow || !intake) {
      return res.status(400).json({ error: "Missing required fields" });
    }
    const businessName = typeof req.body.businessName === 'string' ? req.body.businessName.trim().slice(0, 120) : '';

    const webSearch = { type: 'web_search_20260209', name: 'web_search', max_uses: 10 };

    const prompt = `Research this client's market with web search before any strategy work begins. The facts you find become the verified fact base for every report in the engagement, so accuracy matters more than volume.

CLIENT: ${briefLine(intake, businessName)}
SCOPE: ${sow.engagement_summary}

Run focused searches (around 6-10) covering:
1. Market size and growth for this client's specific market, segment and geography (prefer research firms, industry bodies, government statistics).
2. The leading direct and indirect competitors: who they are, what they charge, how they are funded.
3. Business-model benchmarks for this industry: typical pricing, gross margin, churn/retention, CAC or sales-cycle norms.
4. Regulation, policy or structural trends driving or blocking demand.

When you are done, respond with ONLY this JSON (no prose before or after it):
{"marketSummary": "3-4 sentences summarizing what the research shows about this market",
 "facts": [{"category": "market_size | growth | pricing | benchmark | regulation | customer | trend", "claim": "one specific sentence with the figure, unit, geography and year", "source_url": "the exact URL of the search result this came from", "published": "year or date if shown, else empty"}],
 "competitors": [{"name": "Company", "website": "domain", "description": "one sentence on what they do and for whom", "pricing": "what they charge if found, else 'Not disclosed'", "funding": "funding/ownership if found, else 'Not disclosed'", "source_url": "the exact URL of the search result describing them"}],
 "gaps": ["important things you searched for but could not verify"]}

Rules:
- Every source_url must be copied exactly from a search result you received. Never invent or guess a URL.
- Include only facts you actually found in a search result — no figures from memory.
- Aim for 12-25 facts and 5-12 competitors; fewer is fine if the evidence is thin — say what's missing in "gaps".`;

    const result = await runClaude(client, {
      maxTokens: 16000,
      system: SENIOR_VOICE + ` You are doing the desk research phase of an engagement: use the web_search tool, then report only what the sources support. Your final answer must be ONLY valid JSON matching the requested structure — no markdown, no code fences, no prose after the JSON.`,
      messages: [{ role: 'user', content: prompt }],
      tools: [webSearch],
    });

    const raw = safeParseJSON(result.text);
    const sourceMap = collectSearchSources(result.content);
    const research = buildResearch(raw, sourceMap, { searchCount: result.usage.webSearches });

    if (research.sources.length === 0) {
      return res.status(502).json({ error: "Web research didn't return any verifiable sources. Try again, or continue without research (figures will be marked as estimates).", usage: result.usage });
    }

    console.log(`🔎 Research: ${research.facts.length} facts, ${research.competitors.length} competitors, ${research.sources.length} sources, ${research.droppedUnverified} unverified items dropped`);
    res.status(200).json({ success: true, research, usage: result.usage });
  } catch (err) {
    sendError(res, err, "Failed to research the market");
  }
});

// Generate comprehensive milestone report
app.post('/api/generate-milestone-report', async (req, res) => {
  try {
    const { milestoneKey, milestoneName, sow, intake, notes } = req.body;

    console.log("📋 Report request:", { milestoneKey, milestoneName, hasNotes: !!notes });

    if (!milestoneKey || !milestoneName || !sow || !intake) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const ctx = readContext(req.body);
    const isBizPlan = milestoneKey === 'bizplan';
    const focus = MILESTONE_FOCUS[milestoneKey] || `Cover the core analytical work this milestone promises, in full depth, organized into clearly labeled sub-sections.`;

    const sections = isBizPlan ? BUSINESS_PLAN_SECTIONS(ctx.businessName) : STANDARD_SECTIONS(milestoneName, focus);
    const lengthTarget = isBizPlan
      ? `This is the client's investor-ready business plan — it should read like a 20-25 page plan an experienced founder would hand to a seed investor. Together the sections should total roughly 7,000-9,000 words.`
      : `It should read like a 15-20 page strategy document, not a summary. Together the sections should total roughly 7,500-10,000 words.`;

    const instructions = `TASK: Generate a comprehensive, in-depth report for "${milestoneName}". This is a deliverable the client is paying for. ${lengthTarget} Write in full paragraphs, be specific and numeric wherever the facts support it, and never pad with generic filler to hit length — every paragraph must carry real analysis.${notesBlock(notes)}

Respond with ONLY these sections separated by ---SECTION---. Follow the target length for each section. Structure each section using the "##", "###", "-", table and "**bold**" conventions from your system instructions wherever they help a senior reader scan the section quickly:

${sections}`;

    const result = await runClaude(client, {
      maxTokens: isBizPlan ? 20000 : 16000,
      system: REPORT_SYSTEM,
      messages: [{ role: "user", content: contextBlocks(ctx, instructions) }],
    });

    if (!result.text || result.text.trim().length < 10) {
      return res.status(500).json({ error: "Empty response from Claude" });
    }

    const report = parseTextReport(result.text, milestoneName);

    if (isBizPlan) {
      const coverIdx = report.sections.findIndex(s => s.heading === 'Cover');
      if (coverIdx !== -1) {
        report.cover = parseKeyValueLines(report.sections[coverIdx].content);
        report.sections.splice(coverIdx, 1);
      }
      report.style = 'bizplan';
    }

    console.log("✅ Report parsed successfully. Sections:", report.sections.length, "Cost: $" + result.usage.usd);
    res.status(200).json({ success: true, report, usage: result.usage });
  } catch (err) {
    sendError(res, err, "Failed to generate report");
  }
});

// The category-grouped column set for the competitor comparison matrix (Excel export).
// Generic across industries — mirrors the shape of a real analyst comparison sheet
// (company profile, financials, product/positioning, go-to-market, gap vs. this client).
const COMPETITOR_MATRIX_COLUMNS = [
  { key: "overview", label: "Overview", category: "Company Profile" },
  { key: "location", label: "Headquarters / Region", category: "Company Profile" },
  { key: "stage", label: "Stage / Founded", category: "Company Profile" },
  { key: "revenue", label: "Estimated Revenue", category: "Financials" },
  { key: "funding", label: "Total Funding Raised", category: "Financials" },
  { key: "pricing_model", label: "Pricing Model", category: "Financials" },
  { key: "price_point", label: "Price Point", category: "Financials" },
  { key: "market_share", label: "Est. Market Share", category: "Financials" },
  { key: "core_offering", label: "Core Offering", category: "Product & Positioning" },
  { key: "key_strengths", label: "Key Strengths", category: "Product & Positioning" },
  { key: "key_weaknesses", label: "Key Weaknesses", category: "Product & Positioning" },
  { key: "target_segment", label: "Target Customer Segment", category: "Product & Positioning" },
  { key: "gtm_channels", label: "Primary GTM Channels", category: "Go-To-Market" },
  { key: "marketing_angle", label: "Marketing Angle", category: "Go-To-Market" },
  { key: "growth_plan", label: "Stated Growth Plan", category: "Go-To-Market" },
  { key: "where_strong", label: "Where They Are Strong vs. Us", category: "Competitive Gap" },
  { key: "where_weak", label: "Where They Are Weak vs. Us", category: "Competitive Gap" },
  { key: "differentiation", label: "Our Differentiation Opportunity", category: "Competitive Gap" },
];

// Generate the competitor comparison matrix (structured JSON, rendered client-side as an
// Excel download). Only used for the Competitor Landscape milestone.
app.post('/api/generate-competitor-matrix', async (req, res) => {
  try {
    const { sow, intake, notes } = req.body;

    if (!sow || !intake) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const ctx = readContext(req.body);
    const columnSpecJSON = JSON.stringify(COMPETITOR_MATRIX_COLUMNS);

    const instructions = `TASK: Build a competitor comparison matrix for this client.${notesBlock(notes)}

Start from the VERIFIED COMPETITORS in the fact base — include every one that is relevant. You may add other direct or indirect competitors only if you are certain they are real companies; never invent names. Include as many as are genuinely relevant, up to a maximum of 15 — prioritize relevance over hitting exactly 15.

For every competitor, fill in a concise, specific value (1-2 sentences, never empty — write "Not disclosed" if a figure is genuinely unavailable) for each of these columns:
${columnSpecJSON}
Where a value comes from the fact base, end it with the [S#] citation. Any figure that does not come from the fact base must be marked "(est.)".

Set "source_id" to the [S#] id (e.g. "S4", without brackets) that verifies the competitor if it is in the verified list, otherwise "".

Respond with ONLY valid JSON (no markdown, no fences):
{"competitors": [{"name": "Company Name", "source_id": "S4", "values": {"overview": "...", "location": "...", "stage": "...", "revenue": "...", "funding": "...", "pricing_model": "...", "price_point": "...", "market_share": "...", "core_offering": "...", "key_strengths": "...", "key_weaknesses": "...", "target_segment": "...", "gtm_channels": "...", "marketing_angle": "...", "growth_plan": "...", "where_strong": "...", "where_weak": "...", "differentiation": "..."}}]}`;

    const result = await runClaude(client, {
      // 15 competitors x 18 fields easily runs past 8000 tokens of JSON.
      maxTokens: 16000,
      system: SENIOR_VOICE + JSON_ONLY + ` Every competitor object must include a value for every column key listed — never omit a key.\n\n${CITATION_RULES}`,
      messages: [{ role: "user", content: contextBlocks(ctx, instructions) }],
    });

    if (!result.text) {
      return res.status(500).json({ error: "Empty response from Claude" });
    }

    const matrix = safeParseJSON(result.text);

    if (!matrix?.competitors || !Array.isArray(matrix.competitors)) {
      return res.status(500).json({ error: "Invalid competitor matrix: missing competitors" });
    }

    // Drop any incomplete trailing entry a truncation repair may have left behind.
    matrix.columns = COMPETITOR_MATRIX_COLUMNS;
    const sourcesById = new Map((ctx.research?.sources || []).map(s => [s.id, s]));
    matrix.competitors = matrix.competitors
      .filter(c => c && c.name && c.values)
      .slice(0, 15)
      .map(c => {
        const src = sourcesById.get(String(c.source_id || '').replace(/[[\]]/g, ''));
        return { name: c.name, values: c.values, source: src ? { id: src.id, url: src.url, title: src.title } : null };
      });

    if (matrix.competitors.length === 0) {
      return res.status(500).json({ error: "Invalid competitor matrix: missing or empty competitors" });
    }
    delete matrix.source_id;

    res.status(200).json({ success: true, matrix, usage: result.usage });
  } catch (err) {
    sendError(res, err, "Failed to generate competitor matrix");
  }
});

// Generate the financial model as raw ASSUMPTIONS (structured JSON) — not pre-computed
// figures. The client builds a fully formula-linked, multi-sheet Excel workbook from
// these inputs, so a reviewer can change one assumption cell and watch the whole model
// recalculate — the same design as a hand-built 5-year operating model.
app.post('/api/generate-financial-model', async (req, res) => {
  try {
    const { sow, intake, notes } = req.body;

    if (!sow || !intake) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const ctx = readContext(req.body);

    const instructions = `TASK: You are a financial analyst with 15+ years of experience building operating models for growth-stage companies. Build the complete set of ASSUMPTIONS behind a 5-year financial model for this client — not the computed outputs, the raw inputs a real model would be built from. Every figure must be a specific, defensible, industry-grounded estimate — never a placeholder, never "$X" or "TBD". Anchor market sizes, growth rates, pricing and benchmarks to the VERIFIED FACT BASE wherever it has them, and keep segments, pricing and the beachhead consistent with the earlier milestones. Where a number could look arbitrary, the accompanying note must say how you derived it — cite [S#] when it comes from the fact base, otherwise name the benchmark and add "(est.)".${notesBlock(notes)}

Respond with ONLY valid JSON (no markdown, no fences) matching this exact structure. All money figures are plain numbers in USD (no currency symbols, no commas, no strings like "$1.2M" — write 1200000). All percentages are decimals (12% -> 0.12). Keep every "note"/"rationale" field to one short sentence — this is a dense data table, not a report.

{
  "years": ["Year 1", "Year 2", "Year 3", "Year 4", "Year 5"],
  "market": {
    "primaryMarketName": "short name for this client's core addressable market",
    "primaryMarketSizeUSDM_Y1": number,
    "primaryMarketCAGR": number,
    "globalMarketName": "short name for the broader global category this sits in",
    "globalMarketSizeUSDM_Y1": number,
    "globalMarketCAGR": number,
    "sourceNote": "one sentence on where the market size and CAGR come from, citing [S#] or marked (est.)"
  },
  "segmentFilters": [
    {"label": "a filter narrowing global/primary market down to what this client can actually serve, e.g. 'Target segment share of market'", "percent": number, "rationale": "..."}
  ],
  "samPremium": {"label": "name of any unserved-gap premium to add on top of the filtered SAM, or 'None' if not applicable", "amountUSDM": number, "rationale": "..."},
  "pricingTiers": [
    {"name": "tier or module name", "monthlyPriceUSD": number, "rationale": "..."}
  ],
  "blendedACVByYear": [number, number, number, number, number],
  "clientTargetsByYear": [number, number, number, number, number],
  "churnRate": number,
  "nrr": number,
  "grossMargin": number,
  "segments": [
    {"name": "customer segment name", "clientsByYear": [number, number, number, number, number], "entryACV": number, "fullSuiteACV": number, "icpNote": "..."}
  ],
  "geographies": [
    {"name": "expansion market/country name", "region": "region name", "tamPctOfGlobal": number, "cagr": number, "accessiblePct": number, "regulatoryPremiumUSDM": number, "entryTiming": "e.g. Q3 2027", "clientsByYear": [number, number, number, number, number], "acvByYear": [number, number, number, number, number], "regulatoryDriver": "the specific regulation/forcing-function driving demand here, or market dynamic if no regulation applies"}
  ],
  "salaryRoster": [
    {"role": "job title", "headcountByYear": [number, number, number, number, number], "monthlySalaryY1USD": number, "annualEscalationPct": number, "contractType": "Full Time or Part Time or Outsourced", "notes": "..."}
  ],
  "expenseCategories": [
    {
      "category": "expense category name, e.g. 'Workspace & Facilities'",
      "lineItems": [
        {"description": "specific line item", "driverType": "flat or escalating or perHeadcount or perNewHire", "y1AnnualUSD": number, "escalationPct": number, "ratePerHead": number, "notes": "..."}
      ]
    }
  ],
  "funding": {
    "revenueMultiple": number,
    "equityPctForRaise": number,
    "minimumRaiseUSD": number,
    "cacByYear": [number, number, number, number, number],
    "ltvHorizonYears": number
  }
}

Sizing guidance:
- segmentFilters: 2-4 filters that multiply together into the combined SAM filter.
- pricingTiers: 2-5 tiers/modules that plausibly compose the blended ACV figures below.
- segments: 4-6 real customer segments for this client's actual industry.
- geographies: 3-5 realistic expansion markets/countries beyond the primary market, each with its own regulatory or market driver — even a locally-focused business should have a credible expansion path.
- salaryRoster: 12-18 roles appropriate to this client's stage and industry, with headcount by year reflecting realistic team growth (e.g. lean Year 1, scaling after each funding milestone). driverType "perHeadcount" means ratePerHead x cumulative headcount that year; "perNewHire" means ratePerHead x net new hires that year (one-time costs like equipment); "escalating" means y1AnnualUSD growing by escalationPct each year; "flat" means the same y1AnnualUSD every year.
- expenseCategories: 8-12 categories (e.g. Workspace & Facilities, Technology & Cloud Infrastructure, Software & SaaS Subscriptions, Hardware & Equipment, Travel, Legal & Compliance, Finance & Accounting, HR & Recruitment, Marketing & Events, Insurance, Contingency), each with 2-4 concrete line items grounded in this client's industry and market — not generic placeholders.
- funding: revenueMultiple and equityPctForRaise should reflect what's typical for this client's industry and stage; cacByYear should decline as the brand matures.`;

    const result = await runClaude(client, {
      maxTokens: 16000,
      system: SENIOR_VOICE + JSON_ONLY + ` Every numeric field must be a real number, not a string, and not zero unless the assumption genuinely is zero (e.g. a market entered in a later year).`,
      messages: [{ role: "user", content: contextBlocks({ ...ctx, financial: null }, instructions) }],
    });

    if (!result.text) {
      return res.status(500).json({ error: "Empty response from Claude" });
    }

    const model = safeParseJSON(result.text);

    // Drop any incomplete trailing entry a truncation repair may have left behind, and
    // normalize arrays that might be missing entirely so the Excel builder never crashes.
    const arr = (v) => Array.isArray(v) ? v : [];
    model.segmentFilters = arr(model.segmentFilters).filter(r => r && r.label);
    model.pricingTiers = arr(model.pricingTiers).filter(r => r && r.name);
    model.segments = arr(model.segments).filter(r => r && r.name && Array.isArray(r.clientsByYear));
    model.geographies = arr(model.geographies).filter(r => r && r.name && Array.isArray(r.clientsByYear));
    model.salaryRoster = arr(model.salaryRoster).filter(r => r && r.role && Array.isArray(r.headcountByYear));
    model.expenseCategories = arr(model.expenseCategories)
      .filter(c => c && c.category)
      .map(c => ({ ...c, lineItems: arr(c.lineItems).filter(li => li && li.description) }))
      .filter(c => c.lineItems.length > 0);

    if (model.salaryRoster.length === 0 || model.expenseCategories.length === 0) {
      return res.status(500).json({ error: "Invalid financial model: missing salary roster or expense categories" });
    }

    res.status(200).json({ success: true, model, usage: result.usage });
  } catch (err) {
    sendError(res, err, "Failed to generate financial model");
  }
});

const DECK_SLIDE_TYPES = new Set(['title', 'section', 'cards', 'bigNumbers', 'bullets', 'table', 'chart', 'unitEconomics', 'marketSize', 'ask', 'closing']);
const DECK_CHARTS = new Set(['arr', 'pnl', 'cash', 'headcount']);

function sanitizeDeck(raw) {
  const s = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
  const list = (v, n) => (Array.isArray(v) ? v.slice(0, n) : []);
  const slides = list(raw?.slides, 24).map(sl => {
    if (!sl || !DECK_SLIDE_TYPES.has(sl.type)) return null;
    const out = { type: sl.type, title: s(sl.title, 110) };
    switch (sl.type) {
      case 'title': out.subtitle = s(sl.subtitle, 160); break;
      case 'section': out.number = s(sl.number, 4); break;
      case 'cards': out.cards = list(sl.cards, 4).map(c => ({ label: s(c?.label, 40), text: s(c?.text, 260) })).filter(c => c.label && c.text); break;
      case 'bigNumbers':
        out.stats = list(sl.stats, 4).map(st => ({ value: s(st?.value, 14), label: s(st?.label, 90) })).filter(st => st.value);
        out.note = s(sl.note, 260);
        break;
      case 'bullets':
        out.bullets = list(sl.bullets, 6).map(b => s(b, 180)).filter(Boolean);
        out.callout = s(sl.callout, 200);
        break;
      case 'table':
        out.columns = list(sl.columns, 5).map(c => s(c, 30));
        out.rows = list(sl.rows, 7).map(r => list(r, out.columns.length).map(c => s(String(c ?? ''), 70)));
        break;
      case 'chart': out.chart = DECK_CHARTS.has(sl.chart) ? sl.chart : 'arr'; out.takeaway = s(sl.takeaway, 200); break;
      case 'unitEconomics': case 'marketSize': out.takeaway = s(sl.takeaway, 200); break;
      case 'ask':
        out.useOfFunds = list(sl.useOfFunds, 6).map(u => ({ label: s(u?.label, 50), pct: Math.max(0, Math.min(100, Number(u?.pct) || 0)) })).filter(u => u.label);
        out.milestones = list(sl.milestones, 5).map(m => s(m, 140)).filter(Boolean);
        break;
      case 'closing': out.points = list(sl.points, 6).map(p => s(p, 180)).filter(Boolean); break;
    }
    return out;
  }).filter(Boolean);
  return { companyName: s(raw?.companyName, 60), tagline: s(raw?.tagline, 90), slides };
}

// Generate the pitch deck as a typed slide plan; the browser renders it to PPTX. Financial
// slides carry no numbers from the model's text — they are drawn from the financial model.
app.post('/api/generate-pitch-deck', async (req, res) => {
  try {
    const { sow, intake, notes } = req.body;
    if (!sow || !intake) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const ctx = readContext(req.body);

    const instructions = `TASK: Write the content for this client's investor pitch deck (16:9, 15-20 slides), in the style of a sharp strategy-firm deck: every slide title is a conclusion, not a topic (e.g. "Competitor Landscape: 17 Players, One Massive Gap"), and every slide carries specific numbers and names.${notesBlock(notes)}

Respond with ONLY JSON (no markdown):
{"companyName": "the client's business name (short)", "tagline": "what they are, in under 8 words",
 "slides": [ ...slide objects... ]}

Slide object types — use only these:
- {"type": "title", "title": "company name", "subtitle": "one-line positioning + 'Investor Presentation'"}
- {"type": "section", "number": "01", "title": "Market & Competition"}
- {"type": "cards", "title": "...", "cards": [{"label": "The Opportunity", "text": "2 sentences max"}]}  (2-4 cards)
- {"type": "bigNumbers", "title": "...", "stats": [{"value": "$7B", "label": "short label with year/source"}], "note": "one sentence"}  (2-4 stats, values under 8 characters)
- {"type": "bullets", "title": "...", "bullets": ["one sentence each"], "callout": "the one-line takeaway"}  (3-5 bullets)
- {"type": "table", "title": "...", "columns": ["..."], "rows": [["..."]]}  (max 5 columns, 7 rows, short cells)
- {"type": "marketSize", "title": "...", "takeaway": "one sentence"}  (TAM/SAM/SOM drawn automatically from the model)
- {"type": "chart", "chart": "arr" | "pnl" | "cash" | "headcount", "title": "...", "takeaway": "one sentence"}  (chart data drawn automatically from the model)
- {"type": "unitEconomics", "title": "...", "takeaway": "one sentence"}  (figures drawn automatically from the model)
- {"type": "ask", "title": "...", "useOfFunds": [{"label": "Product & Engineering", "pct": 40}], "milestones": ["what this raise achieves"]}  (shares sum to 100)
- {"type": "closing", "title": "Next Steps", "points": ["..."]}

Required running order: title; an executive-summary "cards" slide (The Opportunity / Our Position / The Numbers / The Ask); section 01 Market & Competition (the problem, customer insight, a competitor "table", "marketSize"); section 02 Strategy & Product (beachhead choice, product, go-to-market); section 03 Financial Model ("chart" arr, "chart" pnl, "unitEconomics", "chart" headcount); section 04 Funding ("ask", "chart" cash); a key risks & mitigants "table"; "closing".
Any number you put in a title, card, stat or table must match the FINANCIAL MODEL figures or carry an [S#] citation from the fact base; otherwise mark it "(est.)". Keep text tight — slides, not paragraphs.`;

    const result = await runClaude(client, {
      maxTokens: 12000,
      system: SENIOR_VOICE + JSON_ONLY + `\n\n${CITATION_RULES}`,
      messages: [{ role: 'user', content: contextBlocks(ctx, instructions) }],
    });

    const deck = sanitizeDeck(safeParseJSON(result.text));
    if (deck.slides.length < 5) {
      return res.status(500).json({ error: "The deck came back incomplete. Try regenerating." });
    }
    res.status(200).json({ success: true, deck, usage: result.usage });
  } catch (err) {
    sendError(res, err, "Failed to generate pitch deck");
  }
});

app.get(['/terms', '/terms.html'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'terms.html'));
});

app.get(['/privacy', '/privacy.html'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'privacy.html'));
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Handle all other routes -> index.html (for React routing)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

export default app;

// Local development: `npm start` runs this file directly. On Vercel the app is imported
// as a serverless handler instead, so it must not bind a port.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => console.log(`MarketEdge running on http://localhost:${port}`));
}
