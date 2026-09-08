import {it,expect} from "vitest";
import {withThreadLanes} from "./threadPresentation";
import {buildRibbonLayout} from "../timelineRibbonLayout";
it("keeps overlapping memberships while supplying a stable home lane",()=>{
 const nodes=withThreadLanes([{id:"a",thread_ids:["x","y"],timestamp_start:0},
 {id:"b",thread_ids:["y"],timestamp_start:900}], [{id:"x",title:"First"},{id:"y",title:"Second"}]);
 expect(nodes[0].thread_ids).toEqual(["x","y"]);
 expect(nodes[0].thread_label).toBe("First");
 const layout=buildRibbonLayout(nodes);
 expect(layout.rows.map(r=>r.label)).toEqual(["First","Second"]);
 expect(layout.rows.flatMap(r=>r.nodes).every(n=>!n.isReturn)).toBe(true);
});
