import {renderToStaticMarkup} from "react-dom/server";
import {act} from "react";
import {createRoot} from "react-dom/client";
import {expect,it} from "vitest";
import {CardDisplayProvider,CardDisplaySettings,useCardDisplay} from "./CardDisplaySettings";

// Intent: static viewer preferences must not remove metrics from other screens.
function ReadOptions(){return <span>{JSON.stringify(useCardDisplay())}</span>;}
it("keeps legacy metrics outside the viewer and quiet defaults inside",()=>{
  expect(renderToStaticMarkup(<ReadOptions/>)).toContain('words&quot;:true');
  expect(renderToStaticMarkup(<CardDisplayProvider><ReadOptions/></CardDisplayProvider>)).toContain('words&quot;:false');
});

it("shows aligned, vertically readable card detail toggles",()=>{
  const container=document.createElement("div");
  document.body.appendChild(container);
  const root=createRoot(container);
  act(()=>root.render(<CardDisplayProvider><CardDisplaySettings/></CardDisplayProvider>));
  const summary=container.querySelector("summary");
  expect(summary.textContent).toContain("Card details");
  expect(summary.querySelector("svg")).not.toBeNull();
  const details=summary.closest("details");
  act(()=>{details.open=true;});
  const labels=[...container.querySelectorAll("label")];
  expect(labels.length).toBe(5);
  expect(labels.every(label=>label.className.includes("min-h-11"))).toBe(true);
  expect(labels.every(label=>label.querySelector("input[type=checkbox]")!==null)).toBe(true);
  act(()=>root.unmount());
  container.remove();
});
