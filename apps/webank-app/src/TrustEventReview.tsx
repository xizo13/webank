import { StyleSheet, Text, View } from "react-native";
import type { LegacyRedEvidence, TrustEvent } from "./gateway";

export function TrustEventReview({
  events,
  legacyEvidence = [],
}: {
  events: TrustEvent[];
  legacyEvidence?: LegacyRedEvidence[];
}) {
  return (
    <View style={styles.card} testID="trust-event-review">
      <Text accessibilityRole="header" style={styles.title}>
        Trust evidence history
      </Text>
      <Text style={styles.intro}>
        {events.length
          ? "Review the recorded flags, drills, disputes, and light changes before returning this agent to Amber."
          : "Review this restored legacy Red evidence before returning this agent to Amber."}
      </Text>
      {events.map((event) => (
        <View key={event.event_id} style={styles.event}>
          <Text style={styles.kind}>{event.kind.replace(/_/g, " ")}</Text>
          <Text style={styles.reason}>{event.reason}</Text>
          <Text style={styles.meta}>
            Source {event.source_id} · Source event time {event.occurred_at}
          </Text>
          {event.from && event.to ? (
            <Text style={styles.meta}>
              {event.from} to {event.to}
            </Text>
          ) : null}
          {event.confirmed_at ? (
            <Text style={styles.meta}>
              Confirmed light transition {event.confirmed_at}
            </Text>
          ) : null}
          <Text style={styles.meta}>
            Audit{" "}
            {event.audit_hash.match(/.{1,16}/g)?.join("\u200b") ??
              event.audit_hash}
          </Text>
          {event.evidence_hash ? (
            <Text style={styles.meta}>
              Evidence hash:{" "}
              {event.evidence_hash.match(/.{1,16}/g)?.join("\u200b") ??
                event.evidence_hash}
            </Text>
          ) : null}
        </View>
      ))}
      {legacyEvidence.map((legacy) => (
        <View
          key={`${legacy.created_at}-${legacy.reason}-${legacy.audit_ids.join(",")}`}
          style={styles.event}
        >
          <Text style={styles.kind}>Legacy Red evidence</Text>
          <Text style={styles.reason}>{legacy.reason}</Text>
          <Text style={styles.meta}>Recorded {legacy.created_at}</Text>
          <Text style={styles.meta}>
            Earlier audit IDs: {legacy.audit_ids.join(", ") || "none recorded"}
          </Text>
          <Text style={styles.meta}>
            Restored from an earlier trust model; no new trust event or chain
            audit was created for this record.
          </Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: "#FFFFFF",
    borderColor: "#E8E3EB",
    borderRadius: 9,
    borderWidth: 1,
    marginTop: 12,
    padding: 14,
  },
  title: { color: "#16131C", fontSize: 15, fontWeight: "800" },
  intro: { color: "#554C60", fontSize: 12, lineHeight: 18, marginTop: 6 },
  event: {
    borderTopColor: "#E8E3EB",
    borderTopWidth: 1,
    marginTop: 12,
    paddingTop: 10,
  },
  kind: {
    color: "#703BB6",
    fontSize: 12,
    fontWeight: "800",
    textTransform: "capitalize",
  },
  reason: { color: "#16131C", fontSize: 13, lineHeight: 18, marginTop: 4 },
  meta: { color: "#716D79", fontSize: 10, lineHeight: 15, marginTop: 3 },
});
