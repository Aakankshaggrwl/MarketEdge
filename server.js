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
    let clean = text.replace(/```json|```/g, "").trim();
    try {
      return JSON.parse(clean);
    } catch (e1) {
      clean = clean.replace(/\n/g, " ").replace(/\r/g, "");
      try {
        return JSON.parse(clean);
      } catch (e2) {
        const jsonMatch = clean.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
        if (jsonMatch) {
          return JSON.parse(jsonMatch[0]);
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
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
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
      max_tokens: 2000,
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
{"engagement_summary": "updated summary if changed, otherwise keep original","milestones": [{"key":"...","name":"...","rationale":"..."}],"changes_made": "Brief description of what changed, or 'None' if only clarification was needed"}`;
    } else {
      return res.status(400).json({ error: "Invalid interaction type" });
    }

    const message = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 2000,
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`MarketEdge server running on http://localhost:${PORT}`);
});
