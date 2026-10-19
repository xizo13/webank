import Link from "next/link";
import type { ReactNode } from "react";
import "./styles.css";

export const metadata = {
  title: "BaoTaoShop | Simulated storefront",
  description: "BaoTaoShop simulated storefront for e-CNY payment requests",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="demo-banner">
          SIMULATED STORES + SIMULATED E-CNY <span>NO REAL MONEY MOVES</span>
        </div>
        <header className="site-header">
          <Link className="brand" href="/">
            <span className="brand-mark">
              B<span>·</span>
            </span>
            <span>BaoTaoShop</span>
          </Link>
          <nav aria-label="Main navigation">
            <Link href="/">Shop</Link>
            <Link href="/cart">Cart</Link>
            <Link href="/demo">Demo controls</Link>
          </nav>
          <div className="header-status">
            <span className="status-dot" /> SANDBOX LIVE
          </div>
        </header>
        {children}
        <footer className="site-footer">
          <div className="brand">
            <span className="brand-mark">
              B<span>·</span>
            </span>
            <span>BaoTaoShop</span>
          </div>
          <span>Independent mock merchants in this storefront.</span>
          <span>© 2026 demo sandbox</span>
        </footer>
      </body>
    </html>
  );
}
