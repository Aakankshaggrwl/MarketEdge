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

// Repairs the most common way model-written JSON goes wrong: a quotation mark inside a
// text value that wasn't escaped (e.g. a rationale quoting the client's brief — `the brief
// says "we need 10 clients" by Q2`), plus raw newlines/tabs inside strings. Walks the text
// tracking whether each string is an object key, an object value or an array item, and
// treats a `"` as the closing quote only when what follows could legally come next in that
// position; any other inner quote gets escaped.
export function repairInnerQuotes(text) {
  const stack = [];
  let expectKey = false;
  let out = '';
  let role = null; // 'key' | 'value' | 'item' while inside a string, else null

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (role === null) {
      if (ch === '"') role = stack.at(-1) === '[' ? 'item' : expectKey ? 'key' : 'value';
      else if (ch === '{') { stack.push('{'); expectKey = true; }
      else if (ch === '[') stack.push('[');
      else if (ch === '}' || ch === ']') { stack.pop(); expectKey = false; }
      else if (ch === ':') expectKey = false;
      else if (ch === ',') expectKey = stack.at(-1) === '{';
      out += ch;
      continue;
    }
    if (ch === '\\') {
      out += ch + (text[i + 1] ?? '');
      i++;
      continue;
    }
    if (ch === '"') {
      if (closesString(text, i + 1, role)) { role = null; out += ch; } else out += '\\"';
      continue;
    }
    if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (ch < ' ') out += ' ';
    else out += ch;
  }
  return out;
}

// Whether a quote at `from - 1` can close a string in this position: a key must be followed
// by `:`; an object value by `}` or `,` and then the next `"key":`; an array item by `]` or
// `,` and then the start of another value.
function closesString(text, from, role) {
  const rest = text.slice(from);
  if (/^\s*$/.test(rest)) return true;
  if (role === 'key') return /^\s*:/.test(rest);
  if (role === 'value') return /^\s*(\}|,\s*"[^"\\]*"\s*:)/.test(rest);
  return /^\s*(\]|,\s*["{\[\-0-9tfn])/.test(rest);
}

// Drops any prose the model wrote before the opening brace (common after tool use, e.g.
// "Based on my research, here is the JSON:").
function sliceFromFirstBrace(text) {
  const start = text.indexOf('{');
  return start > 0 ? text.slice(start) : text;
}

// Parses model-written JSON, trying progressively more invasive repairs: as-is, with
// whitespace collapsed, with unescaped inner quotes fixed, then with a cut-off tail closed.
export function safeParseJSON(text) {
  const clean = sliceFromFirstBrace(text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim());
  const normalized = () => clean.replace(/[\r\n]/g, " ").replace(/\s+/g, " ");
  const requoted = () => repairInnerQuotes(clean);
  const attempts = [
    () => clean,
    normalized,
    requoted,
    () => repairTruncatedJSON(requoted()),
    () => repairTruncatedJSON(normalized()),
  ];

  let firstError;
  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt());
    } catch (err) {
      firstError ??= err;
    }
  }
  console.error("JSON content preview:", text.substring(0, 500));
  throw new Error(`JSON parsing failed: ${firstError.message}`);
}
