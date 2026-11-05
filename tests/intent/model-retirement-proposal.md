# Model-retirement continuation proposal

- Exercise only the proposed recovery in isolated in-memory SQLite built from current applied history; never install or run it live.
- Verify exactly one timestamp changes in fourteen retained records, the older holder is untouched, replay is inert, and all identity/count/state/age drift refuses mutation.
- Verify the proposed journal only appends entry16 and snapshot changes only identity/predecessor; configuration changes only the named model.
- Catalogue and local tests do not establish successful live model generation or authorize a retry.

Owner approved22October after ELI5 clarification. Activation tests now exercise installed SQL and exact proposal equality; local SQLite only. Production files remain byte-identical to the reviewed proposal.
