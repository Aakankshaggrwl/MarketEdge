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

Select 4–9 milestones that this specific client needs, in the right order (analysis before strategy before documents). Anchor every rationale in facts from THEIR brief — quote their numbers and constraints. Respond ONLY with JSON:
{"engagement_summary": "3-4 sentences describing this engagement in specific terms drawn from their brief",
"milestones": [{"key":"customer","name":"Customer Analysis","rationale":"1-2 sentences why THIS client needs it, referencing their brief"}]}`;

    const message = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 1024,
      system: SENIOR_VOICE + ` Respond ONLY with JSON, no markdown fences, no preamble.`,
      messages: [{ role: "user", content: prompt }],
    });

    const text = message.content[0]?.type === "text" ? message.content[0].text : "";
    const sow = JSON.parse(text);

    if (!sow?.milestones?.length) {
      return res.status(400).json({ error: "Failed to generate valid SOW" });
    }

    res.status(200).json({ success: true, sow });
  } catch (err) {
    console.error("SOW generation error:", err);
    res.status(500).json({ error: err.message || "Failed to generate SOW" });
  }
});

app.post('/api/generate-milestone', async (req, res) => {
  try {
    const { brief, industry, stage, market, goal, milestoneName, priorAnalysis } = req.body;
    if (!brief?.trim() || !milestoneName) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const priorContextStr = priorAnalysis ? `Prior approved milestones:\n${priorAnalysis}` : "";
    const prompt = `Client: "${brief}" (${industry}, ${stage}, market: ${market}, goal: ${goal})
${priorContextStr ? priorContextStr + "\n" : ""}

Produce the "${milestoneName}" milestone. Be specific to THIS client — use their numbers, market and constraints. No generic filler. Respond ONLY with JSON:
{"headline_insight":"the single most important finding, 1-2 sharp sentences",
"sections":[{"heading":"...","body":"3-5 dense sentences of specific analysis"}] (4 sections),
"recommendations":["3 concrete next actions"],
"watch_out":"one honest risk or red flag, stated plainly"}`;

    const message = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 1400,
      system: SENIOR_VOICE + ` Respond ONLY with JSON, no fences.`,
      messages: [{ role: "user", content: prompt }],
    });

    const text = message.content[0]?.type === "text" ? message.content[0].text : "";
    const analysis = JSON.parse(text);

    if (!analysis?.sections?.length) {
      return res.status(400).json({ error: "Failed to generate valid analysis" });
    }

    res.status(200).json({ success: true, analysis });
  } catch (err) {
    console.error("Milestone generation error:", err);
    res.status(500).json({ error: err.message || "Failed to generate milestone" });
  }
});

app.use(express.static('public'));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`MarketEdge server running on http://localhost:${PORT}`);
});
