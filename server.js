import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const SENIOR_VOICE = `You are a strategy consultant with 18 years of experience across market entry, growth strategy and fundraising. You write like a senior partner: specific, numeric where possible, decisive, never vague. You never write generic AI filler. Every claim is concrete. You use the client's own facts from their brief wherever possible.`;

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

// Function to safely parse JSON
function safeParseJSON(text) {
  try {
    // Remove markdown code blocks
    let clean = text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    
    // First attempt: direct parse
    try {
      return JSON.parse(clean);
    } catch (e1) {
      // Second attempt: remove problematic whitespace but preserve structure
      clean = clean.replace(/[\r\n]/g, " ");
      try {
        return JSON.parse(clean);
      } catch (e2) {
        // Third attempt: find and extract JSON object/array
        const jsonMatch = clean.match(/\{[\s\S]*\}(?=\s*$)/) || clean.match(/\[[\s\S]*\](?=\s*$)/);
        if (jsonMatch) {
          try {
            return JSON.parse(jsonMatch[0]);
          } catch (e3) {
            throw new Error(`Extracted JSON still invalid: ${e3.message}`);
          }
        }
        throw e2;
      }
    }
  } catch (err) {
    throw new Error(`JSON parsing failed: ${err.message}`);
  }
}

// CORS headers
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  next();
});

app.options('*', (req, res) => res.sendStatus(200));

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

Select 4–9 milestones that this specific client needs, in the right order (analysis before strategy before documents). Anchor every rationale in facts from THEIR brief — quote their numbers and constraints. Respond ONLY with valid JSON (no markdown, no fences):
{"engagement_summary": "3-4 sentences describing this engagement in specific terms drawn from their brief","milestones": [{"key":"customer","name":"Customer Analysis","rationale":"1-2 sentences why THIS client needs it"}]}`;

    const message = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 4000,
      system: SENIOR_VOICE + ` Respond ONLY with JSON, no markdown fences, no preamble.`,
      messages: [{ role: "user", content: prompt }],
    });

    const textBlock = message.content.find(block => block.type === "text");
    const text = textBlock?.text || "";
    
    if (!text || text.trim().length === 0) {
      return res.status(500).json({ error: "Empty response from Claude" });
    }

    const sow = safeParseJSON(text);

    if (!sow?.milestones || !Array.isArray(sow.milestones) || sow.milestones.length === 0) {
      return res.status(500).json({ error: "Invalid SOW structure: missing or empty milestones" });
    }

    res.status(200).json({ success: true, sow });
  } catch (err) {
    console.error("SOW generation error:", err.message);
    res.status(500).json({ error: err.message || "Failed to generate SOW" });
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
      prompt = `You have designed this scope of work:

Summary: ${sow.engagement_summary}

Milestones:
${milestonesStr}

Client question: "${userMessage}"

Answer their question concisely (2-3 sentences). If it's about a topic covered in the scope, mention which milestone(s) address it. If not covered, suggest it could be added.`;
    } else if (interactionType === "revision") {
      responseType = "revised_sow";
      const catalog = MILESTONE_CATALOG.map(m => `${m.key}: ${m.name} — ${m.desc}`).join("\n");
      prompt = `A client filled our discovery intake. Current scope of work:

Summary: ${sow.engagement_summary}

Current milestones:
${milestonesStr}

Client feedback/request: "${userMessage}"

Make the requested changes. Return ONLY valid JSON (no markdown, no explanation):
{"engagement_summary": "updated summary if changed, otherwise keep original","milestones": [{"key":"...","name":"...","rationale":"..."}],"changes_made": "Clear summary of changes: what was added, removed, or modified. Be specific."}`;
    } else {
      return res.status(400).json({ error: "Invalid interaction type" });
    }

    const message = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 4000,
      system: SENIOR_VOICE + ` You must respond with ${responseType === "answer" ? "a helpful answer" : "valid JSON only. No markdown. No explanation."}.`,
      messages: [{ role: "user", content: prompt }],
    });

    const textBlock = message.content.find(block => block.type === "text");
    const text = textBlock?.text || "";
    
    if (!text) {
      return res.status(500).json({ error: "Empty response from Claude" });
    }

    if (responseType === "answer") {
      res.status(200).json({ success: true, type: "answer", response: text });
    } else {
      let revisedData;
      try {
        let clean = text.replace(/```json|```/g, "").trim();
        clean = clean.replace(/\n/g, " ").replace(/\r/g, "");
        revisedData = safeParseJSON(clean);
      } catch (parseErr) {
        return res.status(500).json({ error: `Failed to parse revisions: ${parseErr.message}` });
      }

      res.status(200).json({ success: true, type: "revision", sow: revisedData });
    }
  } catch (err) {
    console.error("SOW interaction error:", err.message);
    res.status(500).json({ error: err.message || "Failed to process request" });
  }
});

