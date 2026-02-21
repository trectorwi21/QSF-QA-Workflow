// QSF Reader — Build AST (v2 — Universal)
// Spec: qsf/parser/SKILL.md in claude-skills repo
// Version: qsf_ast_v2
//
// Input:  $json.qsf (plain object, preferred) OR $json.fileContent (stringified JSON)
//         $json.config (optional): { include_raw: false }
// Output: { ast, indexes, warnings }
//
// Changes from v1:
//   1. Version bumped to qsf_ast_v2
//   2. Input type check uses isObject() — rejects arrays that typeof "object" would accept
//   3. Choices and answers normalized to consistent arrays (handles keyed-object and array formats)
//   4. extensions.raw is opt-in via config.include_raw (defaults false) — reduces AST size at scale
//   5. Flow node extensions capture all unmapped keys dynamically — no hardcoded allowlist
//   6. parseOptionsElement extracts named fields — no longer a raw passthrough

// ─── Utilities ────────────────────────────────────────────────────────────────

function safeJsonParse(str) {
  try {
    return { ok: true, value: JSON.parse(str) };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

function nowIso() {
  return new Date().toISOString();
}

function pushWarn(warnings, code, message, details = {}) {
  warnings.push({ code, message, details, at: nowIso() });
}

// Returns true only for plain objects — excludes arrays, null, primitives
function isObject(x) {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}

// Qualtrics sometimes sends keyed objects with numeric string keys: { "1": {}, "2": {} }
// Returns keys sorted numerically for stable ordering
function sortedNumericKeys(obj) {
  return Object.keys(obj)
    .filter((k) => String(Number(k)) === k)
    .sort((a, b) => Number(a) - Number(b));
}

// ─── AST Scaffold ─────────────────────────────────────────────────────────────

function buildEmptyAst() {
  return {
    version: "qsf_ast_v2",

    meta: {
      survey_id: null,
      survey_name: null,
      survey_owner_id: null,
      survey_brand_id: null,
      survey_language: null,
      survey_created_at: null,
      survey_last_modified_at: null,
      extensions: {},
    },

    definitions: {
      blocks: {},                   // keyed by BL_*
      block_definition_order: [],   // BL_* IDs in parse order
      questions: {},                // keyed by QID*
      question_definition_order: [], // QID* in parse order
    },

    execution: {
      flows: null,                      // normalized flow tree root node
      flow_block_sequence: [],          // BL_* IDs in flow walk order (may repeat for looped blocks)
      blocks_referenced_in_flow: [],    // unique BL_* IDs referenced in flow
      blocks_not_referenced: [],        // BL_* IDs defined but absent from flow
    },

    // Change 6: options now has named fields instead of raw passthrough only
    options: {
      survey_protection: null,      // SO.Payload.SurveyProtection
      partial_completion: null,     // SO.Payload.PartialCompletion
      default_language: null,       // SO.Payload.SurveyLanguage
      available_languages: [],      // SO.Payload.SurveyLanguages (array of codes)
      payload: null,                // full raw SO payload retained for fields not explicitly mapped
      extensions: {},
    },

    unknown_elements: [], // [{element, primary, secondary}] for unrecognized element types
    warnings: [],
  };
}

// ─── Normalization Helpers ─────────────────────────────────────────────────────

// Change 3: Normalize choices from either keyed-object or array format into a consistent array.
// Each choice becomes: { id, text, is_exclusive, extensions }
// choice_order is returned separately — always use it for display ordering, not array position.
function normalizeChoices(raw) {
  if (!raw) return [];

  let entries = [];

  if (Array.isArray(raw)) {
    // Some QSF versions send choices as an array with an ID field on each entry
    entries = raw.map((c, i) => ({
      key: String(c?.ChoiceID ?? c?.id ?? i + 1),
      choice: c,
    }));
  } else if (isObject(raw)) {
    // Most common format: keyed object { "1": { Display: "...", ... }, "2": {...} }
    entries = sortedNumericKeys(raw).map((k) => ({
      key: k,
      choice: raw[k],
    }));
  } else {
    return [];
  }

  return entries.map(({ key, choice }) => {
    // Extract known fields; everything else goes into extensions for forward compatibility
    const { Display, ExclusiveAnswer, ChoiceID, id, ...rest } = choice || {};
    return {
      id: key,
      text: Display ?? null,
      is_exclusive: ExclusiveAnswer === true,
      extensions: Object.keys(rest).length > 0 ? rest : {},
    };
  });
}

// Change 3: Normalize answers (used in Matrix questions) using the same pattern as choices.
// Each answer becomes: { id, text, extensions }
function normalizeAnswers(raw) {
  if (!raw) return [];

  let entries = [];

  if (Array.isArray(raw)) {
    entries = raw.map((a, i) => ({
      key: String(a?.AnswerID ?? a?.id ?? i + 1),
      answer: a,
    }));
  } else if (isObject(raw)) {
    entries = sortedNumericKeys(raw).map((k) => ({
      key: k,
      answer: raw[k],
    }));
  } else {
    return [];
  }

  return entries.map(({ key, answer }) => {
    const { Display, AnswerID, id, ...rest } = answer || {};
    return {
      id: key,
      text: Display ?? null,
      extensions: Object.keys(rest).length > 0 ? rest : {},
    };
  });
}

// ─── Element Parsers ───────────────────────────────────────────────────────────

// Change 5: Flow node extensions now capture ALL unmapped keys dynamically.
// Previously used a hardcoded allowlist which silently dropped unknown keys.
// Now any key not already mapped to a named field is preserved in extensions automatically.
const FLOW_NODE_NAMED_KEYS = new Set(["Type", "ID", "FlowID", "Description", "Flow"]);

function normalizeFlowNode(node) {
  const out = {
    type: node?.Type ?? null,
    id: node?.ID ?? null,
    flow_id: node?.FlowID ?? null,
    description: node?.Description ?? null,
    condition: null, // KNOWN GAP: BranchLogic/LogicV2 captured in extensions but not yet parsed
                     // into a structured condition object. Downstream code needing branch evaluation
                     // should read extensions.BranchLogic directly. A future parser version will
                     // normalize this field. See skill spec: qsf/parser/SKILL.md
    children: [],
    extensions: {},
  };

  // Capture all keys not already mapped to named fields above
  if (node && isObject(node)) {
    for (const k of Object.keys(node)) {
      if (!FLOW_NODE_NAMED_KEYS.has(k)) {
        out.extensions[k] = node[k];
      }
    }
  }

  const flowArr = Array.isArray(node?.Flow) ? node.Flow : [];
  out.children = flowArr.map(normalizeFlowNode);

  return out;
}

function walkFlowTree(root, knownBlockIdsSet) {
  const sequence = [];
  const referencedSet = new Set();

  function visit(n) {
    if (!n) return;
    if (n.id && knownBlockIdsSet.has(n.id)) {
      sequence.push(n.id);
      if (!referencedSet.has(n.id)) referencedSet.add(n.id);
    }
    if (Array.isArray(n.children)) {
      for (const c of n.children) visit(c);
    }
  }

  visit(root);

  return {
    flow_block_sequence: sequence,
    blocks_referenced_in_flow: Array.from(referencedSet),
  };
}

function parseBlocksElement(elem, ast, warnings) {
  const payload = elem?.Payload;
  let blocks = [];

  if (Array.isArray(payload)) {
    blocks = payload;
  } else if (isObject(payload)) {
    const keys = sortedNumericKeys(payload);
    blocks = keys.map((k) => payload[k]);
  } else {
    pushWarn(warnings, "BL_PAYLOAD_MISSING", "Blocks element payload is missing or invalid.", {
      element: "BL",
    });
    return;
  }

  for (const b of blocks) {
    const id = b?.ID;
    if (!id || typeof id !== "string") {
      pushWarn(warnings, "BL_MISSING_ID", "A block in BL payload is missing an ID.", { block: b });
      continue;
    }

    const blockElements = Array.isArray(b?.BlockElements) ? b.BlockElements : [];
    const questionRefs = [];

    for (const be of blockElements) {
      if (be?.Type === "Question" && be?.QuestionID) {
        questionRefs.push(String(be.QuestionID));
      }
    }

    ast.definitions.blocks[id] = {
      id,
      description: b?.Description ?? null,
      type: b?.Type ?? null,
      subtype: b?.SubType ?? null,
      question_refs: questionRefs,
      options: b?.Options ?? null,
      extensions: {},
    };

    ast.definitions.block_definition_order.push(id);
  }
}

// Changes 3 and 4: choices/answers now normalized; raw storage is opt-in via config
function parseQuestionElement(elem, ast, config) {
  const qid = elem?.PrimaryAttribute;
  const payload = elem?.Payload || {};

  if (!qid) return;

  // Change 4: Only store raw payload if explicitly requested — reduces AST size at scale
  const extensions = { include_raw: config.include_raw === true };
  if (config.include_raw === true) {
    extensions.raw = payload;
  }

  ast.definitions.questions[qid] = {
    id: qid,
    question_type: payload?.QuestionType ?? null,
    selector: payload?.Selector ?? null,
    sub_selector: payload?.SubSelector ?? null,
    data_export_tag: payload?.DataExportTag ?? null,
    question_text: payload?.QuestionText ?? null,
    question_description: payload?.QuestionDescription ?? null,

    // Change 3: normalized arrays regardless of source format
    choices: normalizeChoices(payload?.Choices),
    choice_order: Array.isArray(payload?.ChoiceOrder)
      ? payload.ChoiceOrder.map(String)
      : isObject(payload?.ChoiceOrder)
      ? sortedNumericKeys(payload.ChoiceOrder)
      : [],
    answers: normalizeAnswers(payload?.Answers),
    answer_order: Array.isArray(payload?.AnswerOrder)
      ? payload.AnswerOrder.map(String)
      : isObject(payload?.AnswerOrder)
      ? sortedNumericKeys(payload.AnswerOrder)
      : [],

    display_logic: payload?.DisplayLogic ?? null,
    in_page_display_logic: payload?.InPageDisplayLogic ?? null,
    validation: payload?.Validation ?? null,
    language: payload?.Language ?? null,

    extensions,
  };

  ast.definitions.question_definition_order.push(qid);
}

// Change 6: Extract named option fields — no longer just a raw passthrough
function parseOptionsElement(elem, ast) {
  const p = elem?.Payload ?? null;

  ast.options.survey_protection = p?.SurveyProtection ?? null;
  ast.options.partial_completion = p?.PartialCompletion ?? null;
  ast.options.default_language = p?.SurveyLanguage ?? null;
  ast.options.available_languages = Array.isArray(p?.SurveyLanguages)
    ? p.SurveyLanguages
    : [];

  // Retain full payload so fields not explicitly mapped above are still accessible
  ast.options.payload = p;
}

function buildMeta(qsf, ast) {
  const se = qsf?.SurveyEntry || {};
  ast.meta.survey_id = se?.SurveyID ?? null;
  ast.meta.survey_name = se?.SurveyName ?? null;
  ast.meta.survey_owner_id = se?.SurveyOwnerID ?? null;
  ast.meta.survey_brand_id = se?.SurveyBrandID ?? null;
  ast.meta.survey_language = se?.SurveyLanguage ?? null;
  ast.meta.survey_created_at = se?.SurveyCreationDate ?? null;
  ast.meta.survey_last_modified_at = se?.LastModified ?? null;
}

function computeBlocksNotReferenced(ast) {
  const all = new Set(Object.keys(ast.definitions.blocks || {}));
  const referenced = new Set(ast.execution.blocks_referenced_in_flow || []);
  const notRef = [];

  for (const id of all) {
    if (!referenced.has(id)) notRef.push(id);
  }

  const order = ast.definitions.block_definition_order || [];
  notRef.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  ast.execution.blocks_not_referenced = notRef;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const input = $input.all();
if (!Array.isArray(input) || input.length === 0) {
  return [{ json: { error: "No input items received." } }];
}

const first = input[0]?.json || {};

// Config with safe defaults — can be passed in via $json.config
const config = {
  include_raw: false,
  ...(isObject(first.config) ? first.config : {}),
};

const ast = buildEmptyAst();
let qsf = null;

// Change 2: Use isObject() — rejects arrays that would pass typeof === "object"
if (isObject(first.qsf)) {
  qsf = first.qsf;
} else if (typeof first.fileContent === "string") {
  const parsed = safeJsonParse(first.fileContent);
  if (!parsed.ok) {
    pushWarn(ast.warnings, "QSF_JSON_PARSE_FAIL", "Unable to parse QSF JSON from fileContent.", {
      error: parsed.error,
    });
    return [{
      json: {
        ast,
        warnings: ast.warnings,
        indexes: { blocks: 0, questions: 0, hasFlow: false, hasOptions: false, unknownElements: 0 },
      },
    }];
  }
  qsf = parsed.value;
} else {
  return [{
    json: {
      error: "Expected either `qsf` plain object or `fileContent` string on the first input item.",
      gotKeys: Object.keys(first),
      fileContentType: typeof first.fileContent,
      qsfType: typeof first.qsf,
      qsfIsArray: Array.isArray(first.qsf),
    },
  }];
}

buildMeta(qsf, ast);

const elements = Array.isArray(qsf?.SurveyElements) ? qsf.SurveyElements : [];
if (!Array.isArray(qsf?.SurveyElements)) {
  pushWarn(ast.warnings, "QSF_SURVEYELEMENTS_MISSING", "SurveyElements is missing or not an array.");
}

let flowElem = null;

for (const elem of elements) {
  const type = elem?.Element;

  if (type === "BL") {
    parseBlocksElement(elem, ast, ast.warnings);
  } else if (type === "SQ") {
    parseQuestionElement(elem, ast, config);
  } else if (type === "SO") {
    parseOptionsElement(elem, ast);
  } else if (type === "FL") {
    if (!flowElem) {
      flowElem = elem;
    } else {
      pushWarn(ast.warnings, "MULTIPLE_FLOW_ELEMENTS", "Multiple FL elements found; using the first.", {
        ignoredFlowPrimaryAttribute: elem?.PrimaryAttribute ?? null,
      });
    }
  } else {
    ast.unknown_elements.push({
      element: type ?? null,
      primary: elem?.PrimaryAttribute ?? null,
      secondary: elem?.SecondaryAttribute ?? null,
    });
  }
}

if (!flowElem?.Payload) {
  pushWarn(ast.warnings, "FLOW_MISSING", "No Survey Flow (FL) element payload found.");
} else {
  const root = normalizeFlowNode(flowElem.Payload);
  ast.execution.flows = root;

  const knownBlocks = new Set(Object.keys(ast.definitions.blocks || {}));
  const reach = walkFlowTree(root, knownBlocks);

  ast.execution.flow_block_sequence = reach.flow_block_sequence;
  ast.execution.blocks_referenced_in_flow = reach.blocks_referenced_in_flow;
}

computeBlocksNotReferenced(ast);

// Cross-reference: flag blocks that reference QIDs not found in parsed questions
for (const [blockId, block] of Object.entries(ast.definitions.blocks || {})) {
  const missing = [];
  for (const qid of block.question_refs || []) {
    if (!ast.definitions.questions[qid]) missing.push(qid);
  }
  if (missing.length) {
    pushWarn(ast.warnings, "BLOCK_HAS_UNKNOWN_QIDS",
      "Block references question IDs not found in SQ elements.", {
        blockId,
        missingQids: missing,
      });
  }
}

const indexes = {
  blocks: Object.keys(ast.definitions.blocks || {}).length,
  questions: Object.keys(ast.definitions.questions || {}).length,
  hasFlow: !!ast.execution.flows,
  hasOptions: !!ast.options.payload,
  unknownElements: ast.unknown_elements.length,
};

return [{ json: { ast, warnings: ast.warnings, indexes } }];
