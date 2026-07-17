import type { ReactNode } from "react";
import Link from "next/link";
import { branding } from "@/lib/api";
import "./globals.css";

export const metadata = {
  title: `${branding.name} Admin`,
  description: "Aggregate adoption, cost, value, and audit for the organization.",
};

const NAV = [
  ["Overview", "/"],
  ["Agents", "/agents"],
  ["Policies", "/policies"],
  ["Budgets", "/budgets"],
  ["Audit", "/audit"],
  ["Privacy", "/privacy"],
] as const;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <nav className="top">
          <span className="brand">{branding.name} Admin</span>
          {NAV.map(([label, href]) => (
            <Link key={href} href={href}>
              {label}
            </Link>
          ))}
        </nav>
        <div className="container">{children}</div>
      </body>
    </html>
  );
}
