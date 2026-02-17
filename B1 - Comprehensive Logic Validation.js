// Branch B - Check 1: Comprehensive Logic Validation
// Input: item (from n8n - the full input object with FlowData and Questions)

const input = $input.item.json;
const flowData = input.FlowData;
const questions = input.Questions;
const results = [];

// Helper function to create result objects
function createResult(status, priority, element, issue, details, stage) {
  return {
    status: status,
    priority: priority,
    branch: "B",
    check: "Survey Flow",
    element: `${element.type}:${element.flow_id}`,
    path: element.description || element.type,
    stage: stage,
    issue: issue,
    details: details,
    timestamp: new Date().toISOString()
  };
}

// Helper to parse choice locators
function parseChoiceLocator(locator) {
  if (!locator || typeof locator !== 'string') return null;
  
  const match = locator.match(/q:\/\/([^\/]+)\/SelectableChoice\/(.+)/);
  if (match) {
    return {
      questionId: match[1],
      choiceId: match[2]
    };
  }
  
  // Match special operators (IsPassive, IsPromoter, IsDetractor)
  const specialMatch = locator.match(/q:\/\/([^\/]+)\/(IsPassive|IsPromoter|IsDetractor)/);
  if (specialMatch) {
    return {
      questionId: specialMatch[1],
      choiceId: null,
      isSpecialOperator: true,
      operator: specialMatch[2]
    };
  }
  
  return null;
}

// Check if a question type allows multiple selections
function isMultiSelectQuestion(question) {
  if (!question) return false;
  
  const type = question.question_type;
  const selector = question.selector;
  
  // Matrix questions depend on SubSelector
  if (type === 'Matrix') {
    const subSelector = question.sub_selector;
    return subSelector === 'MultipleAnswer';
  }
  
  // Single-select selectors
  const singleSelectSelectors = ['SAVR', 'SAHR', 'NPS', 'DL', 'SACOL', 'MAHR'];
  
  if (type === 'MC' && selector && singleSelectSelectors.includes(selector)) {
    return false;
  }
  
  // Multi-select selectors
  if (selector === 'MAVR' || selector === 'MACOL') {
    return true;
  }
  
  // Default for MC is single-select
  if (type === 'MC') {
    return false;
  }
  
  return true; // Assume safe for unknown types
}

// Helper to validate if a choice exists in a question
function validateChoice(questionId, choiceId, questions) {
  const question = questions[questionId];
  if (!question) return { exists: false, reason: "Question does not exist" };
  
  // For special operators, validate they're on NPS questions
  if (choiceId === null) {
    if (question.question_type === 'MC' && question.selector === 'NPS') {
      return { exists: true };
    } else {
      return { 
        exists: false, 
        reason: `Special NPS operator used on non-NPS question (type: ${question.question_type})`
      };
    }
  }
  
  const qType = question.question_type;
  
  // Check choice_order array
  if (question.choice_order && Array.isArray(question.choice_order)) {
    const choiceExists = question.choice_order.some(id => String(id) === String(choiceId));
    if (choiceExists) {
      return { exists: true };
    }
  }
  
  // Check choices object
  if (question.choices) {
    if (question.choices[choiceId]) {
      return { exists: true };
    }
    // Check array-based choices (NPS)
    if (Array.isArray(question.choices) && parseInt(choiceId) < question.choices.length) {
      return { exists: true };
    }
  }
  
  return { 
    exists: false, 
    reason: `Choice '${choiceId}' not found in question ${questionId} (type: ${qType})`
  };
}

// Recursively find Expression objects with actual logic
function findExpressions(obj, found = []) {
  if (typeof obj !== 'object' || obj === null) {
    return found;
  }
  
  if (obj.Type === 'Expression' && obj.Operator) {
    found.push(obj);
  }
  
  for (const key in obj) {
    if (typeof obj[key] === 'object') {
      findExpressions(obj[key], found);
    }
  }
  
  return found;
}

