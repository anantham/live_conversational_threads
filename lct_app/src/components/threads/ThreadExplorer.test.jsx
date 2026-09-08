import {describe,it,expect} from "vitest";
import {renderToStaticMarkup} from "react-dom/server";
import ThreadExplorer from "./ThreadExplorer";
describe("thread-first evidence view",()=>{
  it("renders rationale, exact evidence, overlap and qualified callbacks",()=>{
    const step={moment_id:"m",why:"Revisits the question",evidence_utterance_ids:["u"]};
    const bundle={utterances:[{id:"u",speaker_id:"A",text:"Exact original words"}],conversation_threads:[
      {id:"t",title:"First question",summary:"Development",steps:[step],returns:[{from:"m",to:"m",kind:"thematic_connection",why:"Related but not an explicit callback"}]},
      {id:"other",title:"Second question",steps:[step]},
    ]};
    const html=renderToStaticMarkup(<ThreadExplorer bundle={bundle} nodes={[{id:"m",node_name:"Shared moment"}]} onClose={()=>{}}/>);
    expect(html).toContain("Exact original words");
    expect(html).toContain("Also in");
    expect(html).toContain("Interpretive connection");
    expect(html).toContain("Revisits the question");
  });
});
