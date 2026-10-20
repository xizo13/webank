import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { formatMoney } from "./flow";
import type { EditablePolicyLimits, PolicySnapshot } from "./gateway";
import {
  type PolicyDraft,
  parsePolicyDraft,
  policyDraft,
} from "./policyLimits";

const labels: Record<keyof PolicyDraft, string> = {
  per_payment_max: "Per payment",
  daily_max: "Per UTC day",
  monthly_max: "Per UTC month",
  auto_approve_below: "Green auto-approve threshold",
};

function PolicyRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

function PolicyButton({
  label,
  onPress,
  disabled = false,
  light = false,
  testID,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  light?: boolean;
  testID?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      testID={testID}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.button,
        light && styles.buttonLight,
        disabled && styles.disabled,
      ]}
    >
      <Text style={[styles.buttonText, light && styles.buttonTextLight]}>
        {label}
      </Text>
    </Pressable>
  );
}

export function PolicyLimitsPanel({
  snapshot,
  error,
  message,
  busy,
  onRefresh,
  onSave,
}: {
  snapshot: PolicySnapshot | null;
  error: string;
  message: string;
  busy: boolean;
  onRefresh: () => void;
  onSave: (proposed: EditablePolicyLimits) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<PolicyDraft | null>(
    snapshot ? policyDraft(snapshot.policy) : null,
  );
  const [inputError, setInputError] = useState("");
  const reviewedPolicyHash = useRef(snapshot?.policy_hash);

  useEffect(() => {
    if (!snapshot || snapshot.policy_hash === reviewedPolicyHash.current)
      return;
    reviewedPolicyHash.current = snapshot.policy_hash;
    setDraft(policyDraft(snapshot.policy));
    setEditing(false);
    setInputError("");
  }, [snapshot]);

  const status = snapshot?.sync_status;
  const contract = snapshot?.contract;
  const editable = status === "consistent" && Boolean(contract) && !busy;
  const statusText =
    status === "consistent"
      ? `Gateway policy matches contract caps at block ${contract?.block_number}.`
      : status === "change_pending"
        ? "A limit change is pending confirmation. Agent spending is blocked."
        : status === "mismatch"
          ? "Gateway policy and contract caps disagree. Agent spending is blocked."
          : status === "chain_unavailable"
            ? "Contract caps cannot be verified. Agent spending is blocked."
            : "Waiting for live policy and contract caps.";

  const save = () => {
    if (!draft || !editable || !snapshot) return;
    const parsed = parsePolicyDraft(draft);
    if (!parsed.proposed) return setInputError(parsed.error);
    const proposed = parsed.proposed;
    if (
      Object.keys(labels).every(
        (field) =>
          proposed[field as keyof PolicyDraft].amount ===
          snapshot.policy[field as keyof PolicyDraft].amount,
      )
    )
      return setInputError("No limit changed.");
    setInputError("");
    onSave(proposed);
  };

  return (
    <View style={styles.card} testID="live-policy-limits">
      <Text accessibilityRole="header" style={styles.title}>
        Owner spending policy
      </Text>
      <Text style={[styles.status, status !== "consistent" && styles.alert]}>
        {statusText}
      </Text>
      {error ? (
        <Text
          accessibilityRole="alert"
          style={styles.alert}
          testID="policy-error"
        >
          {error}
        </Text>
      ) : null}
      {message ? <Text style={styles.status}>{message}</Text> : null}
      {snapshot ? (
        <>
          <Text style={styles.groupTitle}>
            {status === "consistent"
              ? "Current Gateway policy"
              : "Gateway policy - not confirmed active"}
          </Text>
          <PolicyRow
            label="Per payment"
            value={formatMoney(snapshot.policy.per_payment_max.amount)}
          />
          <PolicyRow
            label="Per UTC day"
            value={formatMoney(snapshot.policy.daily_max.amount)}
          />
          <PolicyRow
            label="Per UTC month"
            value={formatMoney(snapshot.policy.monthly_max.amount)}
          />
          <PolicyRow
            label="Green auto-approve threshold"
            value={formatMoney(snapshot.policy.auto_approve_below.amount)}
          />
          <Text style={styles.note}>
            Amber purchases always need your approval. Green auto-pay still
            obeys every cap; ¥0 turns it off.
          </Text>
        </>
      ) : null}
      {contract ? (
        <>
          <Text style={styles.groupTitle}>
            Observed AgentWallet contract caps
          </Text>
          <PolicyRow
            label="Per payment"
            value={formatMoney(contract.per_payment_max.amount)}
          />
          <PolicyRow
            label="Per UTC day"
            value={formatMoney(contract.daily_max.amount)}
          />
          <PolicyRow
            label="Per UTC month"
            value={formatMoney(contract.monthly_max.amount)}
          />
          <PolicyRow
            label="Spent today"
            value={formatMoney(contract.spent_today.amount)}
          />
          <PolicyRow
            label="Spent this month"
            value={formatMoney(contract.spent_month.amount)}
          />
          <PolicyRow
            label="Next daily reset (local time)"
            value={new Date(contract.next_daily_reset_at).toLocaleString()}
          />
          <PolicyRow
            label="Next monthly reset (local time)"
            value={new Date(contract.next_monthly_reset_at).toLocaleString()}
          />
          <Text style={styles.note}>
            UTC calendar windows. Observed{" "}
            {new Date(contract.observed_at).toLocaleString()}.
          </Text>
        </>
      ) : snapshot ? (
        <Text style={styles.alert}>Contract caps are unavailable.</Text>
      ) : null}
      {editing && draft ? (
        <View style={styles.editor} testID="policy-limit-editor">
          <Text accessibilityRole="header" style={styles.groupTitle}>
            Proposed limits in CNY
          </Text>
          {(Object.keys(labels) as Array<keyof PolicyDraft>).map((field) => (
            <View key={field} style={styles.field}>
              <Text style={styles.fieldLabel}>{labels[field]} (¥)</Text>
              <TextInput
                testID={`policy-${field}`}
                accessibilityLabel={`${labels[field]} in CNY`}
                keyboardType="decimal-pad"
                style={styles.input}
                value={draft[field]}
                onChangeText={(value) => {
                  setDraft((current) =>
                    current ? { ...current, [field]: value } : current,
                  );
                  setInputError("");
                }}
              />
            </View>
          ))}
          {inputError ? (
            <Text accessibilityRole="alert" style={styles.alert}>
              {inputError}
            </Text>
          ) : null}
          <Text style={styles.note}>
            Raising any limit requires a fresh simulated biometric step in this
            local demo. Tightening uses your owner session.
          </Text>
          <PolicyButton
            testID="save-policy-limits"
            label={busy ? "Updating limits..." : "Review limit change"}
            disabled={!editable}
            onPress={save}
          />
          <PolicyButton
            label="Cancel edit"
            light
            disabled={busy}
            onPress={() => {
              setEditing(false);
              setInputError("");
            }}
          />
        </View>
      ) : snapshot ? (
        <PolicyButton
          testID="edit-policy-limits"
          label="Edit spending limits"
          disabled={!editable}
          onPress={() => setEditing(true)}
        />
      ) : null}
      <PolicyButton
        testID="refresh-policy-limits"
        label="Refresh policy and contract caps"
        light
        disabled={busy}
        onPress={onRefresh}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: "#FFFFFF",
    borderColor: "#E8E3EB",
    borderRadius: 9,
    borderWidth: 1,
    padding: 18,
  },
  title: { color: "#16131C", fontSize: 17, fontWeight: "800" },
  status: { color: "#315E43", fontSize: 12, lineHeight: 18, marginTop: 8 },
  alert: { color: "#A83843", fontSize: 12, lineHeight: 18, marginTop: 8 },
  groupTitle: {
    color: "#703BB6",
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 0.6,
    marginTop: 18,
    marginBottom: 4,
  },
  row: {
    alignItems: "flex-start",
    borderBottomColor: "#E8E3EB",
    borderBottomWidth: 1,
    flexDirection: "row",
    gap: 12,
    justifyContent: "space-between",
    paddingVertical: 9,
  },
  rowLabel: { color: "#716D79", flex: 1, fontSize: 12, lineHeight: 17 },
  rowValue: {
    color: "#16131C",
    fontSize: 12,
    fontWeight: "700",
    textAlign: "right",
  },
  note: { color: "#716D79", fontSize: 11, lineHeight: 16, marginTop: 9 },
  editor: { borderTopColor: "#E8E3EB", borderTopWidth: 1, marginTop: 16 },
  field: { marginTop: 12 },
  fieldLabel: { color: "#554C60", fontSize: 12, fontWeight: "700" },
  input: {
    borderColor: "#D8D0E1",
    borderRadius: 7,
    borderWidth: 1,
    color: "#16131C",
    fontSize: 16,
    marginTop: 5,
    minHeight: 44,
    paddingHorizontal: 12,
  },
  button: {
    alignItems: "center",
    backgroundColor: "#16131C",
    borderRadius: 24,
    justifyContent: "center",
    marginTop: 10,
    minHeight: 47,
    paddingHorizontal: 12,
  },
  buttonLight: { backgroundColor: "#F0E9F7" },
  disabled: { opacity: 0.45 },
  buttonText: {
    color: "#FFFFFF",
    fontSize: 12,
    fontWeight: "800",
    textAlign: "center",
  },
  buttonTextLight: { color: "#16131C" },
});