// Check if logic has AND conjunctions
function hasAndConjunctions(logicObj) {
  if (typeof logicObj !== 'object' || logicObj === null) {
    return false;
  }
  
  if (logicObj.Conjuction === 'And') {
    return true;
  }
  
  for (const key in logicObj) {
    if (typeof logicObj[key] === 'object') {  // ← FIXED: was obj[key]
      if (hasAndConjunctions(logicObj[key])) {
        return true;
      }
    }
  }
  
  return false;
}

// Extract conditions grouped by question
function extractConditions(logicObj, conditions = []) {
  if (typeof logicObj !== 'object' || logicObj === null) {
    return conditions;
  }
  
  if (logicObj.Type === 'Expression' && logicObj.ChoiceLocator && logicObj.Operator) {
    const parsed = parseChoiceLocator(logicObj.ChoiceLocator);
    if (parsed) {
      conditions.push({
        questionId: parsed.questionId,
        choiceId: parsed.choiceId,
        operator: logicObj.Operator,
        description: logicObj.Description || '',
        locator: logicObj.ChoiceLocator,
        conjunction: logicObj.Conjuction || null
      });
    }
  }
  
  for (const key in logicObj) {
    if (typeof logicObj[key] === 'object') {
      extractConditions(logicObj[key], conditions);
    }
  }
  
  return conditions;
}

// Group conditions by question ID
function groupConditionsByQuestion(conditions) {
  const grouped = {};
  
  conditions.forEach(condition => {
    if (!grouped[condition.questionId]) {
      grouped[condition.questionId] = [];
    }
    grouped[condition.questionId].push(condition);
  });
  
  return grouped;
}

