import Link from "next/link";
import { notFound } from "next/navigation";
import { formatCny, shops } from "../../../lib/catalog";
import { productBySku } from "../../../lib/store";
import { ProductArt } from "../../product-art";
import { ProductActions } from "./product-actions";

export const dynamic = "force-dynamic";

export default async function ProductPage({
  params,
}: {
  params: Promise<{ sku: string }>;
}) {
  const { sku } = await params;
  const product = productBySku(decodeURIComponent(sku));
  if (!product) notFound();
  return (
    <main className="inner-page">
      <div className="breadcrumb">
        <Link href="/">All products</Link>
        <span>/</span>
        <Link href={`/?shop=${product.shop}`}>{shops[product.shop].name}</Link>
        <span>/</span>
        {product.sku}
      </div>
      <div className="detail-grid">
        <div className={`detail-image image-${product.image}`}>
          <ProductArt kind={product.image} />
          <span className="detail-image-label">{shops[product.shop].tag}</span>
        </div>
        <div className="detail-info">
          <div className="eyebrow dark">
            {shops[product.shop].name} / {product.category.toUpperCase()}
          </div>
          <h1>{product.name}</h1>
          <div className="detail-price">
            {formatCny(product.price)} <span>SIMULATED CNY</span>
          </div>
          <p className="detail-lead">{product.summary}</p>
          <p className="detail-description">{product.description}</p>
          {(product.shop === "malicious" || product.shop === "decoy") && (
            <div className="scenario-note">
              Scenario content: this seller text is untrusted. The wallet must
              evaluate the actual merchant and item before any payment.
            </div>
          )}
          <ProductActions
            sku={product.sku}
            sizes={product.sizes}
            colours={product.colours}
          />
          <div className="detail-metadata">
            <div>
              <span>Merchant ID</span>
              <strong>{shops[product.shop].merchantId}</strong>
            </div>
            <div>
              <span>Product code</span>
              <strong>{product.gtin}</strong>
            </div>
            <div>
              <span>Condition</span>
              <strong>{product.condition}</strong>
            </div>
          </div>
        </div>
      </div>
      <section className="detail-lower">
        <div>
          <div className="eyebrow dark">THE DETAILS</div>
          <h2>Made for a closer look.</h2>
          <p>
            Specifications and reviews are available to your shopping agent
            through the same catalog tools.
          </p>
        </div>
        <div className="spec-list">
          {Object.entries(product.specs).map(([key, value]) => (
            <div key={key}>
              <span>{key}</span>
              <strong>{value}</strong>
            </div>
          ))}
        </div>
        <div className="reviews">
          <h3>Customer notes</h3>
          {product.reviews.map((review) => (
            <blockquote key={review}>“{review}”</blockquote>
          ))}
        </div>
      </section>
    </main>
  );
}
