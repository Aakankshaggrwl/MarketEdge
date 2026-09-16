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

// Per-milestone guidance for what the DETAILED_ANALYSIS section must specifically cover.
const MILESTONE_FOCUS = {
  customer: `Cover, at minimum, all of the following as clearly labeled sub-sections:
- Customer Segments: break the market into concrete segments (not generic personas) grounded in the client's brief, with the estimated size/reach of each.
- Approach Per Segment: for each segment, how to reach them, what messaging resonates, and what channel/motion fits their buying behavior.
- Economics Per Segment: expected price point, margin profile, and lifetime value per segment — call out which segments are more profitable and why.
- Psychographic & Sentiment Analysis: the underlying motivations, fears, and emotional drivers behind each segment's buying decision — what pain they are actually trying to escape, not just the functional need.
- Pain Points & Unmet Requirements: the specific frustrations with current alternatives (including doing nothing) that this business can exploit.
- Target Customer Recommendation: a clear, decisive call on which segment(s) to prioritize first and why, ranked by attractiveness.`,
  competitor: `Cover, at minimum: a competitor-by-competitor breakdown (direct and indirect) with their positioning, pricing, and target segment; where each is strong and where each is structurally weak; white space they are leaving open; and how this client should differentiate against each of them specifically.`,
  gap: `Cover, at minimum: the specific unserved or underserved needs in this market, evidence for why they are unserved, the size of the opportunity each gap represents, and which gaps this business is best positioned to own given its stated strengths.`,
  beachhead: `Cover, at minimum: 2-3 candidate beachhead segments compared head-to-head on reachability, willingness to pay, competitive intensity, and expansion potential; a decisive recommendation on the single best beachhead; and the specific wedge strategy to win it.`,
  entry: `Cover, at minimum: the recommended entry sequence (channel-by-channel or region-by-region), the rationale for that sequence, go-to-market motion (sales-led, PLG, partnerships, etc.), and the first 90 days of concrete entry actions.`,
  financial: `Cover, at minimum: TAM/SAM/SOM with the calculation method shown, a revenue model with unit economics, a 3-year P&L outline with the key assumptions stated explicitly, and funding needs tied to specific milestones/runway.`,
  bizplan: `Cover, at minimum: the full operating plan spanning product, go-to-market, team, and operations, with concrete milestones and resourcing tied to the financial plan and market entry strategy already defined.`,
  pitch: `Cover, at minimum: a slide-by-slide narrative outline (problem, solution, market, traction, business model, competition, team, ask), with the specific proof points and numbers this client should lead with on each slide.`,
  execbrief: `Cover, at minimum: a synthesis of every prior milestone into the 3-5 decisions that matter most, each with its supporting evidence, so a time-constrained reader gets the whole strategy without reading the underlying reports.`,
};

