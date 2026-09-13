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
