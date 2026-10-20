import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { formatMoney } from "./flow";
import type { TransferDirection } from "./transferFlow";

export function TransferControl({
  direction,
  amountInput,
  sourceBalanceFen,
  busy,
  reviewDisabled = false,
  onReverse,
  onAmountChange,
  onReview,
}: {
  direction: TransferDirection;
  amountInput: string;
  sourceBalanceFen: number | null;
  busy: boolean;
  reviewDisabled?: boolean;
  onReverse: () => void;
  onAmountChange: (value: string) => void;
  onReview: () => void;
}) {
  const returning = direction === "return";
  return (
    <View style={styles.card} testID="owner-transfer-control">
      <Text accessibilityRole="header" style={styles.title}>
        Transfer between your accounts
      </Text>
      <View style={styles.route}>
        <View style={styles.account}>
          <Text style={styles.label}>FROM</Text>
          <Text style={styles.value}>
            {returning ? "Agent Wallet" : "WeBank main account"}
          </Text>
        </View>
        <Text style={styles.arrow}>↓</Text>
        <View style={styles.account}>
          <Text style={styles.label}>TO</Text>
          <Text style={styles.value}>
            {returning ? "WeBank main account" : "Agent Wallet"}
          </Text>
        </View>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Reverse transfer direction"
        accessibilityState={{ disabled: busy }}
        testID="reverse-transfer"
        disabled={busy}
        onPress={onReverse}
        style={[styles.reverse, busy && styles.disabled]}
      >
        <Text style={styles.reverseText}>↕ Reverse direction</Text>
      </Pressable>
      <Text style={styles.balance}>
        {returning ? "Unreserved Agent Wallet funds" : "Main account balance"}
        {": "}
        {sourceBalanceFen === null
          ? "Unavailable"
          : formatMoney(sourceBalanceFen)}
      </Text>
      <Text style={styles.label}>AMOUNT IN CNY</Text>
      <TextInput
        testID="transfer-amount"
        accessibilityLabel="Transfer amount in CNY"
        keyboardType="decimal-pad"
        style={styles.input}
        value={amountInput}
        onChangeText={onAmountChange}
        placeholder="0.00"
        placeholderTextColor="#AAA5AF"
      />
      {returning ? (
        <Text style={styles.note}>
          Only unreserved funds can return to your fixed main account. The full
          available amount is filled in when you reverse direction.
        </Text>
      ) : (
        <Text style={styles.note}>
          Funding moves simulated CNY into the separate Agent Wallet after your
          owner confirmation.
        </Text>
      )}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={
          returning ? "Review return" : "Review funding transfer"
        }
        accessibilityState={{
          disabled: busy || reviewDisabled || sourceBalanceFen === null,
        }}
        testID={returning ? "review-sweep" : "review-funding"}
        disabled={busy || reviewDisabled || sourceBalanceFen === null}
        onPress={onReview}
        style={[
          styles.review,
          (busy || reviewDisabled || sourceBalanceFen === null) &&
            styles.disabled,
        ]}
      >
        <Text style={styles.reviewText}>
          {returning ? "Review return" : "Review transfer"}
        </Text>
      </Pressable>
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
  route: { marginTop: 14 },
  account: {
    backgroundColor: "#F7F4FA",
    borderRadius: 7,
    padding: 11,
  },
  label: {
    color: "#716D79",
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.8,
    marginBottom: 5,
  },
  value: { color: "#16131C", fontSize: 14, fontWeight: "700" },
  arrow: { color: "#703BB6", fontSize: 20, textAlign: "center" },
  reverse: {
    alignItems: "center",
    backgroundColor: "#F0E9F7",
    borderRadius: 24,
    justifyContent: "center",
    marginTop: 10,
    minHeight: 44,
  },
  reverseText: { color: "#16131C", fontSize: 12, fontWeight: "800" },
  balance: {
    color: "#554C60",
    fontSize: 12,
    lineHeight: 18,
    marginVertical: 14,
  },
  input: {
    borderColor: "#D8D0E1",
    borderRadius: 7,
    borderWidth: 1,
    color: "#16131C",
    fontSize: 16,
    minHeight: 44,
    paddingHorizontal: 12,
  },
  note: { color: "#716D79", fontSize: 11, lineHeight: 16, marginTop: 9 },
  review: {
    alignItems: "center",
    backgroundColor: "#16131C",
    borderRadius: 24,
    justifyContent: "center",
    marginTop: 13,
    minHeight: 47,
  },
  reviewText: { color: "#FFFFFF", fontSize: 12, fontWeight: "800" },
  disabled: { opacity: 0.45 },
});
