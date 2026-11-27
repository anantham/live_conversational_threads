// Background passes over a finished map (epistemic lenses, the map audit, an external claim check)
// each own one field of the bundle. They finish against the bundle as it was when they started, so
// applying their whole result would throw away anything the user changed meanwhile: an audit, a
// boundary correction, a reaction, or another pass that landed first. Callers merge only the owned
// field onto the latest bundle, after checking that the latest bundle is still the same map.

/** The epistemic pass owns `bundle.epistemic`. */
export function withEpistemic(latest, epistemic) {
  if (!latest) return latest;
  return { ...latest, epistemic };
}

/** The map audit owns `bundle.audit_signals`. */
export function withAuditSignals(latest, auditSignals) {
  if (!latest) return latest;
  return { ...latest, audit_signals: Array.isArray(auditSignals) ? auditSignals : [] };
}

/**
 * An external claim check owns one claim's `external_evidence`. Returns null when the claim is no
 * longer in the latest bundle, or when the claims were re-analysed since the check started (pass the
 * `analyzed_at` seen then): a new analysis may reuse the id for a different claim. The caller can then
 * say so instead of saving a result attached to the wrong claim or to nothing.
 */
export function withClaimEvidence(latest, claimId, evidence, options) {
  const claims = latest?.epistemic?.factual_claims;
  if (!Array.isArray(claims) || !claims.some((c) => String(c.id) === String(claimId))) return null;
  if (options && 'analyzedAt' in options && latest.epistemic.analyzed_at !== options.analyzedAt) return null;
  return {
    ...latest,
    epistemic: {
      ...latest.epistemic,
      factual_claims: claims.map((c) => (String(c.id) === String(claimId) ? { ...c, external_evidence: evidence } : c)),
    },
  };
}
