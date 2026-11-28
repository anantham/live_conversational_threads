import { createContext, useContext } from 'react';

export const SitesRuntimeContext = createContext(null);
export const useSitesRuntime = () => useContext(SitesRuntimeContext);
