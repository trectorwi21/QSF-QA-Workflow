// QSF Reader — Build AST (v2) - FIXED
// Input: prefers $json.qsf (object) OR $json.fileContent (stringified QSF JSON)
// Output: { ast, indexes, warnings }

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
  warnings.push({
    code,
    message,
    details,
    at: nowIso(),
  });
}

function isObject(x) {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}

function buildEmptyAst() {
  // Minimal AST aligned with your schema intent:
  // meta, definitions, execution, options, unknown_elements, warnings
  return {
    version: "qsf_ast_v1",
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
      blocks: {}, // key: BL_*
      block_definition_order: [], // in the order encountered in BL payload
      questions: {}, // key: QID*
      question_definition_order: [],
    },
    execution: {
      flows: null, // normalized flow tree
      flow_block_sequence: [], // ordered as encountered in flow walk
      blocks_referenced_in_flow: [], // unique, stable order based on first encounter
      blocks_not_referenced: [], // computed later
    },
    options: {
      payload: null,
      extensions: {},
    },
    unknown_elements: [], // elements we didn't explicitly parse
    warnings: [],
  };
}

// Qualtrics blocks payload is usually an object with numeric keys: { "0": {...}, "1": {...}, ... }
function sortedNumericKeys(obj) {
  return Object.keys(obj)
    .filter((k) => String(Number(k)) === k)
    .sort((a, b) => Number(a) - Number(b));
}

function normalizeFlowNode(node) {
  // We normalize but preserve raw content in extensions for evidence.
  const out = {
    type: node?.Type ?? null,
    id: node?.ID ?? null,
    flow_id: node?.FlowID ?? null,
    description: node?.Description ?? null,
    condition: null, // branch logic etc (kept in extensions)
    children: [],
    extensions: {},
  };

  // Keep important raw details without bloating too much
  const keep = ["EmbeddedData", "BranchLogic", "Logic", "LogicV2", "Autofill", "Properties"];
  for (const k of keep) {
    if (node && Object.prototype.hasOwnProperty.call(node, k)) {
      out.extensions[k] = node[k];
    }
  }

  // Flow children
  const flowArr = Array.isArray(node?.Flow) ? node.Flow : [];
  out.children = flowArr.map(normalizeFlowNode);

  return out;
}

