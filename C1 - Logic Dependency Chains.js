// Branch B - Check 3: Logic Dependency Chains (Forward References)
// Input: item (from n8n - the full input object with FlowData, Questions, and BlockData)

const input = $input.item.json;
const flowData = input.FlowData;
const questions = input.Questions;
const blockDataJson = input.BlockData;
const results = [];

// Parse BlockData from JSON string
const blocks = JSON.parse(blockDataJson);

// Helper function to create result objects
function createResult(status, priority, element, issue, details, checklistItem) {
  return {
    status: status,
    priority: priority,
    branch: "B",
    check: "Logic",
    element: `${element.type}:${element.flow_id}`,
    path: element.description || element.type,
    issue: issue,
    details: details,
    sheetName: status === "Pass" ? "Full Checklist" : "Action Items",
    timestamp: new Date().toISOString()
  };
}

// Extract all question references from logic
function extractQuestionReferences(logicObj, refs = new Set()) {
  if (typeof logicObj !== 'object' || logicObj === null) {
    return refs;
  }
  
  if (logicObj.Type === 'Expression' && logicObj.QuestionID) {
    refs.add(logicObj.QuestionID);
  }
  
  for (const key in logicObj) {
    if (typeof logicObj[key] === 'object') {
      extractQuestionReferences(logicObj[key], refs);
    }
  }
  
  return refs;
}

// Build flow order map with question positions
function buildFlowOrderMap(flowData, blocks) {
  const questionOrder = new Map();
  const blockOrder = new Map();
  let position = 0;
  
  function processFlowElement(element, isInBranch = false) {
    if (element.type === 'EmbeddedData') {
      position++;
      return;
    }
    
    if (element.type === 'Block' || element.type === 'Standard') {
      const blockId = element.id;
      blockOrder.set(blockId, position);
      
      // Get questions from this block
      if (blocks[blockId] && blocks[blockId].question_refs) {
        blocks[blockId].question_refs.forEach(qid => {
          questionOrder.set(qid, {
            position: position,
            blockId: blockId,
            isInBranch: isInBranch
          });
        });
      }
      
      position++;
    }
    
    if (element.type === 'Branch') {
      blockOrder.set(element.flow_id, position);
      position++;
      
      if (element.children && element.children.length > 0) {
        element.children.forEach(child => {
          processFlowElement(child, true);
        });
      }
    }
  }
  
  flowData.forEach(element => {
    processFlowElement(element, false);
  });
  
  return { questionOrder, blockOrder };
}

// Build the order map
const { questionOrder, blockOrder } = buildFlowOrderMap(flowData, blocks);

// Check branch logic for forward references
function checkBranchLogic(element) {
  const branchLogic = element.extensions?.BranchLogic;
  if (!branchLogic) return;
  
  const branchPosition = blockOrder.get(element.flow_id);
  if (branchPosition === undefined) return;
  
  const referencedQuestions = extractQuestionReferences(branchLogic);
  
  if (referencedQuestions.size === 0) return;
  
  let hasForwardReference = false;
  const forwardRefs = [];
  
  referencedQuestions.forEach(refQid => {
    const refPosition = questionOrder.get(refQid);
    
    if (!refPosition) {
      // Question not in flow - already caught by B1
      return;
    }
    
    if (refPosition.position > branchPosition) {
      hasForwardReference = true;
      forwardRefs.push({
        qid: refQid,
        position: refPosition.position,
        blockId: refPosition.blockId
      });
    }
  });
  
  if (hasForwardReference) {
    const refDetails = forwardRefs.map(ref => 
      `${ref.qid} (position ${ref.position}, block ${blocks[ref.blockId]?.description || ref.blockId})`
    ).join(', ');
    
    results.push(createResult(
      "Fail",
      "P0",
      element,
      "Branch logic references questions that appear later in flow",
      `This branch is at position ${branchPosition} but references questions that haven't been asked yet: ${refDetails}. The branch condition cannot be evaluated because these questions come after the branch in the survey flow.`
    ));
  } else {
    results.push(createResult(
      "Pass",
      "P2",
      element,
      "Branch logic dependencies are valid",
      `All ${referencedQuestions.size} referenced question(s) appear before this branch in the flow`
    ));
  }
}