// Function to safely parse JSON
function safeParseJSON(text) {
  try {
    // Remove markdown code blocks
    let clean = text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    
    // First attempt: direct parse
    try {
      return JSON.parse(clean);
    } catch (e1) {
      // Second attempt: normalize whitespace
      clean = clean.replace(/[\r\n]/g, " ").replace(/\s+/g, " ");
      try {
        return JSON.parse(clean);
      } catch (e2) {
        // Third attempt: fix common quote escaping issues
        clean = clean.replace(/([^\\])"/g, '$1\\"').replace(/^"/, '\\"');
        try {
          return JSON.parse(clean);
        } catch (e3) {
          // Fourth attempt: extract JSON object more carefully
          const match = clean.match(/\{[\s\S]*\}(?=\s*$)/);
          if (match) {
            try {
              return JSON.parse(match[0]);
            } catch (e4) {
              // Last resort: try to find valid JSON by removing problematic content
              let jsonStr = match[0];
              // Fix unclosed strings
              jsonStr = jsonStr.replace(/: "([^"]*$)/g, ': ""');
              return JSON.parse(jsonStr);
            }
          }
          throw e2;
        }
      }
    }
  } catch (err) {
    console.error("JSON content preview:", text.substring(0, 500));
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

Select 4–9 milestones that this specific client needs, in the right order (analysis before strategy before documents). Anchor every rationale in facts from THEIR brief — quote their numbers and constraints. For each milestone's rationale, write 5-6 sentences that clearly explain: what this milestone will actually cover, the specific questions it will answer for THIS client, and why it matters given their brief — not a generic description of the milestone type. Respond ONLY with valid JSON (no markdown, no fences):
{"engagement_summary": "3-4 sentences describing this engagement in specific terms drawn from their brief","milestones": [{"key":"customer","name":"Customer Analysis","rationale":"5-6 sentences: what this milestone covers for THIS client, the specific questions it answers, and why it matters given their brief"}]}`;

    const message = await client.messages.create({
  model: "claude-sonnet-5",
  max_tokens: 4000,
  system: SENIOR_VOICE + ` Respond with ONLY valid JSON matching the exact structure requested. No markdown, no code fences, no prose before or after the JSON.`,
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
      const briefContext = `Client brief: ${intake.brief}. Industry: ${intake.industry}. Stage: ${intake.stage}. Market: ${intake.market}. Goal: ${intake.goal}.`;
      prompt = `You have designed this scope of work for a client, and they are now asking you a follow-up question directly, in conversation. Answer as the consultant who wrote this scope — specific, warm, and direct, the way you'd actually reply to a client on a call.

Client: ${briefContext}

Scope summary: ${sow.engagement_summary}

Milestones in this engagement:
${milestonesStr}

Client question: "${userMessage}"

Write a natural, conversational answer, 3-5 sentences. Ground it in the specifics of THIS client's brief and THIS scope — reference their actual business details, not generic advice. If the question is about something a specific milestone covers, name that milestone and briefly say what it will show them. If the question is about something genuinely not covered by any milestone, say so plainly and suggest how it could be added. Never answer with a generic non-answer — if you're not sure, make your best specific judgment call rather than deflecting.`;
    } else if (interactionType === "revision") {
      responseType = "revised_sow";
      const catalog = MILESTONE_CATALOG.map(m => `${m.key}: ${m.name} — ${m.desc}`).join("\n");
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
      : SENIOR_VOICE + ` Respond with ONLY valid JSON matching the exact structure requested. No markdown, no code fences, no prose before or after the JSON.`;

    const message = await client.messages.create({
  model: "claude-sonnet-5",
  max_tokens: 4000,
  system,
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
// Parse the ---SECTION----delimited text report into { title, sections: [{heading, content}] }
function parseTextReport(rawText, fallbackTitle) {
  const parts = rawText.split('---SECTION---').map(p => p.trim()).filter(Boolean);

  let title = fallbackTitle;
  const sections = [];

  for (const part of parts) {
    const match = part.match(/^([A-Z][A-Z_]*)\s*:\s*([\s\S]*)$/);

    if (!match) {
      // No "LABEL:" prefix — treat as a continuation of the previous section
      if (sections.length > 0) {
        sections[sections.length - 1].content += "\n\n" + part;
      }
      continue;
    }

    const [, label, body] = match;
    const content = body.trim();

    if (label === 'TITLE') {
      title = content || fallbackTitle;
      continue;
    }

    const heading = label
      .split('_')
      .filter(Boolean)
      .map(w => w.charAt(0) + w.slice(1).toLowerCase())
      .join(' ');

    sections.push({ heading, content });
  }

  if (sections.length === 0) {
    sections.push({ heading: 'Report', content: rawText.trim() });
  }

  return { title, sections };
}

// Generate comprehensive milestone report (with detailed logging)
app.post('/api/generate-milestone-report', async (req, res) => {
  try {
    const { milestoneKey, milestoneName, sow, intake } = req.body;
    
    console.log("📋 Report request:", { milestoneKey, milestoneName });

    if (!milestoneKey || !milestoneName || !sow || !intake) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const briefContext = `Client brief: ${intake.brief}. Industry: ${intake.industry}. Stage: ${intake.stage}. Market: ${intake.market}. Goal: ${intake.goal}.`;
    const focus = MILESTONE_FOCUS[milestoneKey] || `Cover the core analytical work this milestone promises, in full depth, organized into clearly labeled sub-sections.`;

    let prompt = `You are a senior strategy consultant. Generate a comprehensive, in-depth report for "${milestoneName}". This is a deliverable the client is paying for — it should read like a 15-20 page strategy document, not a summary. Write in full paragraphs, be specific and numeric wherever the brief gives you facts to work with, and never pad with generic filler to hit length — every paragraph must carry real analysis.

Client: ${briefContext}
Scope: ${sow.engagement_summary}

Respond with ONLY these sections separated by ---SECTION---. Follow the target length for each section — together they should total roughly 7,500-10,000 words. Structure each section using the "##", "###", "-", and "**bold**" conventions from your system instructions wherever they help a senior reader scan the section quickly — never as a bare list with no surrounding prose:

TITLE: ${milestoneName}
---SECTION---
EXECUTIVE_SUMMARY: [300-400 words. Open with 1-2 orienting paragraphs on the headline conclusions and why they matter to this client specifically. Use "## " subsections only if the summary naturally splits into distinct headline conclusions.]
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

    console.log("🔧 Sending API request with prompt length:", prompt.length);

    const message = await client.messages.create({
  model: "claude-sonnet-5",
  max_tokens: 16000,
  system: SENIOR_VOICE + ` Respond with ONLY the formatted text report. No JSON. Use ---SECTION--- as separators between the sections listed in the prompt. Be comprehensive and detailed — this report should be long and substantive, not a summary.

Formatting rules for the content inside each section — follow these exactly, they map directly to a renderer that builds proper headings and bullet lists from them:
- Write in full paragraphs of connected prose, 3-6 sentences each. Never leave a heading with no paragraph under it, and never write a bare list with no surrounding prose.
- Start a line with "## " for a named subsection heading — a short Title Case phrase, no numbering and no trailing colon (we add the numbers). Use it to break a long section into its logical parts, e.g. "## Customer Segments".
- Start a line with "### " for a short, numbered talking-point heading within a subsection — a short Title Case phrase, no numbering (we add the numbers). Use it for enumerable items like findings, recommendations, risks, or KPIs, immediately followed by an explanatory paragraph.
- Start a line with "- " for a bullet point. When a bullet states a discrete fact, lead with a short bold label using **Label:** followed by the explanation, e.g. "- **Target Segment:** mid-market retailers with 10-50 locations, most price-sensitive on logistics cost."
- Use **bold** only around a genuinely load-bearing term, number, or name inside a sentence — never bold a whole sentence.
- Never use single "#" headings, numbered markers you write yourself like "1." or "a)", or markdown tables.
- Leave a blank line between every heading, paragraph, and bullet group.`,
  messages: [{ role: "user", content: prompt }],
});

    console.log("✅ API Response received. Content blocks:", message.content.length);
    console.log("📊 Full response:", JSON.stringify(message, null, 2).substring(0, 500));

    const textBlock = message.content.find(block => block.type === "text");
    
    if (!textBlock) {
      console.error("❌ No text block found. Content types:", message.content.map(b => b.type));
      return res.status(500).json({ 
        error: "No text response from Claude",
        contentTypes: message.content.map(b => b.type)
      });
    }

    const rawText = textBlock.text || "";
    
    console.log("📝 Raw text length:", rawText.length);
    console.log("📝 First 300 chars:", rawText.substring(0, 300));

    if (!rawText || rawText.trim().length < 10) {
      console.error("❌ Empty or too-short response:", rawText.substring(0, 100));
      return res.status(500).json({ 
        error: "Empty response from Claude",
        textLength: rawText.length
      });
    }

    // Parse the text-based report
    const report = parseTextReport(rawText, milestoneName);
    
    console.log("✅ Report parsed successfully. Sections:", report.sections.length);

    res.status(200).json({ success: true, report });
  } catch (err) {
    console.error("❌ Report generation error:", err.message);
    console.error("Stack:", err.stack);
    res.status(500).json({ error: err.message || "Failed to generate report" });
  }
});
export default app;

