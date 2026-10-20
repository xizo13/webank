import { StyleSheet, Text, View } from "react-native";
import type { Agent } from "./flow";

type Light = Agent["licence"]["level"];

const descriptions: Record<Light, string> = {
  AMBER: "Every purchase needs your approval.",
  GREEN: "Eligible purchases may proceed within your auto-approve threshold.",
  RED: "Spending is blocked until you review and return this agent to Amber.",
};

export function TrustLight({
  light,
  reason,
  frozen = false,
}: {
  light: Light;
  reason: string;
  frozen?: boolean;
}) {
  return (
    <View style={styles.container} testID="trust-light">
      <View
        accessible
        accessibilityLabel={`${light} trust light. ${descriptions[light]}`}
        accessibilityRole="text"
        style={[
          styles.badge,
          light === "AMBER"
            ? styles.amber
            : light === "GREEN"
              ? styles.green
              : styles.red,
        ]}
      >
        <Text style={styles.badgeText}>{light}</Text>
      </View>
      <Text style={styles.reason} numberOfLines={1} testID="trust-reason">
        {reason || descriptions[light]}
      </Text>
      {frozen ? (
        <Text style={styles.frozen} testID="trust-freeze-state">
          Separately frozen by owner
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { alignItems: "flex-start", gap: 5, marginTop: 9 },
  badge: { borderRadius: 12, paddingHorizontal: 10, paddingVertical: 4 },
  amber: { backgroundColor: "#FFF3D1" },
  green: { backgroundColor: "#ECF8F1" },
  red: { backgroundColor: "#FFF0F0" },
  badgeText: { color: "#16131C", fontSize: 11, fontWeight: "800" },
  reason: { color: "#554C60", fontSize: 12, lineHeight: 18 },
  frozen: { color: "#AF4148", fontSize: 12, fontWeight: "700" },
});
