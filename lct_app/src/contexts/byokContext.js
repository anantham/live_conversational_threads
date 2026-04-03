import { createContext, useContext } from "react";

export const ByokContext = createContext(null);

export function useByok() {
  const ctx = useContext(ByokContext);
  if (!ctx) {
    throw new Error("useByok must be used within ByokProvider");
  }
  return ctx;
}
