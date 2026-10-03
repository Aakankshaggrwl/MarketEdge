// Canonical form for comparing URLs: lowercase host without "www.", no fragment, no
// tracking params, no trailing slash. Returns null for anything that isn't http(s).
export function normalizeUrl(raw) {
  try {
    const u = new URL(String(raw).trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    [...u.searchParams.keys()].forEach(k => { if (/^utm_|^ref$|^fbclid$|^gclid$/i.test(k)) u.searchParams.delete(k); });
    const path = u.pathname.replace(/\/+$/, '');
    const search = u.searchParams.toString();
    return `${host}${path}${search ? `?${search}` : ''}`;
  } catch {
    return null;
  }
}

function hostAndPath(norm) {
  return norm ? norm.split('?')[0] : null;
}

// Every URL the search tool actually returned in this response — from web_search_result
// blocks (top-level or nested under dynamic-filtering code execution) and from citations.
// This is the allow-list: a source the model cites that isn't in here is not trusted.
export function collectSearchSources(blocks) {
  const sources = new Map();
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    const isResult = node.type === 'web_search_result' || node.type === 'web_search_result_location';
    if (isResult && node.url) {
      const key = normalizeUrl(node.url);
      if (key && !sources.has(key)) {
        sources.set(key, { url: node.url, title: node.title || node.url, pageAge: node.page_age || null });
      }
    }
    Object.values(node).forEach(v => { if (v && typeof v === 'object') visit(v); });
  };
  visit(blocks);
  return sources;
}

function matchSource(url, sourceMap, byPath) {
  const norm = normalizeUrl(url);
  if (!norm) return null;
  return sourceMap.get(norm) || byPath.get(hostAndPath(norm)) || null;
}

const str = (v, max = 400) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// Turns the model's research JSON into the fact base the rest of the engagement uses,
// keeping only facts/competitors whose source URL was really returned by web search.
export function buildResearch(raw, sourceMap, { searchCount = 0 } = {}) {
  const byPath = new Map();
  sourceMap.forEach((v, k) => { const hp = hostAndPath(k); if (!byPath.has(hp)) byPath.set(hp, v); });

  const sources = [];
  const sourceIdByUrl = new Map();
  const idFor = (src) => {
    const key = normalizeUrl(src.url);
    if (!sourceIdByUrl.has(key)) {
      const id = `S${sources.length + 1}`;
      sourceIdByUrl.set(key, id);
      sources.push({ id, title: str(src.title, 200) || src.url, url: src.url, pageAge: src.pageAge || null });
    }
    return sourceIdByUrl.get(key);
  };

  let dropped = 0;
  const seenClaims = new Set();
  const facts = [];
  (Array.isArray(raw?.facts) ? raw.facts : []).forEach(f => {
    const claim = str(f?.claim, 500);
    if (!claim || seenClaims.has(claim.toLowerCase())) return;
    const src = matchSource(f?.source_url, sourceMap, byPath);
    if (!src) { dropped++; return; }
    seenClaims.add(claim.toLowerCase());
    facts.push({ sourceId: idFor(src), category: str(f?.category, 40) || 'general', claim, published: str(f?.published, 40) });
  });

  const competitors = [];
  const seenNames = new Set();
  (Array.isArray(raw?.competitors) ? raw.competitors : []).forEach(c => {
    const name = str(c?.name, 120);
    if (!name || seenNames.has(name.toLowerCase())) return;
    const src = matchSource(c?.source_url, sourceMap, byPath);
    if (!src) { dropped++; return; }
    seenNames.add(name.toLowerCase());
    competitors.push({
      name,
      website: str(c?.website, 200),
      description: str(c?.description, 400),
      pricing: str(c?.pricing, 200) || 'Not disclosed',
      funding: str(c?.funding, 200) || 'Not disclosed',
      sourceId: idFor(src),
    });
  });

  return {
    generatedAt: new Date().toISOString(),
    marketSummary: str(raw?.marketSummary, 1200),
    sources,
    facts,
    competitors,
    gaps: (Array.isArray(raw?.gaps) ? raw.gaps : []).map(g => str(g, 300)).filter(Boolean).slice(0, 10),
    searchCount,
    droppedUnverified: dropped,
  };
}

