# Terminal meeting-task guard

- Re-delivering ended/fatal/data-deleted tasks returns before any recorder/controller starts and preserves the retained record.
- Existing nonterminal task behavior and shutdown handlers remain unchanged; missing/unknown records never start a controller.
- Archive installation admits exactly one regular task source file with pinned bytes, owner1000/group1000/mode0755; reject traversal, links, extra members and malformed source.
- Deployment is dry-run by default, exact stopped worker only, with immutable original archive and readback; no queue deletion, data reset, permission/route/provider or timer change.

Review refinement: a missing record is also obsolete work and now returns with an explicit log, rather than raising the previous DoesNotExist. Database failures still propagate. Verify both outcomes and no controller construction/row mutation.
