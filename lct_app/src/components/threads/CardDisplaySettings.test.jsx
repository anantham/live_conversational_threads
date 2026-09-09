import {renderToStaticMarkup} from "react-dom/server";
import {expect,it} from "vitest";
import {CardDisplayProvider,useCardDisplay} from "./CardDisplaySettings";

// Intent: static viewer preferences must not remove metrics from other screens.
function ReadOptions(){return <span>{JSON.stringify(useCardDisplay())}</span>;}
it("keeps legacy metrics outside the viewer and quiet defaults inside",()=>{
  expect(renderToStaticMarkup(<ReadOptions/>)).toContain('words&quot;:true');
  expect(renderToStaticMarkup(<CardDisplayProvider><ReadOptions/></CardDisplayProvider>)).toContain('words&quot;:false');
});
