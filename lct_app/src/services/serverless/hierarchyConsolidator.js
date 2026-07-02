import { callServerlessLlm } from './llmClient';
import prompts from './prompts.json' with { type: 'json' };

export async function consolidateHierarchy(apiKey, nodes = []) {
  // 1. Get all idea nodes
  const ideaNodes = nodes.filter(n => n.semantic_level === 2 || n.semantic_type === 'idea');
  if (ideaNodes.length < 2) {
    return { newNodes: [], conversation_title: "Brief Conversation", executive_summary: "Too short to summarize." };
  }

  const allNewNodes = [];
  
  // STEP 1: Ideas -> Topics
  const topicTemplate = prompts.prompts.consolidate_ideas_to_topics.template;
  const topicUserPrompt = `Idea Nodes:\n${JSON.stringify(ideaNodes, null, 2)}`;
  
  const topicsResult = await callServerlessLlm(apiKey, [
    { role: "system", content: topicTemplate },
    { role: "user", content: topicUserPrompt }
  ], { model: "gpt-4o", temperature: 0.3, jsonMode: true });

  let topicNodes = topicsResult.nodes || [];
  // Ensure semantic properties
  topicNodes.forEach((t) => {
    t.semantic_level = 3;
    t.semantic_type = 'topic';
  });
  allNewNodes.push(...topicNodes);

  if (topicNodes.length < 2) {
    // If only one topic, we wrap up here to avoid empty layers
    return { 
      newNodes: allNewNodes, 
      conversation_title: topicNodes[0]?.node_name || "Conversation",
      executive_summary: topicNodes[0]?.summary || ""
    };
  }

  // STEP 2: Topics -> Themes
  const themeTemplate = prompts.prompts.consolidate_topics_to_themes.template;
  const themeUserPrompt = `Topic Nodes:\n${JSON.stringify(topicNodes, null, 2)}`;
  
  const themesResult = await callServerlessLlm(apiKey, [
    { role: "system", content: themeTemplate },
    { role: "user", content: themeUserPrompt }
  ], { model: "gpt-4o", temperature: 0.3, jsonMode: true });

  let themeNodes = themesResult.nodes || [];
  themeNodes.forEach((t) => {
    t.semantic_level = 4;
    t.semantic_type = 'theme';
  });
  allNewNodes.push(...themeNodes);

  if (themeNodes.length < 1) themeNodes = topicNodes; // fallback if failure

  // STEP 3: Themes -> Arcs + Summary
  const arcTemplate = prompts.prompts.consolidate_themes_to_arcs.template;
  const arcUserPrompt = `Theme Nodes:\n${JSON.stringify(themeNodes, null, 2)}`;

  const arcsResult = await callServerlessLlm(apiKey, [
    { role: "system", content: arcTemplate },
    { role: "user", content: arcUserPrompt }
  ], { model: "gpt-4o", temperature: 0.3, jsonMode: true });

  const arcNodes = arcsResult.nodes || [];
  arcNodes.forEach((a) => {
    a.semantic_level = 5;
    a.semantic_type = 'arc';
  });
  allNewNodes.push(...arcNodes);

  return {
    newNodes: allNewNodes,
    conversation_title: arcsResult.conversation_title || "Untitled",
    executive_summary: arcsResult.executive_summary || ""
  };
}
