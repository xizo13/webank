import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { formatMoney } from "./flow";
import { type PaymentReview, reviewConstraintRows } from "./paymentReview";

function Field({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.value}>{value}</Text>
    </View>
  );
}

function fingerprint(hash: string) {
  return `${hash.slice(0, 18)}…${hash.slice(-8)}`;
}

export function PaymentReviewCard({
  review,
  secondsLeft,
}: {
  review: PaymentReview;
  secondsLeft: number;
}) {
  const mandate = review.mandate_snapshot.mandate;
  const order = review.signed_order;
  const [showVerification, setShowVerification] = useState(false);
  const lineKeyCounts = new Map<string, number>();
  return (
    <View style={styles.card} testID="composite-payment-review">
      <View style={styles.headingRow}>
        <Text accessibilityRole="header" style={styles.heading}>
          Review this purchase
        </Text>
        <Text style={styles.timer}>{secondsLeft}s left</Text>
      </View>
      <Text style={styles.intro}>
        One approval covers this locked request and this merchant-signed order.
      </Text>

      <View style={styles.section}>
        <Text accessibilityRole="header" style={styles.sectionTitle}>
          Locked intent
        </Text>
        <Field
          label={
            mandate.user_text_source === "agent_reported"
              ? "User request, reported by the agent (unconfirmed)"
              : "Your words, confirmed in WeBank"
          }
          value={mandate.user_text}
        />
        <Field label="Agent summary" value={mandate.description} />
        <Field label="Intent level" value={mandate.intent_level} />
        <Field label="Approval timing" value="At this payment" />
        {reviewConstraintRows(review).map((row) => (
          <Field key={row.label} {...row} />
        ))}
      </View>

      <View style={styles.section}>
        <Text accessibilityRole="header" style={styles.sectionTitle}>
          Merchant-signed order
        </Text>
        <Field label="Legal payee" value={order.merchant_legal_name} />
        <Field label="Company code (USCC)" value={order.merchant_uscc} />
        {order.line_items.map((item, index) => {
          const baseKey =
            item.type === "product"
              ? `product:${item.sku}`
              : `shipping:${item.name}`;
          const occurrence = lineKeyCounts.get(baseKey) ?? 0;
          lineKeyCounts.set(baseKey, occurrence + 1);
          return (
            <View key={`${baseKey}:${occurrence}`} style={styles.item}>
              <Text style={styles.itemTitle}>
                {item.type === "shipping" ? "Shipping" : `Item ${index + 1}`}
              </Text>
              <Field label="Name" value={item.name} />
              {item.type === "product" ? (
                <>
                  <Field label="Variant" value={item.variant} />
                  <Field
                    label="Options"
                    value={
                      Object.entries(item.options)
                        .map(([key, value]) => `${key}: ${value}`)
                        .join(", ") || "None"
                    }
                  />
                  <Field label="Condition" value={item.condition} />
                  <Field label="SKU" value={item.sku} />
                  <Field label="GTIN" value={item.gtin} />
                </>
              ) : null}
              <Field label="Quantity" value={String(item.qty)} />
              <Field
                label="Unit price"
                value={formatMoney(item.unit_price.amount)}
              />
              <Field
                label="Line total"
                value={formatMoney(item.unit_price.amount * item.qty)}
              />
            </View>
          );
        })}
        <Field label="Signed order expires" value={order.expires_at} />
        <View style={styles.totalRow}>
          <Text style={styles.totalLabel}>Exact total</Text>
          <Text style={styles.totalValue} testID="signed-order-total">
            {formatMoney(order.amount.amount)}
          </Text>
        </View>
      </View>

      <Text style={styles.hash}>
        Approval action hash: {fingerprint(review.payload_hash)}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={
          showVerification
            ? "Hide verification details"
            : "Show verification details"
        }
        accessibilityState={{ expanded: showVerification }}
        onPress={() => setShowVerification((shown) => !shown)}
        style={styles.detailsToggle}
        testID="toggle-review-verification"
      >
        <Text style={styles.detailsToggleText}>
          {showVerification
            ? "Hide verification details"
            : "Show verification details"}
        </Text>
      </Pressable>
      {showVerification ? (
        <View style={styles.section} testID="review-verification-details">
          <Text accessibilityRole="header" style={styles.sectionTitle}>
            Verification details
          </Text>
          <Field label="Mandate ID" value={mandate.mandate_id} />
          <Field label="Agent ID" value={mandate.agent_id} />
          <Field label="Agent key binding" value={mandate.agent_key_binding} />
          <Field label="Merchant ID" value={order.merchant_id} />
          <Field label="Order ID" value={order.order_id} />
          <Field
            label="Intent hash"
            value={review.mandate_snapshot.canonical_hash}
          />
          <Field label="Signed order hash" value={order.payment_request_hash} />
          <Field label="Approval action hash" value={review.payload_hash} />
          {review.decision_checks.map((check) => {
            const explanation =
              typeof check.detail?.explanation === "string"
                ? check.detail.explanation
                : typeof check.detail?.reason === "string"
                  ? check.detail.reason.replace(/_/g, " ")
                  : null;
            return (
              <Field
                key={check.name}
                label={check.name.replace(/_/g, " ")}
                value={[check.result.replace(/_/g, " "), explanation]
                  .filter(Boolean)
                  .join(" - ")}
              />
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: "#FFFFFF",
    borderColor: "#E8E3EB",
    borderWidth: 1,
    borderRadius: 9,
    padding: 18,
    marginBottom: 12,
  },
  headingRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
  },
  heading: { color: "#16131C", fontSize: 19, fontWeight: "800", flex: 1 },
  timer: { color: "#703BB6", fontSize: 12, fontWeight: "800" },
  intro: { color: "#554C60", fontSize: 12, lineHeight: 18, marginTop: 8 },
  section: {
    borderTopColor: "#E8E3EB",
    borderTopWidth: 1,
    marginTop: 17,
    paddingTop: 15,
  },
  sectionTitle: {
    color: "#16131C",
    fontSize: 15,
    fontWeight: "800",
    marginBottom: 5,
  },
  field: { marginTop: 9 },
  label: { color: "#716D79", fontSize: 11, fontWeight: "700" },
  value: { color: "#16131C", fontSize: 13, lineHeight: 19, marginTop: 3 },
  item: {
    borderColor: "#E8E3EB",
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    marginTop: 12,
  },
  itemTitle: { color: "#703BB6", fontSize: 12, fontWeight: "800" },
  totalRow: {
    borderTopColor: "#E8E3EB",
    borderTopWidth: 1,
    marginTop: 15,
    paddingTop: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  totalLabel: { color: "#16131C", fontSize: 15, fontWeight: "800" },
  totalValue: { color: "#16131C", fontSize: 23, fontWeight: "800" },
  hash: { color: "#716D79", fontSize: 10, marginTop: 17 },
  detailsToggle: { marginTop: 12, paddingVertical: 8 },
  detailsToggleText: { color: "#703BB6", fontSize: 12, fontWeight: "700" },
});
