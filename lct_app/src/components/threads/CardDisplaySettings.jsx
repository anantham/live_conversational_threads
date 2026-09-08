import {createContext, useContext, useState} from "react";
import PropTypes from "prop-types";
const defaults = {duration:true,words:false,segments:false,voices:false,connections:false};
const Context = createContext({options:defaults,setOptions:()=>{}});
export const useCardDisplay = () => useContext(Context).options;
export function CardDisplayProvider({children}) {
  const [options,setOptions]=useState(defaults);
  return <Context.Provider value={{options,setOptions}}>{children}</Context.Provider>;
}
CardDisplayProvider.propTypes={children:PropTypes.node};
export function CardDisplaySettings(){
  const {options,setOptions}=useContext(Context);
  return <details className="text-xs text-slate-600"><summary className="cursor-pointer px-2 py-1">Card details</summary>
    <div className="flex flex-wrap gap-3 rounded border bg-white p-3">
      {Object.keys(defaults).map(key=><label key={key} className="flex items-center gap-1 capitalize"><input type="checkbox" checked={options[key]} onChange={e=>setOptions({...options,[key]:e.target.checked})}/>{key}</label>)}
    </div>
  </details>;
}
