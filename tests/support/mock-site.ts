// A fake website for crawler and analysis tests: a map of URL -> response, with call tracking.
import type { Fetched, PageFetcher } from "../../src/lib/social/safeFetch";

type Page = { status?: number; type?: string; body?: string; redirect?: string; delayMs?: number; error?: string };

export function mockSite(pages: Record<string, Page | string>) {
  const calls: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fetcher: PageFetcher = async (url) => {
    calls.push(url);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      const raw = pages[url];
      const p: Page = typeof raw === "string" ? { body: raw } : raw ?? { status: 404, body: "not found", type: "text/html" };
      if (p.delayMs) await new Promise((r) => setTimeout(r, p.delayMs));
      if (p.error) throw new Error(p.error);
      const final = p.redirect ?? url;
      const target = p.redirect ? pages[p.redirect] : p;
      const t: Page = typeof target === "string" ? { body: target } : target ?? { status: 404 };
      const out: Fetched = { url: final, status: t.status ?? 200, contentType: t.type ?? (final.endsWith(".xml") || final.endsWith(".txt") ? "text/plain" : "text/html; charset=utf-8"), body: t.body ?? "" };
      return out;
    } finally {
      inFlight--;
    }
  };
  return { fetcher, calls, maxInFlight: () => maxInFlight };
}

// A small roofing business website with structured data, contact details, service pages and a blog.
export function roofingSite(origin = "https://www.copperasroofing.test", overrides: Record<string, Page | string> = {}) {
  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "WebSite", name: "Copperas Roofing", url: `${origin}/` },
      {
        "@type": "RoofingContractor",
        name: "Copperas Cove Roofing Co.",
        telephone: "(254) 555-0142",
        email: "hello@copperasroofing.test",
        url: `${origin}/`,
        logo: `${origin}/img/logo.png`,
        image: [`${origin}/img/crew.jpg`],
        address: { "@type": "PostalAddress", streetAddress: "120 Main St", addressLocality: "Copperas Cove", addressRegion: "TX", postalCode: "76522", addressCountry: "US" },
        openingHoursSpecification: [{ "@type": "OpeningHoursSpecification", dayOfWeek: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"], opens: "08:00", closes: "17:00" }],
        areaServed: [{ "@type": "City", name: "Copperas Cove" }, "Killeen", "Harker Heights"],
        sameAs: ["https://www.facebook.com/copperasroofing", "https://www.instagram.com/copperasroofing/"],
        aggregateRating: { "@type": "AggregateRating", ratingValue: "4.9", reviewCount: "212" },
      },
    ],
  };
  const layout = (title: string, main: string) => `<!doctype html><html><head><title>${title}</title>
<meta name="description" content="Roof leak repair and roof replacement in Copperas Cove, TX.">
<meta property="og:site_name" content="Copperas Roofing">
<meta property="og:image" content="${origin}/img/og.jpg">
<link rel="canonical" href="${origin}/">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
</head><body>
<header><img src="/img/logo.png" alt="Copperas Roofing logo" class="site-logo">
<nav><a href="/services/roof-leak-repair">Roof Leak Repair</a> <a href="/services/roof-replacement">Roof Replacement</a> <a href="/about">About us</a> <a href="/contact">Contact</a> <a href="/blog/signs-of-a-roof-leak">Blog</a> <a href="https://othersite.test/x">Partner</a> <a href="/private/services-pricing">Pricing</a></nav></header>
<main>${main}</main>
<footer><a href="tel:+12545550142">(254) 555-0142</a> <a href="mailto:hello@copperasroofing.test">Email us</a>
<a href="https://www.facebook.com/sharer/sharer.php?u=x">Share</a> <a href="https://www.facebook.com/copperasroofing">Facebook</a> <a href="https://x.com/copperasroof">X</a>
<p>Mon - Fri: 8am - 5pm</p></footer></body></html>`;
  return {
    [`${origin.replace("www.", "")}/robots.txt`]: { status: 404 },
    [`${origin}/robots.txt`]: { body: "User-agent: *\nDisallow: /private/\n\nSitemap: " + origin + "/sitemap.xml", type: "text/plain" },
    [`${origin.replace("www.", "")}/`]: { redirect: `${origin}/` },
    [`${origin}/`]: layout(
      "Roof Repair in Copperas Cove | Copperas Roofing",
      `<h1>Roof leak repair you can count on</h1><p>Family-owned and serving Copperas Cove since 2009.</p><p>We offer free roof inspections after every storm.</p>
       <p>Our crew is licensed and insured in the state of Texas.</p><p>Call (254) 555-0142 today.</p><p>Visit us near 99 Fake Road if you are in the area.</p>`,
    ),
    [`${origin}/services/roof-leak-repair`]: layout("Roof Leak Repair | Copperas Roofing", "<h1>Roof Leak Repair</h1><p>We find and fix leaks fast.</p>"),
    [`${origin}/services/roof-replacement`]: layout("Roof Replacement | Copperas Roofing", "<h1>Roof Replacement</h1><p>Full tear-off and replacement.</p>"),
    [`${origin}/about`]: layout("About | Copperas Roofing", "<h1>About us</h1><p>We are a local team.</p>"),
    [`${origin}/contact`]: layout("Contact | Copperas Roofing", "<h1>Contact</h1><address>120 Main St<br>Copperas Cove, TX 76522</address>"),
    [`${origin}/blog/signs-of-a-roof-leak`]: layout("Early signs of a roof leak | Copperas Roofing", "<h1>Early signs of a roof leak</h1><p>Look for ceiling stains.</p>"),
    [`${origin}/private/services-pricing`]: layout("Pricing", "<h1>secret</h1>"),
    [`${origin}/sitemap.xml`]: {
      type: "application/xml",
      body: `<?xml version="1.0"?><urlset><url><loc>${origin}/</loc></url><url><loc>${origin}/service-areas/killeen</loc></url><url><loc>${origin}/blog/what-to-check-after-a-storm</loc></url></urlset>`,
    },
    [`${origin}/service-areas/killeen`]: layout("Roofing in Killeen | Copperas Roofing", "<h1>Roof Repair in Killeen</h1>"),
    ...overrides,
  } as Record<string, Page | string>;
}
