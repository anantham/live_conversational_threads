import {act} from "react";
import {createRoot} from "react-dom/client";
import {it,expect,vi} from "vitest";
import PanelResizeHandle from "./PanelResizeHandle";

it.each([false,true])("resizes with pointer and keyboard, vertical=%s",vertical=>{
 globalThis.IS_REACT_ACT_ENVIRONMENT=true;
 const container=document.createElement('div');document.body.append(container);
 const root=createRoot(container), change=vi.fn();
 act(()=>root.render(<PanelResizeHandle label="Resize" vertical={vertical} value={200} min={100} max={400} onChange={change}/>));
 const handle=container.firstChild;
 handle.setPointerCapture=vi.fn();
 act(()=>handle.dispatchEvent(new MouseEvent('pointerdown',{bubbles:true,button:0,clientX:100,clientY:100})));
 act(()=>handle.dispatchEvent(new MouseEvent('pointermove',{bubbles:true,clientX:150,clientY:50})));
 expect(change).toHaveBeenLastCalledWith(250);
 act(()=>handle.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'End'})));
 expect(change).toHaveBeenLastCalledWith(400);
 act(()=>root.unmount());container.remove();
 globalThis.IS_REACT_ACT_ENVIRONMENT=false;
});
