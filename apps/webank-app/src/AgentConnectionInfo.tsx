import { Pressable, StyleSheet, Text, View } from "react-native";
import type { Agent } from "./flow";

export function canReauthorizeConnection(agent: Agent): boolean {
  return (
    agent.reauthorization_required === true &&
    agent.status === "active" &&
    agent.licence.level !== "RED" &&
    Boolean(agent.client_app_id && agent.client_app_name)
  );
}

export function AgentConnectionInfo({
  agent,
  busy,
  renewalExpiresAt,
  now,
  onReauthorize,
}: {
  agent: Agent;
  busy: boolean;
  renewalExpiresAt?: string;
  now: number;
  onReauthorize: () => void;
}) {
  const deadline = agent.idle_expires_at;
  const deadlineText =
    deadline && Number.isFinite(Date.parse(deadline))
      ? new Date(deadline).toLocaleString()
      : "Unavailable";
  const canReauthorize = canReauthorizeConnection(agent);
  const renewalPending =
    agent.reauthorization_required === true &&
    Boolean(renewalExpiresAt && Date.parse(renewalExpiresAt) > now);
  return (
    <View style={styles.container} testID={`connection-info-${agent.agent_id}`}>
      <Text style={styles.label}>Client app</Text>
      <Text style={styles.value} testID="agent-client-app">
        {agent.client_app_name || "Unavailable for this older connection"}
      </Text>
      {agent.client_app_name ? (
        <Text style={styles.helper}>
          This connection covers every chat in {agent.client_app_name}.
        </Text>
      ) : null}
      <Text style={styles.label}>Idle re-approval deadline</Text>
      <Text style={styles.value} testID="agent-idle-deadline">
        {deadlineText}
      </Text>
      {agent.reauthorization_required ? (
        <Text style={styles.warning} testID="agent-reauthorization-state">
          {renewalPending
            ? `Owner re-approval recorded. Reconnect ${agent.client_app_name} before ${new Date(renewalExpiresAt ?? "").toLocaleString()} so its registered key can renew access. Spending remains paused until that renewal succeeds.`
            : canReauthorize
              ? "Connection paused after seven idle days. Re-approve this app and key to let the connector renew its access."
              : "Connection needs owner recovery. A frozen, revoked, Red, or unlabelled agent cannot use idle re-approval."}
        </Text>
      ) : null}
      {canReauthorize && !renewalPending ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Re-approve connection for ${agent.client_app_name}`}
          accessibilityHint="Starts a fresh owner-only biometric challenge for this app and agent key"
          accessibilityState={{ disabled: busy }}
          disabled={busy}
          onPress={onReauthorize}
          style={[styles.action, busy && styles.actionBusy]}
          testID={`reauthorize-agent-${agent.agent_id}`}
        >
          <Text style={styles.actionText}>
            {busy ? "Preparing re-approval..." : "Re-approve connection"}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderTopColor: "#E8E3EB",
    borderTopWidth: 1,
    marginTop: 14,
    paddingTop: 13,
  },
  label: { color: "#716D79", fontSize: 11, fontWeight: "700", marginTop: 7 },
  value: { color: "#16131C", fontSize: 13, lineHeight: 19, marginTop: 3 },
  helper: { color: "#554C60", fontSize: 12, lineHeight: 18, marginTop: 6 },
  warning: { color: "#8A5A08", fontSize: 12, lineHeight: 18, marginTop: 12 },
  action: {
    alignItems: "center",
    backgroundColor: "#F0E9F7",
    borderRadius: 24,
    justifyContent: "center",
    marginTop: 12,
    minHeight: 48,
    paddingHorizontal: 18,
  },
  actionBusy: { opacity: 0.5 },
  actionText: { color: "#16131C", fontSize: 13, fontWeight: "800" },
});
