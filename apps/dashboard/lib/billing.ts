/* Plans + quotas + payment-provider seam. The default provider is Polar
   (polar.sh) — a Merchant of Record you can onboard as an individual (no company),
   it handles tax/VAT and supports subscriptions + usage-based billing. Clerk
   Billing needs Stripe, so it's not used. Until POLAR_* is configured the billing
   page is informational and metering still works. */

export type PlanId = "oss" | "free" | "creator" | "studio" | "team";

export interface Plan {
  id: PlanId;
  name: string;
  priceMonthly: number; // USD
  tagline: string;
  quota: { postsPerMonth: number; devices: number; seats: number; brands: number };
  features: string[];
  cta?: string;
  highlight?: boolean;
}

export const PLANS: Plan[] = [
  {
    id: "oss",
    name: "Open Source",
    priceMonthly: 0,
    tagline: "Self-hosted, no limits.",
    quota: { postsPerMonth: Infinity, devices: Infinity, seats: Infinity, brands: Infinity },
    features: ["Everything, no limits", "Self-host the whole stack", "MIT / AGPL core"],
  },
  {
    id: "free",
    name: "Free",
    priceMonthly: 0,
    tagline: "Kick the tires.",
    quota: { postsPerMonth: 5, devices: 1, seats: 1, brands: 1 },
    features: ["5 posts / month", "1 render device", "YouTube + export bundle", "Community support"],
  },
  {
    id: "creator",
    name: "Creator",
    priceMonthly: 19,
    tagline: "For a serious solo channel.",
    quota: { postsPerMonth: 60, devices: 3, seats: 1, brands: 3 },
    features: ["60 posts / month", "3 render devices", "Live YouTube · Instagram · TikTok", "Autopilot scheduling", "Email support"],
    highlight: true,
  },
  {
    id: "studio",
    name: "Studio",
    priceMonthly: 79,
    tagline: "Multi-channel operation.",
    quota: { postsPerMonth: 300, devices: 12, seats: 5, brands: 10 },
    features: ["300 posts / month", "Up to 12 devices", "All platforms + analytics", "Priority fleet routing", "5 team seats", "Priority support"],
  },
  {
    id: "team",
    name: "Team",
    priceMonthly: 199,
    tagline: "Agencies & studios.",
    quota: { postsPerMonth: 1500, devices: 50, seats: 25, brands: 50 },
    features: ["1,500 posts / month", "Unlimited-ish devices", "Org roles & SSO-ready", "25 seats", "Usage-based overages", "Dedicated support"],
  },
];

export const planById = (id?: string): Plan => PLANS.find((p) => p.id === id) ?? PLANS[0];

/* Provider status — what's wired. */
export function billingProvider(): { provider: "polar" | "none"; configured: boolean; checkoutBase?: string; portalUrl?: string } {
  const k = (n: string) => process.env[n];
  if (k("POLAR_ACCESS_TOKEN") || k("POLAR_ORGANIZATION_ID")) {
    return { provider: "polar", configured: true, checkoutBase: process.env.POLAR_CHECKOUT_URL, portalUrl: process.env.POLAR_PORTAL_URL };
  }
  return { provider: "polar", configured: false };
}

/* Socheli is fully OPEN SOURCE — no billing, no plan gating. Everyone is on the
   unlimited "oss" plan. SOCHELI_PLAN can still pin a tier if someone re-introduces
   paid plans later, but by default nothing is capped. */
export function currentPlanId(): PlanId {
  if (process.env.SOCHELI_PLAN) return process.env.SOCHELI_PLAN as PlanId;
  return "oss";
}
