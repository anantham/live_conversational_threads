import { extractThreads } from './threadExtractor';
import { consolidateHierarchy } from './hierarchyConsolidator';

/**
 * Runs the extraction pipeline on a new transcript segment.
 * Returns the extracted tier 1 & 2 nodes.
 */
export async function processTranscriptSegment(apiKey, segmentText, existingNodes = []) {
  if (!segmentText || !segmentText.trim()) return [];
  return extractThreads(apiKey, segmentText, existingNodes);
}

/**
 * Runs the consolidation pipeline on all nodes.
 * Merges the new hierarchy layers back into the node list.
 */
export async function generateFullGraph(apiKey, allNodes = []) {
  // Clear any existing higher-tier nodes (level > 2) so we can regenerate them.
  const baseNodes = allNodes.filter(n => n.semantic_level <= 2);
  
  const { newNodes, conversation_title, executive_summary } = await consolidateHierarchy(apiKey, baseNodes);
  
  // Combine base nodes and the newly generated higher-tier nodes
  const finalNodes = [...baseNodes, ...newNodes];
  
  // Clean up dangling references across the tree (linking parents to children, etc.)
  // (In a real implementation we would iterate and verify parent_id/children_ids consistency here)
  
  return {
    nodes: finalNodes,
    metadata: {
      conversation_title,
      executive_summary
    }
  };
}
