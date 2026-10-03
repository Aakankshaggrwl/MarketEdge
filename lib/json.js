// Repairs JSON that was cut off mid-response (e.g. hit the token limit while writing a
// long array of objects): walks the string tracking bracket/string depth, drops whatever
// trailing fragment never closed (an unterminated string, a dangling key with no value,
// a half-started object), then closes every bracket that was still open. The caller is
// responsible for discarding any resulting empty/incomplete trailing entry.
export function repairTruncatedJSON(text) {
  function scan(str) {
    const stack = [];
    let inString = false;
    let escapeNext = false;
    for (const ch of str) {
      if (escapeNext) { escapeNext = false; continue; }
      if (ch === '\\' && inString) { escapeNext = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{' || ch === '[') stack.push(ch);
      else if (ch === '}' || ch === ']') stack.pop();
    }
    return { stack, inString };
  }

  let s = text;
  if (scan(s).inString) {
    s = s.slice(0, s.lastIndexOf('"'));
  }

  let prev;
  do {
    prev = s;
    s = s.replace(/\s+$/, '');
    if (s.endsWith(',')) {
      s = s.slice(0, -1);
      continue;
    }
    if (s.endsWith(':')) {
      s = s.slice(0, -1).replace(/\s+$/, '');
      const keyMatch = s.match(/"(?:[^"\\]|\\.)*"$/);
      if (keyMatch) s = s.slice(0, s.length - keyMatch[0].length);
      continue;
    }
  } while (s !== prev);

  const { stack } = scan(s);
  let closing = '';
  for (let i = stack.length - 1; i >= 0; i--) {
    closing += stack[i] === '{' ? '}' : ']';
  }
  return s + closing;
}

// Drops any prose the model wrote before the opening brace (common after tool use, e.g.
// "Based on my research, here is the JSON:").
function sliceFromFirstBrace(text) {
  const start = text.indexOf('{');
  return start > 0 ? text.slice(start) : text;
}

export function safeParseJSON(text) {
  try {
    let clean = sliceFromFirstBrace(text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim());

    try {
      return JSON.parse(clean);
    } catch (e1) {
      const normalized = clean.replace(/[\r\n]/g, " ").replace(/\s+/g, " ");
      try {
        return JSON.parse(normalized);
      } catch (e2) {
        // Try truncation repair on the still-clean text before the more destructive
        // fallbacks below get a chance to mangle the quote structure.
        try {
          return JSON.parse(repairTruncatedJSON(normalized));
        } catch (eRepair) {
          let escaped = normalized.replace(/([^\\])"/g, '$1\\"').replace(/^"/, '\\"');
          try {
            return JSON.parse(escaped);
          } catch (e3) {
            const match = escaped.match(/\{[\s\S]*\}(?=\s*$)/);
            if (match) {
              try {
                return JSON.parse(match[0]);
              } catch (e4) {
                let jsonStr = match[0];
                jsonStr = jsonStr.replace(/: "([^"]*$)/g, ': ""');
                return JSON.parse(jsonStr);
              }
            }
            throw e2;
          }
        }
      }
    }
  } catch (err) {
    console.error("JSON content preview:", text.substring(0, 500));
    throw new Error(`JSON parsing failed: ${err.message}`);
  }
}