// Server-side guard for research sent back by the browser: re-validates its shape so a
// tampered or stale object can't inject arbitrary text into prompts.
export function sanitizeResearch(r) {
  if (!r || typeof r !== 'object' || !Array.isArray(r.sources)) return null;
  const sources = r.sources.slice(0, 60)
    .map(s => ({ id: str(s?.id, 6), title: str(s?.title, 200), url: str(s?.url, 500) }))
    .filter(s => /^S\d+$/.test(s.id) && normalizeUrl(s.url));
  const ids = new Set(sources.map(s => s.id));
  return {
    generatedAt: str(r.generatedAt, 40),
    marketSummary: str(r.marketSummary, 1200),
    sources,
    facts: (Array.isArray(r.facts) ? r.facts : []).slice(0, 60)
      .map(f => ({ sourceId: str(f?.sourceId, 6), category: str(f?.category, 40), claim: str(f?.claim, 500), published: str(f?.published, 40) }))
      .filter(f => ids.has(f.sourceId) && f.claim),
    competitors: (Array.isArray(r.competitors) ? r.competitors : []).slice(0, 25)
      .map(c => ({ name: str(c?.name, 120), website: str(c?.website, 200), description: str(c?.description, 400), pricing: str(c?.pricing, 200), funding: str(c?.funding, 200), sourceId: str(c?.sourceId, 6) }))
      .filter(c => c.name && ids.has(c.sourceId)),
    gaps: (Array.isArray(r.gaps) ? r.gaps : []).map(g => str(g, 300)).filter(Boolean).slice(0, 10),
  };
}

export function formatFactBase(research) {
  if (!research || !research.sources?.length) {
    return `VERIFIED FACT BASE: none — live web research is not available for this engagement. Every market size, growth rate, price point and competitor detail you state is your own estimate: mark each such figure "(est.)", and do not cite or invent sources.`;
  }
  const lines = [];
  const date = research.generatedAt ? research.generatedAt.slice(0, 10) : 'recently';
  lines.push(`VERIFIED FACT BASE — gathered by live web search on ${date}. Each source below was actually returned by the search; cite them as [S#].`);
  if (research.marketSummary) lines.push(`\nMarket summary: ${research.marketSummary}`);
  lines.push('\nSOURCES:');
  research.sources.forEach(s => lines.push(`[${s.id}] ${s.title} — ${s.url}`));
  if (research.facts.length) {
    lines.push('\nFACTS:');
    research.facts.forEach(f => lines.push(`- [${f.sourceId}] ${f.claim}${f.published ? ` (published ${f.published})` : ''}`));
  }
  if (research.competitors.length) {
    lines.push('\nVERIFIED COMPETITORS:');
    research.competitors.forEach(c => lines.push(`- ${c.name}${c.website ? ` (${c.website})` : ''} — ${c.description} Pricing: ${c.pricing}. Funding: ${c.funding}. [${c.sourceId}]`));
  }
  if (research.gaps.length) {
    lines.push('\nCOULD NOT BE VERIFIED (treat as unknown; estimate and label "(est.)" if needed):');
    research.gaps.forEach(g => lines.push(`- ${g}`));
  }
  return lines.join('\n');
}

export const CITATION_RULES = `Sourcing rules (non-negotiable):
- When a figure or fact comes from the VERIFIED FACT BASE, cite it inline right after the claim as [S#], e.g. "the segment was worth $3.5B in 2025 [S2]". Use only source IDs listed in the fact base.
- Never invent a source, a URL, a report name, or a citation ID.
- Any figure that is not from the fact base or the financial model is your own estimate: put "(est.)" right after it.
- Only name competitors from the verified competitor list, or ones you are certain exist — mark the latter "(unverified)".`;
