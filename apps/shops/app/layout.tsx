import Link from "next/link";
import type { ReactNode } from "react";
import "./styles.css";

export const metadata = {
  title: "Arc Market | WeBank Agent Wallet demo",
  description: "Simulated storefront for WeBank Agent Wallet",
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
              W<span>·</span>
            </span>
            <span>
              WE<span>BANK</span> MARKET
            </span>
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
              W<span>·</span>
            </span>
            <span>
              WE<span>BANK</span> MARKET
            </span>
          </div>
          <span>
            Independent mock merchants for the Agent Wallet prototype.
          </span>
          <span>© 2026 demo sandbox</span>
        </footer>
      </body>
    </html>
  );
}
