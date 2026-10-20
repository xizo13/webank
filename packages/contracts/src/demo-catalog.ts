/** Trusted identities for the local mock shops only. Production merchants need a rail registry. */
export type DemoVariant = {
  sku: string;
  gtin: string;
  merchant_id: string;
  brand: string;
  model: string;
  variant: string;
  options: { colour?: string; size?: string };
};

export const demoVariants: readonly DemoVariant[] = [
  {
    sku: "NOVA-Q3-BLK",
    gtin: "6901234567001",
    merchant_id: "mch_shopA",
    brand: "Nova",
    model: "Quiet 3",
    variant: "Black",
    options: { colour: "Black", size: "One size" },
  },
  {
    sku: "NOVA-Q3-STN",
    gtin: "6901234567003",
    merchant_id: "mch_shopA",
    brand: "Nova",
    model: "Quiet 3",
    variant: "Stone",
    options: { colour: "Stone", size: "One size" },
  },
  {
    sku: "NOVA-Q2-BLK",
    gtin: "6901234567002",
    merchant_id: "mch_shopA",
    brand: "Nova",
    model: "Quiet 2",
    variant: "Black",
    options: { colour: "Black", size: "One size" },
  },
  {
    sku: "FIELD-COAT-BLK-S",
    gtin: "6901234567103",
    merchant_id: "mch_shopB",
    brand: "Field",
    model: "Work jacket",
    variant: "Black / S",
    options: { colour: "Black", size: "S" },
  },
  {
    sku: "FIELD-COAT-BLK-M",
    gtin: "6901234567101",
    merchant_id: "mch_shopB",
    brand: "Field",
    model: "Work jacket",
    variant: "Black / M",
    options: { colour: "Black", size: "M" },
  },
  {
    sku: "FIELD-COAT-BLK-L",
    gtin: "6901234567104",
    merchant_id: "mch_shopB",
    brand: "Field",
    model: "Work jacket",
    variant: "Black / L",
    options: { colour: "Black", size: "L" },
  },
  {
    sku: "FIELD-COAT-OLV-S",
    gtin: "6901234567105",
    merchant_id: "mch_shopB",
    brand: "Field",
    model: "Work jacket",
    variant: "Olive / S",
    options: { colour: "Olive", size: "S" },
  },
  {
    sku: "FIELD-COAT-OLV-M",
    gtin: "6901234567106",
    merchant_id: "mch_shopB",
    brand: "Field",
    model: "Work jacket",
    variant: "Olive / M",
    options: { colour: "Olive", size: "M" },
  },
  {
    sku: "FIELD-COAT-OLV-L",
    gtin: "6901234567107",
    merchant_id: "mch_shopB",
    brand: "Field",
    model: "Work jacket",
    variant: "Olive / L",
    options: { colour: "Olive", size: "L" },
  },
  {
    sku: "FIELD-COFFEE-1KG",
    gtin: "6901234567102",
    merchant_id: "mch_shopB",
    brand: "Field",
    model: "Morning roast coffee beans",
    variant: "1 kg",
    options: { size: "1 kg" },
  },
  {
    sku: "FLASH-Q3-FEE",
    gtin: "6901234567901",
    merchant_id: "mch_malicious",
    brand: "Flash Deal",
    model: "Priority dispatch fee",
    variant: "Standard",
    options: {},
  },
  {
    sku: "REWARD-GIFT-500",
    gtin: "6901234567999",
    merchant_id: "mch_decoy",
    brand: "Reward Vault",
    model: "Instant reward voucher",
    variant: "Standard",
    options: {},
  },
];

export function demoVariantBySku(sku: string): DemoVariant | undefined {
  return demoVariants.find((item) => item.sku === sku);
}