// Serve static files
app.use(express.static('public'));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Handle all other routes -> index.html (for React routing)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
// Generate comprehensive milestone report (no page limit)
app.post('/api/generate-milestone-report', async (req, res) => {
  try {
    const { milestoneKey, milestoneName, sow, intake } = req.body;
    
    if (!milestoneKey || !milestoneName || !sow || !intake) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const briefContext = `Client brief: ${intake.brief}. Industry: ${intake.industry}. Stage: ${intake.stage}. Market: ${intake.market}. Goal: ${intake.goal}.`;
    
    let prompt;

    // Milestone-specific COMPREHENSIVE prompts (no page limit)
    switch(milestoneKey) {
      case "customer":
        prompt = `You are a senior strategy consultant. Generate a COMPREHENSIVE, DETAILED Customer Analysis Report. This should be as detailed and extensive as needed to provide complete customer intelligence - no page limit.

Client context: ${briefContext}
Scope: ${sow.engagement_summary}

Create a thorough analysis with ALL of these sections (go very deep on each):
1. Executive Summary (3-4 sentences, complete overview)
2. Market Demographics (size, growth, geography, key statistics)
3. Customer Segmentation (4-6 detailed customer personas with specific attributes)
4. Psychographic Profiling (values, lifestyles, aspirations, decision-making patterns for each segment)
5. Pain Points & Challenges (detailed breakdown of specific problems, quantified impact, frequency, severity)
6. Customer Behaviors & Preferences (buying patterns, decision journey, influencers, information sources)
7. Willingness to Pay Analysis (pricing sensitivity, perceived value, what customers are willing to pay, competitive pricing benchmarks)
8. Target Customer Profiles (detailed ideal customer profiles for each segment, decision criteria, ROI expectations)
9. Customer Acquisition Strategies (specific channels, messaging for each segment, partnerships, cost per acquisition)
10. Retention & Lifetime Value (how to keep customers, expansion opportunities, LTV calculations)
11. Profitability Analysis (segment profitability ranking, unit economics, most/least profitable customers)
12. Key Trends & Shifts (emerging behaviors, demographic shifts, technology adoption, future customer needs)
13. Competitive Customer Analysis (how competitors are targeting these customers, gaps in competitor offerings)
14. Strategic Recommendations (top 10 actionable next steps, investment priorities, quick wins)

Write in first person ("we found", "we recommend"). Be extremely specific, quantified, data-driven, and actionable. This should be a comprehensive customer intelligence report, 15-20+ pages if needed.

Return as JSON:
{"title":"${milestoneName}","sections":[{"heading":"...","content":"..."}],"recommendations":["..."],"metrics":["..."]}`;
        break;

      case "competitor":
        prompt = `You are a senior strategy consultant. Generate a COMPREHENSIVE, DETAILED Competitor Landscape Report. This should be extensive and thorough - no page limit.

Client context: ${briefContext}
Scope: ${sow.engagement_summary}

Create a thorough analysis with ALL of these sections:
1. Executive Summary (complete overview of competitive landscape)
2. Market Structure Analysis (market size, growth, fragmentation, consolidation trends)
3. Competitive Categories (direct, indirect, emerging competitors, adjacency threats)
4. Top 5-7 Direct Competitors (for each: detailed positioning, product/service offering, pricing strategy, go-to-market approach, market share estimate, strengths, weaknesses, financial performance if known, customer reviews/satisfaction)
5. Competitive Positioning Matrix (where each competitor sits, market gaps, whitespace opportunities)
6. Competitive Differentiation Analysis (what makes each competitor unique, barriers to entry, switching costs)
7. Pricing Comparison (detailed competitive pricing analysis, pricing models, value proposition per price point)
8. Technology & Innovation (technology stacks, innovation speed, R&D spend, patents/IP)
9. Sales & Marketing Strategies (how competitors acquire customers, marketing spend, messaging, partnerships)
10. Customer Satisfaction & NPS (competitor reviews, customer satisfaction scores, churn rates if known)
11. Emerging & New Competitors (new entrants, adjacency plays, potential threats)
12. Industry Consolidation (M&A activity, acquisition targets, private equity interest)
13. Our Competitive Advantages (specific advantages vs each competitor, defensibility, unfair advantages)
14. Competitive Vulnerabilities (where competitors are weak, we can attack, customer pain points with them)
15. Competitive Response Scenarios (how competitors will respond to our entry, game theory analysis)
16. Strategic Recommendations (how to compete, differentiation strategy, competitive moats to build, pricing strategy)

Write in first person. Be extremely specific with company examples, financial data where available, and tactical insights.

Return as JSON:
{"title":"${milestoneName}","sections":[{"heading":"...","content":"..."}],"recommendations":["..."],"metrics":["..."]}`;
        break;

      case "gap":
        prompt = `You are a senior strategy consultant. Generate a COMPREHENSIVE, DETAILED Gap & Opportunity Analysis Report - no page limit.

Client context: ${briefContext}
Scope: ${sow.engagement_summary}

Create a thorough analysis with ALL of these sections:
1. Executive Summary (overview of major gaps and opportunities)
2. Market Needs Assessment (comprehensive list of customer needs, prioritized by importance and underserved status)
3. Unmet Customer Needs (specific needs competitors are NOT addressing, quantified pain/cost of unmet need)
4. Feature/Service Gaps (specific features, services, or solutions missing in the market)
5. Customer Segment Gaps (segments being underserved or completely ignored by competitors)
6. Geographic Gaps (regions or markets with limited competition or underserved demand)
7. Pricing Model Gaps (pricing approaches competitors haven't adopted, pricing tiers that don't exist)
8. Emerging Trend Opportunities (macro trends creating new opportunities - technology, regulation, consumer behavior shifts)
9. Value Chain Opportunities (adjacency plays, bundling opportunities, vertical integration possibilities)
10. Competitive Vulnerability Exploitation (specific weaknesses in competitors we can exploit, dissatisfied customer segments)
11. Market Whitespace Analysis (detailed map of uncontested territory, defensible positions, low-competition niches)
12. Timing & Readiness (why now is the right time, what needs to align, readiness signals)
13. Quantified Opportunity Sizing (total addressable opportunity by gap type, growth potential, time horizons)
14. Barrier Assessment (what's preventing competitors from filling these gaps, barriers we'd face)
15. Strategic Recommendations (top 8-10 opportunities to pursue, sequencing, investment required for each)

Write in first person. Be specific, quantified, and forward-looking.

Return as JSON:
{"title":"${milestoneName}","sections":[{"heading":"...","content":"..."}],"recommendations":["..."],"metrics":["..."]}`;
        break;

      case "beachhead":
        prompt = `You are a senior strategy consultant. Generate a COMPREHENSIVE, DETAILED Beachhead Selection & Strategy Report - no page limit.

Client context: ${briefContext}
Scope: ${sow.engagement_summary}

Create a thorough analysis with ALL of these sections:
1. Executive Summary (recommended beachhead and rationale)
2. Beachhead Candidate Overview (4-6 potential segments analyzed in detail)
3. Candidate Evaluation Matrix (score each on: size, growth, profitability, competition, ease of acquisition, stickiness, expansion potential)
4. Recommended Beachhead Deep Dive (detailed profile: size, growth, willingness to pay, decision-making, pain points, competitive offerings)
5. Why This Beachhead (specific advantages over alternatives, lowest competition, highest LTV, defensibility)
6. Beachhead Economics (TAM/SAM/SOM for beachhead, customer acquisition cost, lifetime value, profitability timeline)
7. Go-to-Market Strategy for Beachhead (customer acquisition channels, messaging, partnerships needed, launch timeline, team required)
8. Competitive Response in Beachhead (how competitors will react, defensive strategies, stickiness mechanisms)
9. Success Metrics in Beachhead (KPIs to track, revenue targets, customer count targets, expansion triggers)
10. Resource Requirements (budget, headcount, technology, timeline to profitability in beachhead)
11. Beachhead to Adjacent Markets (expansion roadmap after beachhead, sequencing, which segments next)
12. Land & Expand Strategy (how to expand within beachhead, upselling approach, revenue expansion opportunities)
13. Scaling Timeline (when to expand from beachhead, profitability requirements, growth targets)
14. Risk Mitigation (execution risks, market risks, competitive risks, contingency plans)
15. Strategic Recommendations (top 10 action items, critical success factors, decision gates)

Write in first person, be tactical and specific.

Return as JSON:
{"title":"${milestoneName}","sections":[{"heading":"...","content":"..."}],"recommendations":["..."],"metrics":["..."]}`;
        break;

      case "entry":
        prompt = `You are a senior strategy consultant. Generate a COMPREHENSIVE, DETAILED Market Entry Strategy Report - no page limit.

Client context: ${briefContext}
Scope: ${sow.engagement_summary}

Create a thorough analysis with ALL of these sections:
1. Executive Summary (recommended entry strategy and timeline)
2. Entry Strategy Options (direct entry, partnership, joint venture, acquisition, licensing - detailed pros/cons/timeline for each)
3. Recommended Entry Approach (rationale, sequencing, timeline, resource requirements)
4. Market Entry Timeline (phased 12-24 month plan with specific milestones and go/no-go gates)
5. Pre-Launch Requirements (regulatory, compliance, partnerships, technology, team, capital)
6. Customer Acquisition Strategy (detailed channel strategy, messaging by segment, pricing launch strategy)
7. Go-to-Market Campaign (pre-launch PR, launch announcement, early customer acquisition plan)
8. Sales & Distribution Strategy (direct sales, partnerships, channels, scaling approach)
9. Pricing Strategy at Entry (launch pricing, promotional tactics, price escalation timeline)
10. Marketing & Positioning (brand positioning, messaging pillars, competitive messaging, content strategy)
11. Partnership Strategy (key partners needed, partnership types, deal structure, timing)
12. Competitive Response Preparation (anticipated competitor reactions by phase, defensive strategies)
13. Organizational Readiness (team structure needed, hiring plan, training, process setup)
14. Financial Requirements (capital needed by phase, P&L projections, breakeven timeline)
15. Risk Mitigation (market entry risks, execution risks, competitive risks, contingencies)
16. Success Metrics & Scaling (KPIs by phase, scaling triggers, expansion decision points)
17. Strategic Recommendations (top 12 action items, critical path, decision framework)

Write in first person, be operational and specific.

Return as JSON:
{"title":"${milestoneName}","sections":[{"heading":"...","content":"..."}],"recommendations":["..."],"metrics":["..."]}`;
        break;

      case "financial":
        prompt = `You are a senior strategy consultant. Generate a COMPREHENSIVE, DETAILED Financial Analysis & Modeling Report - no page limit.

Client context: ${briefContext}
Scope: ${sow.engagement_summary}

Create a thorough analysis with ALL of these sections:
1. Executive Summary (financial opportunity, capital requirements, ROI summary)
2. Total Addressable Market (TAM) Calculation (top-down approach, bottom-up approach, reconciliation, growth trajectory, market size benchmarks)
3. Serviceable Addressable Market (SAM) (realistic addressable market for our beachhead, 5-10 year outlook, competitive dynamics impact)
4. Serviceable Obtainable Market (SOM) (realistic capture in years 1-3 and 5-10, market share assumptions, growth drivers)
5. Customer Segmentation Economics (unit economics by customer segment, LTV/CAC by segment, profitability ranking)
6. Revenue Model Design (pricing strategy, pricing tiers, contract terms, payment models, volume assumptions)
7. Detailed Unit Economics (CAC by channel, payback period, churn assumptions, expansion revenue, gross margin by product)
8. Cost Structure Analysis (COGS breakdown, OpEx by function, scaling cost curves, gross margin progression)
9. 5-Year P&L Projections (revenue growth, cost structure evolution, profitability timeline, cash burn, EBITDA)
10. Cash Flow Projections (monthly cash burn for first 24 months, working capital needs, cash conversion cycle)
11. Break-Even Analysis (unit economics break-even, monthly break-even, profitability timeline)
12. Sensitivity Analysis (impact of key variable changes on profitability: CAC +/-20%, churn, pricing, etc.)
13. Scenario Planning (base case, bull case, bear case scenarios)
14. Funding Requirements & Use of Funds (capital needed in each round, allocation by function, timeline)
15. Return Scenarios (investor returns under base/bull/bear cases, payback period, IRR)
16. Benchmarking (compare our unit economics to industry benchmarks and comparable companies)
17. Key Financial Assumptions (document all assumptions explicitly)
18. Strategic Recommendations (pricing strategy, go-to-market efficiency improvements, profitability path)

Include detailed financial models, assumptions documentation, scenario comparisons.

Return as JSON:
{"title":"${milestoneName}","sections":[{"heading":"...","content":"..."}],"recommendations":["..."],"metrics":["..."]}`;
        break;

      case "bizplan":
        prompt = `You are a senior strategy consultant. Generate a COMPREHENSIVE, DETAILED Business Plan Report - no page limit.

Client context: ${briefContext}
Scope: ${sow.engagement_summary}

Create a thorough analysis with ALL of these sections:
1. Executive Summary (complete business overview, opportunity, competitive advantage)
2. Business Model (revenue model, unit economics, key partnerships, key activities, key resources)
3. Product/Service Strategy (what we're selling, feature roadmap, product positioning, quality/support differentiation)
4. Operations & Delivery (how we deliver product/service, quality assurance, scalability, supply chain, vendor management)
5. Technology & Infrastructure (platform requirements, build vs partner decisions, security, data strategy, tech scaling)
6. Sales Strategy (customer acquisition by channel, sales process, sales team structure, ramp timeline)
7. Marketing Strategy (brand positioning, customer acquisition channels, marketing budget allocation, brand messaging)
8. Organizational Structure (current team, key roles needed, build vs hire timeline, culture/values)
9. Financial Plan (revenue model, unit economics, 5-year projections, profitability timeline, funding needs)
10. Customer Success & Retention (onboarding process, customer success team, retention strategy, upsell approach)
11. Competitive Strategy (differentiation, competitive advantages, defensibility, positioning vs competitors)
12. Risk Management (key risks, mitigation strategies, contingency plans, decision trees)
13. Growth & Expansion (scaling timeline, geographic expansion, new product/market opportunities)
14. Partnerships & Ecosystem (key partnerships, partnership value, partnership timeline)
15. Key Metrics & KPIs (quarterly targets for revenue, customers, retention, CAC, LTV, profitability)
16. 12-Month Roadmap (specific milestones, resource allocation, investment priorities)
17. Strategic Recommendations (top 15 action items, critical success factors, decision framework)

Write in first person, be operationally specific and comprehensive.

Return as JSON:
{"title":"${milestoneName}","sections":[{"heading":"...","content":"..."}],"recommendations":["..."],"metrics":["..."]}`;
        break;

      case "pitch":
        prompt = `You are a senior strategy consultant. Generate a COMPREHENSIVE, DETAILED Investor Pitch & Deck Framework Report - no page limit.

Client context: ${briefContext}
Scope: ${sow.engagement_summary}

Create a thorough analysis with ALL of these sections:
1. Executive Summary (complete pitch narrative)
2. The Hook & Problem (compelling problem statement, market opportunity, why this matters)
3. Market Opportunity (TAM/SAM/SOM, market growth, why now, market dynamics)
4. Solution & Differentiation (our approach, product, why it's unique, competitive advantages)
5. Customer Pain & Use Cases (detailed customer pain points, use cases, customer value proposition)
6. Target Customer (beachhead segment detail, customer profile, decision-making, willingness to pay)
7. Go-to-Market Strategy (customer acquisition, marketing, sales, expansion plan)
8. Business Model & Economics (revenue model, unit economics, path to profitability)
9. Market Validation (traction to date, customer feedback, pilot results, early adoption evidence)
10. Competitive Landscape (competitors, competitive advantages, defensibility, market positioning)
11. Team & Organization (founder backgrounds, expertise, key hires needed, why we can execute)
12. Financial Projections (5-year revenue projections, profitability timeline, unit economics)
13. Unfair Advantages (defensible moats, technology advantages, network effects, brand advantages)
14. Risk Mitigation (key risks, mitigation strategies, contingency plans)
15. Investment Ask (capital requested, use of funds, allocation, runway)
16. Return Opportunity (revenue potential, profitability, exit scenarios, investor returns)
17. Investor Story Arc (narrative arc, emotional connection, compelling close)
18. Pitch Deck Outline (specific slide by slide outline with talking points)

Write in first person, compelling investor-ready language. This is the complete investor narrative.

Return as JSON:
{"title":"${milestoneName}","sections":[{"heading":"...","content":"..."}],"recommendations":["..."],"metrics":["..."]}`;
        break;

      case "execbrief":
        prompt = `You are a senior strategy consultant. Generate a COMPREHENSIVE, DETAILED Executive Brief Report - no page limit. This is a complete strategic summary.

Client context: ${briefContext}
Scope: ${sow.engagement_summary}

Create a thorough analysis with ALL of these sections:
1. Executive Summary (3-5 sentences, complete strategy overview)
2. Market Opportunity (TAM, SAM, SOM, growth, timing, why now)
3. Customer Analysis (target segments, customer needs, willingness to pay, decision-making)
4. Competitive Position (competitors, our differentiation, competitive advantages, positioning)
5. Beachhead Strategy (first target segment, why that segment, go-to-market into beachhead)
6. Product/Service Strategy (what we're selling, positioning, differentiation)
7. Go-to-Market Strategy (customer acquisition approach, channels, messaging, pricing, timeline)
8. Business Model (revenue model, unit economics, 5-year financial projections)
9. Team & Organization (current team, key hires needed, execution capability)
10. Competitive Response (how competitors will react, our defensive strategies, moats to build)
11. Key Risks & Mitigations (market risks, execution risks, competitive risks, financial risks)
12. Resource Requirements (capital needed, allocation, use of funds, timeline to profitability)
13. 3-Year Milestones (specific revenue targets, customer targets, expansion milestones, decision gates)
14. Success Metrics & KPIs (quarterly and annual targets, tracking framework)
15. Strategic Priorities (top 15 action items, critical success factors, investment priorities)

This should be a comprehensive strategic summary - complete strategy in 15-20+ pages if needed.

Return as JSON:
{"title":"${milestoneName}","sections":[{"heading":"...","content":"..."}],"recommendations":["..."],"metrics":["..."]}`;
        break;

      default:
        prompt = `You are a senior strategy consultant. Generate a COMPREHENSIVE Strategic Analysis Report for "${milestoneName}" - no page limit. Be as detailed and extensive as needed.

Client context: ${briefContext}
Scope: ${sow.engagement_summary}

Create comprehensive analysis with:
1. Executive Summary
2. Situation Analysis (market, customers, competitors, internal capabilities)
3. Key Findings (major insights, patterns, opportunities)
4. Detailed Strategic Analysis (15-20 detailed subsections covering all relevant aspects)
5. Customer Insights (needs, behaviors, pain points)
6. Competitive Analysis (positioning, advantages, vulnerabilities)
7. Market Opportunity (sizing, growth, timing)
8. Financial Analysis (unit economics, profitability, ROI)
9. Implementation Strategy (phased approach, timeline, resources)
10. Risk Assessment (key risks, mitigation strategies)
11. Success Metrics (KPIs, tracking framework)
12. Strategic Recommendations (top 15-20 action items, priorities)

Write in first person, data-driven, actionable, comprehensive.

Return as JSON:
{"title":"${milestoneName}","sections":[{"heading":"...","content":"..."}],"recommendations":["..."],"metrics":["..."]}`;
    }

    const message = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 8000,
      system: SENIOR_VOICE + ` Respond ONLY with valid JSON, no markdown. Create comprehensive, detailed, extensive reports. No page limits - be as thorough as needed to provide real value.`,
      messages: [{ role: "user", content: prompt }],
    });

    const textBlock = message.content.find(block => block.type === "text");
    const text = textBlock?.text || "";
    
    if (!text) {
      return res.status(500).json({ error: "Empty response from Claude" });
    }

    const report = safeParseJSON(text);
    res.status(200).json({ success: true, report });
  } catch (err) {
    console.error("Report generation error:", err.message);
    res.status(500).json({ error: err.message || "Failed to generate report" });
  }
});
export default app;

