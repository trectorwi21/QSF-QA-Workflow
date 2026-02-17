// =====================================
// Branch A: Spell Check (Standardized Output v3.0)
// Uses external dictionary via HTTP Request
// Outputs standardized format matching B1/B3
// =====================================

const all = $input.all();

// -------------------------
// Extract dictionary text from the merged items
// -------------------------
const dictItem = all.find(it => it.json && typeof it.json.dictionaryText === 'string');
const dictionaryText = dictItem?.json?.dictionaryText || '';

if (!dictionaryText) {
  return [{
    json: {
      status: "Fail",
      priority: "P0",
      branch: "A",
      check: "Spell Check",
      element: "System",
      path: "Dictionary Load",
      issue: "Failed to load spell check dictionary",
      details: "No dictionaryText found. Ensure HTTP Request node outputs dictionaryText and Merge mode combines both streams (Append works).",
      timestamp: new Date().toISOString()
    }
  }];
}

// Only question rows (A1) have QID
const questionItems = all.filter(it => it.json && it.json.QID);

// -------------------------
// Helpers: string
// -------------------------
function toStr(x) {
  if (x === null || x === undefined) return "";
  return String(x);
}

// -------------------------
// Build dictionary set + small index for suggestions
// -------------------------
function normalizeWord(w) {
  let x = String(w || '').toLowerCase();
  x = x.replace(/[""]/g, '"').replace(/[']/g, "'");
  x = x.replace(/^['\-]+|['\-]+$/g, "");
  x = x.replace(/'s$/g, ""); // possessive
  return x;
}

const dictWords = dictionaryText
  .split(/\r?\n/)
  .map(s => s.trim())
  .filter(Boolean)
  .map(normalizeWord);

// set for fast lookup
const DICT = new Set(dictWords);

// -------------------------
// Allowlist overlay (healthcare-specific terms)
// -------------------------
const ALLOWLIST = new Set([
  "sanitizer",
  "telehealth",
  "caregiver",
  "healthcare",
  "inpatient",
  "outpatient",
  "covid",
  "followup",
  "qualtrics"
]);

// index by first letter + length to keep suggestions fast
const BUCKETS = new Map();
function bucketKey(word) {
  const w = normalizeWord(word);
  const first = w[0] || '';
  return `${first}|${w.length}`;
}
for (const w of dictWords) {
  const key = bucketKey(w);
  if (!BUCKETS.has(key)) BUCKETS.set(key, []);
  BUCKETS.get(key).push(w);
}

// -------------------------
// Helpers: cleaning + tokenization
// -------------------------
function stripHtml(s) {
  return toStr(s).replace(/<[^>]+>/g, " ");
}

function stripPipedTextTokens(s) {
  return toStr(s).replace(/\$\{[^}]+\}/g, " ");
}

function cleanText(s) {
  return stripPipedTextTokens(stripHtml(s))
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractChoiceTextOnly(choiceStr) {
  const s = toStr(choiceStr);
  if (!s) return "";
  const parts = s.split("||").map(p => p.trim()).filter(Boolean);

  const texts = parts.map(p => {
    let x = p.replace(/^Rows:\s*/i, "").replace(/^Columns:\s*/i, "");
    x = x.replace(/^\s*[^:]{1,10}:\s*/, "");
    x = x.replace(/\s*\|\s*[-]?\d+(\.\d+)?\s*$/g, "");
    return x.trim();
  });

  return texts.join(" ");
}

function tokenizeWords(s) {
  const cleaned = toStr(s)
    .replace(/[^a-zA-Z'\- ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned ? cleaned.split(" ").filter(Boolean) : [];
}

function shouldIgnoreRawWord(raw) {
  if (!raw) return true;
  if (/^\d+$/.test(raw)) return true;
  if (/^[A-Z]{3,}$/.test(raw)) return true;

  const n = normalizeWord(raw);
  if (!n) return true;
  if (n.length < 3) return true;

  // ignore qualtrics-ish placeholders
  if (n === "click" || n === "write") return true;

  return false;
}

// -------------------------
// Hyphenated word handling
// -------------------------
function isHyphenWordValid(rawWord) {
  const raw = toStr(rawWord);
  if (!raw.includes("-")) return false;

  const whole = normalizeWord(raw);
  if (DICT.has(whole) || ALLOWLIST.has(whole)) return true;

  const parts = raw
    .split("-")
    .map(p => normalizeWord(p))
    .filter(Boolean);

  if (parts.length < 2) return false;

  return parts.every(p => DICT.has(p) || ALLOWLIST.has(p));
}

// -------------------------
// Levenshtein for suggestions
// -------------------------
function levenshtein(a, b) {
  a = normalizeWord(a);
  b = normalizeWord(b);
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;

  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[j] = Math.min(
        dp[j] + 1,
        dp[j - 1] + 1,
        prev + cost
      );
      prev = tmp;
    }
  }
  return dp[n];
}

function suggest(word, maxSuggestions = 3) {
  const w = normalizeWord(word);
  if (!w) return [];

  const candidates = [];
  for (let delta = -1; delta <= 1; delta++) {
    const key = `${w[0] || ''}|${w.length + delta}`;
    const list = BUCKETS.get(key);
    if (list && list.length) candidates.push(...list);
  }

  if (!candidates.length) {
    for (let delta = -2; delta <= 2; delta++) {
      const key = `${w[0] || ''}|${w.length + delta}`;
      const list = BUCKETS.get(key);
      if (list && list.length) candidates.push(...list);
    }
  }

  const scored = candidates
    .map(c => ({ c, d: levenshtein(w, c) }))
    .sort((x, y) => x.d - y.d || x.c.localeCompare(y.c));

  const threshold = w.length <= 5 ? 1 : 2;

  return scored
    .filter(x => x.d <= threshold)
    .slice(0, maxSuggestions)
    .map(x => x.c);
}

function findMisspellingsWithSuggestions(text) {
  const words = tokenizeWords(text);
  const misses = [];

  for (const raw of words) {
    if (shouldIgnoreRawWord(raw)) continue;

    const w = normalizeWord(raw);
    if (ALLOWLIST.has(w)) continue;

    if (raw.includes("-") && isHyphenWordValid(raw)) continue;

    if (!DICT.has(w)) {
      misses.push({
        word: raw,
        normalized: w,
        suggestions: suggest(w, 3)
      });
    }
  }

  const seen = new Set();
  return misses.filter(m => {
    if (seen.has(m.normalized)) return false;
    seen.add(m.normalized);
    return true;
  });
}

// -------------------------
// Helper: Create standardized result object
// -------------------------
function createResult(status, priority, qid, label, field, issue, details) {
  return {
    status: status,
    priority: priority,
    branch: "A",
    check: "Spell Check",
    element: `Question:${qid}`,
    path: label || field,
    issue: issue,
    details: details,
    sheetName: status === "Pass" ? "Full Checklist" : "Action Items",
    timestamp: new Date().toISOString()
  };
}

// -------------------------
// Build standardized results
// -------------------------
const results = [];

for (const it of questionItems) {
  const q = it.json || {};
  const qid = toStr(q.QID);
  const label = toStr(q.Label);

  const labelClean = cleanText(label);
  const choicesClean = cleanText(extractChoiceTextOnly(q["Answer Choices (ChoiceID: Text | recode)"]));

  // Check label
  const labelMiss = findMisspellingsWithSuggestions(labelClean);
  if (labelMiss.length) {
    const misspellings = labelMiss
      .map(m => `"${m.word}" (suggestions: ${m.suggestions.join(', ') || 'none'})`)
      .join('; ');
    
    results.push(createResult(
      "Fail",
      "P3",
      qid,
      label.substring(0, 100) + (label.length > 100 ? '...' : ''),
      "Label",
      `Spelling errors detected in question text`,
      `Found ${labelMiss.length} potential misspelling(s): ${misspellings}. Context: "${labelClean.substring(0, 150)}${labelClean.length > 150 ? '...' : ''}"`
    ));
  } else if (labelClean) {
    // Pass result for question text
    results.push(createResult(
      "Pass",
      "P3",
      qid,
      label.substring(0, 100) + (label.length > 100 ? '...' : ''),
      "Label",
      "No spelling errors detected in question text",
      `Question text validated against dictionary (${labelClean.split(' ').length} words checked)`
    ));
  }

  // Check choices
  const choiceMiss = findMisspellingsWithSuggestions(choicesClean);
  if (choiceMiss.length) {
    const misspellings = choiceMiss
      .map(m => `"${m.word}" (suggestions: ${m.suggestions.join(', ') || 'none'})`)
      .join('; ');
    
    results.push(createResult(
      "Fail",
      "P3",
      qid,
      label.substring(0, 100) + (label.length > 100 ? '...' : ''),
      "Answer Choices",
      `Spelling errors detected in answer choices`,
      `Found ${choiceMiss.length} potential misspelling(s): ${misspellings}. Context: "${choicesClean.substring(0, 150)}${choicesClean.length > 150 ? '...' : ''}"`
    ));
  } else if (choicesClean) {
    // Pass result for choices
    results.push(createResult(
      "Pass",
      "P3",
      qid,
      label.substring(0, 100) + (label.length > 100 ? '...' : ''),
      "Answer Choices",
      "No spelling errors detected in answer choices",
      `Answer choices validated against dictionary (${choicesClean.split(' ').length} words checked)`
    ));
  }
}

// Return results
return results;