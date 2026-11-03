import {createContext, useContext, useState} from "react";
import PropTypes from "prop-types";
import {ChevronRight} from "lucide-react";
const defaults = {duration:true,words:false,segments:false,voices:false,connections:false};
const Context = createContext({options:{duration:true,words:true,segments:true,voices:true,connections:true},setOptions:()=>{}});
export const useCardDisplay = () => useContext(Context).options;
export function CardDisplayProvider({children}) {
  const [options,setOptions]=useState(defaults);
  return <Context.Provider value={{options,setOptions}}>{children}</Context.Provider>;
}
CardDisplayProvider.propTypes={children:PropTypes.node};
export function CardDisplaySettings(){
  const {options,setOptions}=useContext(Context);
  return <details className="group text-xs text-slate-600"><summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-2 py-1"><ChevronRight aria-hidden="true" size={16} className="shrink-0 transition-transform group-open:rotate-90"/><span>Card details</span></summary>
    <div className="flex flex-col gap-1 rounded border border-slate-200 bg-white p-3">
      {Object.keys(defaults).map(key=><label key={key} className="flex min-h-11 items-center gap-3 capitalize"><input className="size-4 shrink-0 accent-slate-700" type="checkbox" checked={options[key]} onChange={e=>setOptions({...options,[key]:e.target.checked})}/><span>{key}</span></label>)}
    </div>
  </details>;
}