// Main validation function for a logic block
function validateLogicBlock(logicBlock, element) {
  // STAGE 0: Check if logic exists
  if (!logicBlock) {
    if (element.type === 'Branch') {
      results.push(createResult(
        "Fail",
        "P1",
        element,
        "Branch has no logic defined",
        "This branch element exists but has no BranchLogic. It will never execute its child elements.",
        "structure"
      ));
    }
    return false; // Cannot continue validation
  }
  
  // STAGE 1: Check if logic is empty
  const expressions = findExpressions(logicBlock);
  
  if (expressions.length === 0) {
    results.push(createResult(
      "Fail",
      "P1",
      element,
      "Logic structure is empty",
      "Logic structure exists but contains no actual conditions. This logic will never be triggered.",
      "structure"
    ));
    return false; // Cannot continue validation
  }
  
  // STAGE 2: Validate question existence
  const conditions = extractConditions(logicBlock);
  const referencedQuestions = new Set();
  let questionCheckFailed = false;
  
  conditions.forEach(condition => {
    referencedQuestions.add(condition.questionId);
    
    if (!questions[condition.questionId]) {
      results.push(createResult(
        "Fail",
        "P0",
        element,
        "Logic references non-existent question",
        `Question ${condition.questionId} is referenced in logic but does not exist in the survey. This question may have been deleted.`,
        "question_existence"
      ));
      questionCheckFailed = true;
    }
  });
  
  if (questionCheckFailed) {
    return false; // Cannot continue if questions don't exist
  }
  
  // STAGE 3: Validate choice existence
  let choiceCheckFailed = false;
  const choiceReferences = new Map(); // Deduplicate
  
  conditions.forEach(condition => {
    const key = `${condition.questionId}:${condition.choiceId}`;
    if (!choiceReferences.has(key)) {
      choiceReferences.set(key, condition);
      
      const validation = validateChoice(condition.questionId, condition.choiceId, questions);
      
      if (!validation.exists) {
        results.push(createResult(
          "Fail",
          "P0",
          element,
          "Logic references non-existent choice",
          `${validation.reason}. This choice may have been deleted or the question type changed.`,
          "choice_existence"
        ));
        choiceCheckFailed = true;
      }
    }
  });
  
  if (choiceCheckFailed) {
    return false; // Cannot continue if choices don't exist
  }
  
  // STAGE 4: Check for impossible logic (AND conditions on single-select)
  const hasAnd = hasAndConjunctions(logicBlock);
  
  if (hasAnd) {
    const groupedConditions = groupConditionsByQuestion(conditions);
    let impossibleLogicFound = false;
    
    Object.keys(groupedConditions).forEach(questionId => {
      const questionConditions = groupedConditions[questionId];
      
      if (questionConditions.length < 2) {
        return; // Single condition, can't be contradictory
      }
      
      const question = questions[questionId];
      const isSingleSelect = !isMultiSelectQuestion(question);
      
      if (isSingleSelect) {
        // Check if multiple choices are required to be selected simultaneously
        const selectedChoices = questionConditions.filter(c => 
          c.operator === 'Selected' || c.operator === 'EqualTo'
        );
        
        if (selectedChoices.length > 1) {
          const choiceList = selectedChoices.map(c => c.choiceId).join(', ');
          
          results.push(createResult(
            "Fail",
            "P0",
            element,
            "Impossible AND condition on single-select question",
            `Question ${questionId} (${question.question_type}) is single-select but logic requires multiple choices [${choiceList}] to be selected simultaneously. This condition can never be true.`,
            "logical_impossibility"
          ));
          impossibleLogicFound = true;
        }
      }
      
      // Check for contradictory operators on same choice
      const choiceGroups = {};
      questionConditions.forEach(c => {
        if (!choiceGroups[c.choiceId]) {
          choiceGroups[c.choiceId] = [];
        }
        choiceGroups[c.choiceId].push(c);
      });
      
      Object.keys(choiceGroups).forEach(choiceId => {
        const choiceConditions = choiceGroups[choiceId];
        
        if (choiceConditions.length > 1) {
          const operators = choiceConditions.map(c => c.operator);
          
          if (operators.includes('Selected') && operators.includes('NotSelected')) {
            results.push(createResult(
              "Fail",
              "P0",
              element,
              "Contradictory conditions on same choice",
              `Question ${questionId}, Choice ${choiceId} has both 'Selected' and 'NotSelected' conditions with AND logic. This can never be satisfied.`,
              "logical_impossibility"
            ));
            impossibleLogicFound = true;
          }
        }
      });
    });
    
    if (impossibleLogicFound) {
      return false; // Logic is impossible
    }
  }
  
  // ALL CHECKS PASSED
  results.push(createResult(
    "Pass",
    "P1",
    element,
    "Logic is valid and complete",
    `Logic has ${expressions.length} condition(s). All questions and choices exist. ${hasAnd ? 'AND logic is logically possible.' : 'Uses OR conditions only.'}`,
    "complete"
  ));
  
  return true;
}

// Process all flow elements recursively
function processFlowElement(element) {
  if (element.type === 'Branch') {
    const branchLogic = element.extensions?.BranchLogic;
    validateLogicBlock(branchLogic, element);
    
    // Additional check: Branch with no children
    if (!element.children || element.children.length === 0) {
      results.push(createResult(
        "Warn",
        "P2",
        element,
        "Branch has no child elements",
        "This branch has logic but no child elements to display when triggered. It has no effect on survey flow.",
        "structure"
      ));
    }
  }
  
  // Recursively process children
  if (element.children && element.children.length > 0) {
    element.children.forEach(child => processFlowElement(child));
  }
}

// Process all flow elements
flowData.forEach(element => {
  processFlowElement(element);
});

// Check display logic in questions
Object.keys(questions).forEach(qid => {
  const question = questions[qid];
  
  const pseudoElement = {
    type: "Question",
    flow_id: qid,
    description: question.question_description || question.data_export_tag
  };
  
  // Check display_logic
  if (question.display_logic) {
    validateLogicBlock(question.display_logic, pseudoElement);
  }
  
  // Check in_page_display_logic
  if (question.in_page_display_logic) {
    validateLogicBlock(question.in_page_display_logic, pseudoElement);
  }
});

// Return results
return results;