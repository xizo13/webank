import Link from "next/link";
import { formatCny, type ShopId, shops } from "../lib/catalog";
import { listProducts } from "../lib/store";
import { ProductArt } from "./product-art";

export const dynamic = "force-dynamic";

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ shop?: string; q?: string }>;
}) {
  const params = await searchParams;
  const shop =
    params.shop && params.shop in shops ? (params.shop as ShopId) : undefined;
  const results = listProducts(params.q || "", undefined, shop);
  return (
    <main>
      <section className="hero">
        <div className="hero-copy">
          <div className="eyebrow">
            <span className="eyebrow-line" /> THE AGENT SHOPPING SANDBOX
          </div>
          <h1>
            A better way to <em>buy with trust.</em>
          </h1>
          <p>
            Explore four simulated shops. Compare products, build a cart, and
            pass a signed payment request to the WeBank Agent Wallet.
          </p>
          <div className="hero-actions">
            <a href="#catalog" className="button primary">
              Explore products <span>↗</span>
            </a>
            <Link href="/demo" className="button ghost">
              Demo controls
            </Link>
          </div>
        </div>
        <div className="hero-visual" aria-hidden="true">
          <div className="orbit orbit-one" />
          <div className="orbit orbit-two" />
          <div className="hero-disc">
            <span>
              SHOP
              <br />
              WITH
              <br />
              GUARDRAILS
            </span>
          </div>
          <div className="hero-spark">✳</div>
        </div>
      </section>
      <section id="catalog" className="catalog-shell">
        <div className="section-top">
          <div>
            <div className="eyebrow dark">CURATED FOR THE DEMO</div>
            <h2>Shop the scenario</h2>
          </div>
          <p>Real checkout mechanics, simulated products and currency.</p>
        </div>
        <div className="toolbar">
          <div className="filters">
            <Link className={!shop ? "active" : ""} href="/">
              All shops
            </Link>
            {(Object.keys(shops) as ShopId[]).map((key) => (
              <Link
                key={key}
                className={shop === key ? "active" : ""}
                href={`/?shop=${key}`}
              >
                {shops[key].name}
              </Link>
            ))}
          </div>
          <form className="search" action="/">
            <input
              type="search"
              name="q"
              placeholder="Search products"
              defaultValue={params.q || ""}
              aria-label="Search products"
            />
            <button type="submit">↗</button>
          </form>
        </div>
        <div className="product-grid">
          {results.map((product) => (
            <Link
              className="product-card"
              href={`/p/${encodeURIComponent(product.sku)}`}
              key={product.sku}
            >
              <div className={`product-image image-${product.image}`}>
                <ProductArt kind={product.image} />
                <span className="image-index">{shops[product.shop].tag}</span>
              </div>
              <div className="product-meta">
                <span>{shops[product.shop].name}</span>
                <span>★ {product.rating.toFixed(1)}</span>
              </div>
              <h3>{product.name}</h3>
              <p>{product.summary}</p>
              <div className="product-bottom">
                <strong>{formatCny(product.price)}</strong>
                <span className="round-arrow">↗</span>
              </div>
            </Link>
          ))}
        </div>
        {!results.length && (
          <div className="empty">No products match this search.</div>
        )}
      </section>
      <section className="trust-band">
        <div className="eyebrow">THE DEMO RULE</div>
        <p>
          Shopping content is untrusted.{" "}
          <span>Every payment goes through WeBank's checks.</span>
        </p>
        <Link href="/demo">Explore the scenarios ↗</Link>
      </section>
    </main>
  );
}
