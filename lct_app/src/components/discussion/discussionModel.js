import { buildMobileConversationDeck } from "../threads/mobileConversationDeckModel";

// Render each semantic node once. Secondary memberships remain navigable links.
export function buildDiscussionModel(nodes, utterances = []) {
  const deck = buildMobileConversationDeck(nodes, utterances);
  const parents = new Map();
  deck.childrenByParent.forEach((children, parent) => children.forEach((child) => {
    const values = parents.get(child) || [];
    values.push(parent);
    parents.set(child, values);
  }));
  const parentByChild = new Map();
  parents.forEach((values, child) => {
    const primary = deck.parentByChild.get(child);
    parentByChild.set(child, values.includes(primary) ? primary : values[0]);
  });
  const linked = new Set([...deck.utterancesByMoment.values()].flat());
  return {
    ...deck,
    parentByChild,
    rootIds: [...deck.nodeById.keys()].filter((id) => !parentByChild.has(id)),
    unlinkedUtteranceIds: [...deck.utteranceById.keys()].filter((id) => !linked.has(id)),
  };
}
