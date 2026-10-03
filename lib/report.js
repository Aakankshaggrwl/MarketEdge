export const SUMMARY_WORD_CAP = 1000;

// Cuts at the nearest sentence boundary within budget where possible, otherwise a clean
// word boundary. Keeps any "**bold**" markers balanced.
export function truncateToWordLimit(text, maxWords) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return text;

  const truncated = words.slice(0, maxWords).join(' ');
  const lastSentenceEnd = Math.max(truncated.lastIndexOf('. '), truncated.lastIndexOf('.\n'));
  let result = lastSentenceEnd > truncated.length * 0.6 ? truncated.slice(0, lastSentenceEnd + 1) : truncated;

  const boldMarkers = (result.match(/\*\*/g) || []).length;
  if (boldMarkers % 2 !== 0) result += '**';

  return result.trim();
}

// Parses the ---SECTION----delimited text report into { title, sections: [{heading, content}] }.
export function parseTextReport(rawText, fallbackTitle) {
  const parts = rawText.split('---SECTION---').map(p => p.trim()).filter(Boolean);

  let title = fallbackTitle;
  const sections = [];

  for (const part of parts) {
    const match = part.match(/^([A-Z][A-Z_]*)\s*:\s*([\s\S]*)$/);

    if (!match) {
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

  // The Executive Summary is the on-screen snapshot shown before the client opens the
  // full report — hard-cap it regardless of what the model actually produced.
  const summarySection = sections.find(s => s.heading === 'Executive Summary');
  if (summarySection) {
    summarySection.content = truncateToWordLimit(summarySection.content, SUMMARY_WORD_CAP);
  }

  return { title, sections };
}

// Cover sections are "Key: Value" lines (Business Plan); returns [{label, value}].
export function parseKeyValueLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map(l => l.replace(/^[-*]\s+/, '').trim())
    .map(l => {
      const m = l.match(/^\*{0,2}([^:*]{2,40})\*{0,2}\s*:\s*(.+)$/);
      return m ? { label: m[1].trim(), value: m[2].replace(/\*\*/g, '').trim() } : null;
    })
    .filter(Boolean);
}