// Check question display logic for forward references
function checkQuestionDisplayLogic(qid, question) {
  const questionPosition = questionOrder.get(qid);
  
  if (!questionPosition) {
    // Question not in flow order map - might be in trash block
    return;
  }
  
  const pseudoElement = {
    type: "Question",
    flow_id: qid,
    description: question.question_description || question.data_export_tag
  };
  
  // Check display_logic (cross-page logic)
  if (question.display_logic) {
    const referencedQuestions = extractQuestionReferences(question.display_logic);
    
    if (referencedQuestions.size === 0) return;
    
    let hasForwardReference = false;
    const forwardRefs = [];
    
    referencedQuestions.forEach(refQid => {
      const refPosition = questionOrder.get(refQid);
      
      if (!refPosition) {
        // Question not in flow
        return;
      }
      
      if (refPosition.position > questionPosition.position) {
        hasForwardReference = true;
        forwardRefs.push({
          qid: refQid,
          position: refPosition.position,
          blockId: refPosition.blockId
        });
      }
    });
    
    if (hasForwardReference) {
      const refDetails = forwardRefs.map(ref => 
        `${ref.qid} (position ${ref.position}, block ${blocks[ref.blockId]?.description || ref.blockId})`
      ).join(', ');
      
      results.push(createResult(
        "Fail",
        "P0",
        pseudoElement,
        "Display logic references questions that appear later in flow",
        `This question is at position ${questionPosition.position} but its display logic references questions that haven't been asked yet: ${refDetails}. The question will never display because the condition cannot be evaluated.`
      ));
    } else {
      results.push(createResult(
        "Pass",
        "P2",
        pseudoElement,
        "Display logic dependencies are valid",
        `All ${referencedQuestions.size} referenced question(s) appear before or at the same position as this question`
      ));
    }
  }
  
  // Check in_page_display_logic
  if (question.in_page_display_logic) {
    const referencedQuestions = extractQuestionReferences(question.in_page_display_logic);
    
    if (referencedQuestions.size === 0) return;
    
    // For in-page logic, questions on the same page (same position) are OK
    let hasInvalidReference = false;
    const invalidRefs = [];
    
    referencedQuestions.forEach(refQid => {
      const refPosition = questionOrder.get(refQid);
      
      if (!refPosition) {
        return;
      }
      
      // In-page logic: referenced question must be at same position OR earlier
      if (refPosition.position > questionPosition.position) {
        hasInvalidReference = true;
        invalidRefs.push({
          qid: refQid,
          position: refPosition.position,
          blockId: refPosition.blockId
        });
      }
    });
    
    if (hasInvalidReference) {
      const refDetails = invalidRefs.map(ref => 
        `${ref.qid} (position ${ref.position}, block ${blocks[ref.blockId]?.description || ref.blockId})`
      ).join(', ');
      
      results.push(createResult(
        "Fail",
        "P0",
        pseudoElement,
        "In-page display logic references questions in later blocks",
        `This question is at position ${questionPosition.position} but its in-page display logic references questions in later blocks: ${refDetails}. In-page logic can only reference questions on the same page or earlier pages.`
      ));
    } else {
      results.push(createResult(
        "Pass",
        "P2",
        pseudoElement,
        "In-page display logic is valid",
        `All ${referencedQuestions.size} referenced question(s) are on the same page or earlier`
      ));
    }
  }
}

// Process all branch elements
function processFlowElement(element) {
  if (element.type === 'Branch') {
    checkBranchLogic(element);
  }
  
  if (element.children && element.children.length > 0) {
    element.children.forEach(child => processFlowElement(child));
  }
}

flowData.forEach(element => {
  processFlowElement(element);
});

// Check all questions with display logic
Object.keys(questions).forEach(qid => {
  const question = questions[qid];
  
  if (question.display_logic || question.in_page_display_logic) {
    checkQuestionDisplayLogic(qid, question);
  }
});

// Return results
return results;