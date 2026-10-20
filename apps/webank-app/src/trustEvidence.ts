import type { TrustEvidence } from "./gateway";

export function reviewableTrustEvidence(
  evidence: TrustEvidence | null,
  agentId: string,
): evidence is TrustEvidence {
  if (!evidence || !Array.isArray(evidence.items)) return false;
  if (!Array.isArray(evidence.legacy_evidence)) return false;
  if (!evidence.items.length && !evidence.legacy_evidence.length) return false;
  return (
    evidence.items.every(
      (event) =>
        event.agent_id === agentId &&
        Boolean(event.event_id && event.reason && event.audit_hash),
    ) &&
    evidence.legacy_evidence.every(
      (legacy) =>
        legacy.kind === "legacy_red" &&
        Boolean(legacy.reason && legacy.created_at) &&
        Array.isArray(legacy.audit_ids) &&
        legacy.audit_ids.every((id) => typeof id === "string" && id.length > 0),
    )
  );
}

export function trustEvidenceUnchanged(
  reviewed: TrustEvidence,
  current: TrustEvidence,
  agentId: string,
): boolean {
  return (
    reviewableTrustEvidence(reviewed, agentId) &&
    reviewableTrustEvidence(current, agentId) &&
    JSON.stringify(reviewed.items) === JSON.stringify(current.items) &&
    JSON.stringify(reviewed.legacy_evidence) ===
      JSON.stringify(current.legacy_evidence)
  );
}