function walkFlowTree(root, knownBlockIdsSet) {
  const sequence = [];
  const referencedSet = new Set();

  function visit(n) {
    if (!n) return;
    // Critical rule: reference is by node.id matching known block ID (BL_*)
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
  
  // Handle both array and object formats
  let blocks = [];
  
  if (Array.isArray(payload)) {
    // New format: payload is an array
    blocks = payload;
  } else if (isObject(payload)) {
    // Old format: payload is an object with numeric keys
    const keys = sortedNumericKeys(payload);
    blocks = keys.map(k => payload[k]);
  } else {
    pushWarn(warnings, "BL_PAYLOAD_MISSING", "Blocks element payload is missing or invalid.", {
      element: "BL",
    });
    return;
  }

  // Now process blocks array uniformly
  for (const b of blocks) {
    const id = b?.ID;
    if (!id || typeof id !== "string") {
      pushWarn(warnings, "BL_MISSING_ID", "A block in BL payload is missing an ID.", {
        block: b
      });
      continue;
    }

    const blockElements = Array.isArray(b?.BlockElements) ? b.BlockElements : [];
    const questionRefs = [];

    for (const be of blockElements) {
      // Only collect question references
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

function parseQuestionElement(elem, ast) {
  const qid = elem?.PrimaryAttribute;
  const payload = elem?.Payload || {};

  if (!qid) return;

  // Some QSFs use different shapes for Choices (array vs object).
  // Keep them in extensions; downstream logic-check branches can normalize further.
  ast.definitions.questions[qid] = {
    id: qid,
    question_type: payload?.QuestionType ?? null,
    selector: payload?.Selector ?? null,
    sub_selector: payload?.SubSelector ?? null,
    data_export_tag: payload?.DataExportTag ?? null,
    question_text: payload?.QuestionText ?? null,
    question_description: payload?.QuestionDescription ?? null,
    choices: payload?.Choices ?? null,
    choice_order: payload?.ChoiceOrder ?? null,
    answers: payload?.Answers ?? null,
    answer_order: payload?.AnswerOrder ?? null,
    display_logic: payload?.DisplayLogic ?? null,
    in_page_display_logic: payload?.InPageDisplayLogic ?? null,
    validation: payload?.Validation ?? null,
    language: payload?.Language ?? null,
    extensions: {
      raw: payload,
    },
  };

  ast.definitions.question_definition_order.push(qid);
}

function parseOptionsElement(elem, ast) {
  ast.options.payload = elem?.Payload ?? null;
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
  // stable order: follow block_definition_order
  const order = ast.definitions.block_definition_order || [];
  notRef.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  ast.execution.blocks_not_referenced = notRef;
}

// ---- Main ----
const input = $input.all();
if (!Array.isArray(input) || input.length === 0) {
  return [{ json: { error: "No input items received." } }];
}

const first = input[0]?.json || {};
const ast = buildEmptyAst();

// Accept either a pre-parsed QSF object (preferred) OR a stringified QSF in fileContent
let qsf = null;

if (first.qsf && typeof first.qsf === "object") {
  qsf = first.qsf;
} else if (typeof first.fileContent === "string") {
  const parsed = safeJsonParse(first.fileContent);
  if (!parsed.ok) {
    pushWarn(ast.warnings, "QSF_JSON_PARSE_FAIL", "Unable to parse QSF JSON from fileContent.", {
      error: parsed.error,
    });

    return [
      {
        json: {
          ast,
          warnings: ast.warnings,
          indexes: {
            blocks: 0,
            questions: 0,
            hasFlow: false,
            hasOptions: false,
            unknownElements: 0,
          },
        },
      },
    ];
  }
  qsf = parsed.value;
} else {
  return [
    {
      json: {
        error: "Expected either `qsf` object or `fileContent` string on the first input item.",
        gotKeys: Object.keys(first),
        fileContentType: typeof first.fileContent,
        qsfType: typeof first.qsf,
      },
    },
  ];
}

buildMeta(qsf, ast);

const elements = Array.isArray(qsf?.SurveyElements) ? qsf.SurveyElements : [];
if (!Array.isArray(qsf?.SurveyElements)) {
  pushWarn(ast.warnings, "QSF_SURVEYELEMENTS_MISSING", "SurveyElements is missing or not an array.");
}

// Partition elements
let flowElem = null;

for (const elem of elements) {
  const type = elem?.Element;

  if (type === "BL") {
    parseBlocksElement(elem, ast, ast.warnings);
  } else if (type === "SQ") {
    parseQuestionElement(elem, ast);
  } else if (type === "SO") {
    parseOptionsElement(elem, ast);
  } else if (type === "FL") {
    // Prefer the first FL; if multiple exist, warn and keep first
    if (!flowElem) flowElem = elem;
    else {
      pushWarn(ast.warnings, "MULTIPLE_FLOW_ELEMENTS", "Multiple FL elements found; using the first.", {
        ignoredFlowPrimaryAttribute: elem?.PrimaryAttribute ?? null,
      });
    }
  } else {
    // Store unknown for forward compatibility (but keep it light)
    ast.unknown_elements.push({
      element: type ?? null,
      primary: elem?.PrimaryAttribute ?? null,
      secondary: elem?.SecondaryAttribute ?? null,
    });
  }
}

// Parse flow into normalized tree
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

// Cross-reference: blocks contain QIDs that might not exist in SQ
for (const [blockId, block] of Object.entries(ast.definitions.blocks || {})) {
  const missing = [];
  for (const qid of block.question_refs || []) {
    if (!ast.definitions.questions[qid]) missing.push(qid);
  }
  if (missing.length) {
    pushWarn(ast.warnings, "BLOCK_HAS_UNKNOWN_QIDS", "Block references question IDs not found in SQ elements.", {
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

return [
  {
    json: {
      ast,
      warnings: ast.warnings,
      indexes,
    },
  },
];