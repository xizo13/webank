import { StyleSheet, Text, View } from "react-native";

export function PairingClientScope({
  clientAppName,
  publicKey,
}: {
  clientAppName?: string | null;
  publicKey: string;
}) {
  return (
    <View testID="pairing-client-scope">
      <Text style={styles.label}>Client app</Text>
      <Text style={styles.value} testID="pairing-client-app">
        {clientAppName || "Client app identity unavailable"}
      </Text>
      <Text style={styles.body} testID="pairing-app-scope">
        {clientAppName
          ? `This connection covers every chat in ${clientAppName}.`
          : "This connection cannot be approved without a client app identity."}
      </Text>
      <Text style={styles.body} testID="pairing-key-preview">
        Agent key: {publicKey.slice(0, 22)}...
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  label: { color: "#716D79", fontSize: 11, fontWeight: "700", marginTop: 10 },
  value: { color: "#16131C", fontSize: 13, lineHeight: 19, marginTop: 3 },
  body: { color: "#554C60", fontSize: 12, lineHeight: 18, marginTop: 8 },
});
