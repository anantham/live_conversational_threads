# Dialectic layout (argument-view Phase 2) — wiring plan

**Status:** core function landed + verified; UI wiring HELD.

## What's landed
`layoutDialectic(nodes, edges, { focusNodeId, ... })` in
`lct_app/src/components/graphLayout.js` (+ 24 tests in `graphLayout.test.js`).
Focus-per-contested-node: the tapped node centers at the origin, its **incoming
supporters** fan left (x<0), **incoming rebutters** fan right (x>0), everyone
else parks in a faint band below. Returns the same ReactFlow node array with
`position` set and two `data` hints: `dialecticRole`
(`focus|supporter|rebutter|parked`) and `dialecticFocusId`.

Semantics are the **single source of truth** shared with the argument-status
color: `colorModes.argumentStanceOf` (exact supports/rebuts vocabulary),
incoming-to-F only, exact/case-insensitive name resolution, presence-based
stance (any incoming rebut → rebutter). A node's fan side therefore always
agrees with the fill it shows. (Earlier draft folded F's *outgoing* edges in —
fixed; see the "ignores F's OUTGOING edges" regression test.)

## Why the UI wiring is held
1. `MinimalGraph.jsx` is owned by a concurrent session (don't clobber).
2. The handover flags Phase 2 as soft-blocked on the **Vatsal alignment call**
   for viz direction — confirm the focus-per-node approach with him first.

## Proposed MinimalGraph.jsx wiring (apply when unblocked)

```diff
--- a/lct_app/src/components/MinimalGraph.jsx
+++ b/lct_app/src/components/MinimalGraph.jsx
@@
-import { layoutByThread, layoutWithDagre } from "./graphLayout";
+import { layoutByThread, layoutDialectic, layoutWithDagre } from "./graphLayout";
@@
   const [colorMode, setColorMode] = useState(
     COLOR_MODES.includes(initialColorMode) ? initialColorMode : DEFAULT_COLOR_MODE
   );
+  // Argument-view Phase 2: id of the contested node the user tapped to "focus
+  // the fight". null = normal layout. Only meaningful while colorMode==="argument".
+  const [dialecticFocusId, setDialecticFocusId] = useState(null);
@@
   const handleNodeClick = useCallback(
     (_, node) => {
       const isCluster = node.data?.memberCount != null;
       if (isCluster) {
@@
         setSelectedNode(null);
         setClickedEdge(null);
         return;
       }
+      // Argument view: tapping a DISPUTED node focuses the dialectic (centers
+      // it, fans supporters/rebutters). Tapping the focused node again exits.
+      // Only disputed nodes are focusable — others fall through to the drawer.
+      if (colorMode === "argument") {
+        const status = argumentStatusMap[node.id]?.status;
+        if (dialecticFocusId === node.id) {
+          setDialecticFocusId(null);
+        } else if (status === "disputed") {
+          setDialecticFocusId(node.id);
+          setSelectedCluster(null);
+          setClickedEdge(null);
+          return;
+        }
+      }
       // Single-click opens the NodeDetail drawer (original behavior).
       setSelectedCluster(null);
       setSelectedNode((prev) => {
         const next = prev === node.id ? null : node.id;
         autoFollowRef.current = next === null;
         return next;
       });
       setClickedEdge(null);
     },
-    [setSelectedNode]
+    [setSelectedNode, colorMode, argumentStatusMap, dialecticFocusId]
   );
@@
   const handlePaneClick = useCallback(() => {
     setSelectedNode(null);
     setSelectedCluster(null);
     setClickedEdge(null);
-  }, [setSelectedNode]);
+    setDialecticFocusId(null); // tapping empty canvas exits the dialectic focus
+  }, [setSelectedNode]);
@@
-  const baseLayoutNodes = effectiveView?.nodes || activeCluster?.nodes || layoutedNodes;
+  const baseLayoutNodes = effectiveView?.nodes || activeCluster?.nodes || layoutedNodes;
+  // Argument-view Phase 2: when a disputed node is focused, re-lay the CURRENT
+  // view's nodes around it. Drop-in: same node objects, only positions change.
+  const dialecticActive =
+    colorMode === "argument" &&
+    dialecticFocusId != null &&
+    baseLayoutNodes.some((n) => n.id === dialecticFocusId);
+  const layoutedDisplayNodes = useMemo(
+    () =>
+      dialecticActive
+        ? layoutDialectic(baseLayoutNodes, displayEdges, { focusNodeId: dialecticFocusId })
+        : baseLayoutNodes,
+    [dialecticActive, baseLayoutNodes, displayEdges, dialecticFocusId]
+  );
+  // Leaving argument mode drops any stale focus.
+  useEffect(() => {
+    if (colorMode !== "argument" && dialecticFocusId != null) setDialecticFocusId(null);
+  }, [colorMode, dialecticFocusId]);
```

(The exact `baseLayoutNodes`/`layoutedDisplayNodes` lines differ in current
`MinimalGraph.jsx`; reconcile against the live file at apply time.)

## Integration subtlety (flagged by the verifier — must handle)
The `interactiveNodes` effect re-seeds positions only when the **node-set
identity key** changes. A dialectic re-layout keeps the same node set (only
positions/`data` change), so toggling focus won't re-position unless the layout
key also varies. Append the focus to that key, e.g.:

```js
const key = layoutedDisplayNodes.map((n) => n.id).join(",") +
  `|d:${dialecticActive ? dialecticFocusId : ""}`;
```

so entering/leaving focus forces a position re-seed.

## Optional next polish
`data.dialecticRole` is already set on every node — drive a hover-isolate /
dim-everything-but-the-fan affordance from it (the design doc calls for this),
no extra computation needed.

See `.tmp_argview_design.md` (codex-reviewed) for the full design.
