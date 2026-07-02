import { createContext, useContext } from 'react';

/**
 * DataProvider Base Interface
 * 
 * Defines the shape of the data layer. Concrete implementations 
 * (BackendDataProvider, ServerlessDataProvider) must implement these namespaces.
 */
export class DataProvider {
  get analytics() { throw new Error("Not implemented"); }
  get artifactSettings() { throw new Error("Not implemented"); }
  get audioRecovery() { throw new Error("Not implemented"); }
  get backendCatalog() { throw new Error("Not implemented"); }
  get bias() { throw new Error("Not implemented"); }
  get byok() { throw new Error("Not implemented"); }
  get consumption() { throw new Error("Not implemented"); }
  get conversationDiagnostics() { throw new Error("Not implemented"); }
  get crux() { throw new Error("Not implemented"); }
  get editHistory() { throw new Error("Not implemented"); }
  get frame() { throw new Error("Not implemented"); }
  get graph() { throw new Error("Not implemented"); }
  get llmSettings() { throw new Error("Not implemented"); }
  get participants() { throw new Error("Not implemented"); }
  get prayerCards() { throw new Error("Not implemented"); }
  get prompts() { throw new Error("Not implemented"); }
  get simulacra() { throw new Error("Not implemented"); }
  get speakerNaming() { throw new Error("Not implemented"); }
  get sttSettings() { throw new Error("Not implemented"); }

  // High-level operations that used raw fetch() previously
  get conversations() { throw new Error("Not implemented"); }
  get import() { throw new Error("Not implemented"); }
  get audio() { throw new Error("Not implemented"); }
  get share() { throw new Error("Not implemented"); }
  get subjectReview() { throw new Error("Not implemented"); }
}

export const DataProviderContext = createContext(null);

export function useDataProvider() {
  const context = useContext(DataProviderContext);
  if (!context) {
    throw new Error('useDataProvider must be used within a DataProviderContext.Provider');
  }
  return context;
}
