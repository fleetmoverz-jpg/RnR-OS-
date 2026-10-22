// Turns fetched pages into candidate brand facts. Every candidate carries the page it came from, the
// text that supports it and a confidence. Nothing here guesses: an address, phone number, credential
// or claim is only produced when the website itself states it.
import { isArticleUrl, pageScore, sameSite } from "./crawler";

// ---- tiny HTML reader (enough for metadata, links, headings and visible text)

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…", copy: "©", reg: "®", trade: "™" };

export function decodeEntities(s: string) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const clean = (s: string) => decodeEntities(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

export function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g)) {
    out[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return out;
}

export type PageData = {
  url: string;
  title: string | null;
  meta: Record<string, string>;
  canonical: string | null;
  icons: string[];
  jsonLd: unknown[];
  links: { href: string; text: string; rel: string }[];
  images: { src: string; alt: string; cls: string }[];
  h1: string[];
  h2: string[];
  addresses: string[];
  text: string;
};

export function parsePage(url: string, html: string): PageData {
  const noComments = html.replace(/<!--[\s\S]*?-->/g, "");
  const jsonLd: unknown[] = [];
  for (const m of noComments.matchAll(/<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      jsonLd.push(JSON.parse(m[1].trim()));
    } catch {
      // Ignore broken structured data rather than guessing at it.
    }
  }
  const body = noComments.replace(/<(script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1>/gi, " ");
  const abs = (h: string) => {
    try {
      return new URL(h, url).toString();
    } catch {
      return null;
    }
  };

  const meta: Record<string, string> = {};
  let canonical: string | null = null;
  const icons: string[] = [];
  for (const m of noComments.matchAll(/<(meta|link)\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    if (m[1].toLowerCase() === "meta") {
      const key = (a.property || a.name || a.itemprop || "").toLowerCase();
      if (key && a.content && !(key in meta)) meta[key] = a.content.trim();
    } else {
      const rel = (a.rel || "").toLowerCase();
      if (rel.split(/\s+/).includes("canonical") && a.href) canonical = abs(a.href);
      if (/icon/.test(rel) && a.href) {
        const h = abs(a.href);
        if (h && rel.includes("apple-touch")) icons.unshift(h);
        else if (h) icons.push(h);
      }
    }
  }

  const links = [...body.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)].flatMap((m) => {
    const a = attrs(m[1]);
    return a.href ? [{ href: a.href.trim(), text: clean(m[2]) || a["aria-label"] || a.title || "", rel: a.rel || "" }] : [];
  });
  const images = [...body.matchAll(/<img\b[^>]*>/gi)].flatMap((m) => {
    const a = attrs(m[0]);
    const src = a.src || a["data-src"] || "";
    const full = src ? abs(src) : null;
    return full ? [{ src: full, alt: a.alt || "", cls: `${a.class || ""} ${a.id || ""}` }] : [];
  });
  const headings = (tag: string) => [...body.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "gi"))].map((m) => clean(m[1])).filter(Boolean);
  const addresses = [...body.matchAll(/<address\b[^>]*>([\s\S]*?)<\/address>/gi)].map((m) => clean(m[1].replace(/<br\s*\/?>/gi, ", "))).filter(Boolean);

  const text = decodeEntities(
    body
      .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article|\/header|\/footer)\b[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n\s*/g, "\n")
    .trim();

  const titleTag = noComments.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return { url, title: titleTag ? clean(titleTag[1]) || null : null, meta, canonical, icons, jsonLd, links, images, h1: headings("h1"), h2: headings("h2"), addresses, text };
}

// ---- candidates

export type FactKind =
  | "name" | "website_url" | "canonical_domain" | "industry" | "niche" | "city" | "region" | "phone" | "email" | "address"
  | "hours" | "description" | "usp" | "tone" | "logo" | "image" | "service" | "service_area" | "service_page" | "article"
  | "social_link" | "claim" | "certification" | "offer" | "other";

export type Origin = "website" | "structured_data" | "ai_suggestion" | "user";

export type Candidate = {
  kind: FactKind;
  value: string;
  label?: string | null;
  source_url: string | null;
  source_quote: string | null;
  origin: Origin;
  confidence: number | null;
};

const SOCIAL_HOSTS: [RegExp, RegExp | null][] = [
  [/(^|\.)facebook\.com$/, /^\/(sharer|share|dialog|plugins|login|tr|events\/create)/],
  [/(^|\.)instagram\.com$/, /^\/(p|reel|explore|accounts)\//],
  [/(^|\.)(twitter|x)\.com$/, /^\/(intent|share|home|search|i)\b/],
  [/(^|\.)linkedin\.com$/, /^\/(shareArticle|sharing|feed)\b/],
  [/(^|\.)youtube\.com$/, /^\/(watch|embed|results|shorts)\b/],
  [/(^|\.)tiktok\.com$/, /^\/(share|embed)\b/],
  [/(^|\.)pinterest\.[a-z.]+$/, /^\/pin\/(create|\d)/],
  [/(^|\.)yelp\.[a-z.]+$/, /^\/(?!biz\/)/],
  [/(^|\.)nextdoor\.com$/, /^\/(?!pages\/)/],
  [/(^|\.)threads\.(net|com)$/, null],
];

export function socialProfile(href: string): string | null {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^(www|m|mobile)\./, "");
  const match = SOCIAL_HOSTS.find(([h]) => h.test(host));
  if (!match || u.pathname.replace(/\/+$/, "") === "") return null;
  if (match[1] && match[1].test(u.pathname)) return null;
  return `https://${host}${u.pathname.replace(/\/+$/, "")}`;
}

const PHONE_PATTERNS = [/(?:\+1[\s.-]?)?\(?\b[2-9]\d{2}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g, /\+\d{1,3}[\s.-]?\(?\d{1,4}\)?(?:[\s.-]?\d{2,4}){2,4}\b/g];
const EMAIL_PATTERN = /\b[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b/gi;
const IGNORED_EMAIL = /(example\.(com|org)|sentry|wixpress|domain\.com|email\.com|yourname|@\dx\.|\.(png|jpe?g|gif|webp|svg)$)/i;

export const phoneDigits = (p: string) => p.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");

const HOURS_LINE = /\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?\s*(?:[-–—]|to|through|thru)\s*(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?[:\s]+\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)?\s*(?:[-–—]|to)\s*\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)?/gi;
const OPEN_247 = /\b(open\s+)?24\s*\/\s*7\b|\b24 hours a day\b/i;

const CERT = /\b(licensed|certified|certification|accredited|bonded|insured|bbb|a\+ rating|master (plumber|electrician)|nate[- ]certified|epa[- ]certified|osha|iso \d{3,5}|gaf|owens corning|certainteed|member of)\b/i;
const OFFER = /\b(free (?:[a-z-]+ ){0,2}(estimates?|quotes?|inspections?|consultations?)|\d{1,2}% off|discounts?|financing|coupons?|special offer|save \$\d+|no[- ]obligation)\b/i;
const CLAIM = /\b(\d{1,3}\+? years|since (19|20)\d\d|guarantee[ds]?|warrant(y|ies)|24\/7|same[- ]day|family[- ]owned|locally owned|award[- ]winning|#1|number one|satisfaction|trusted by)\b/i;

const GENERIC_HEADINGS = /^(our )?(services?|products?|home|welcome|about( us)?|contact( us)?|blog|news|faqs?|locations?|service areas?|areas we serve|get in touch|menu)$/i;

const SKIP_TYPES = /^(WebSite|WebPage|BreadcrumbList|ListItem|SiteNavigationElement|SearchAction|ImageObject|Person|Review|AggregateRating|Rating|Offer|FAQPage|Question|Answer|VideoObject|CollectionPage|ItemList|ContactPoint|PostalAddress|GeoCoordinates|OpeningHoursSpecification|Article|BlogPosting|NewsArticle|Product|Service|Place|City|State|AdministrativeArea|EntryPoint|ReadAction|Thing)$/;

type Node = Record<string, unknown>;

function flatten(input: unknown, out: Node[] = []): Node[] {
  if (Array.isArray(input)) input.forEach((x) => flatten(x, out));
  else if (input && typeof input === "object") {
    const n = input as Node;
    out.push(n);
    if (n["@graph"]) flatten(n["@graph"], out);
  }
  return out;
}

const types = (n: Node) => (Array.isArray(n["@type"]) ? (n["@type"] as unknown[]) : [n["@type"]]).filter((t): t is string => typeof t === "string");
const asArray = (v: unknown): unknown[] => (v == null ? [] : Array.isArray(v) ? v : [v]);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? decodeEntities(v).replace(/\s+/g, " ").trim() : null);
const nameOf = (v: unknown): string | null => str(v) ?? (v && typeof v === "object" ? str((v as Node).name) : null);
const urlOf = (v: unknown): string | null => str(v) ?? (v && typeof v === "object" ? str((v as Node).url) ?? str((v as Node)["@id"]) : null);
const quote = (key: string, value: unknown) => `"${key}": ${JSON.stringify(value)}`.slice(0, 300);

function formatAddress(v: unknown): { full: string | null; city: string | null; region: string | null } {
  if (typeof v === "string") return { full: str(v), city: null, region: null };
  if (!v || typeof v !== "object") return { full: null, city: null, region: null };
  const a = v as Node;
  const street = str(a.streetAddress);
  const city = str(a.addressLocality);
  const region = str(a.addressRegion);
  const postal = str(a.postalCode);
  const country = nameOf(a.addressCountry);
  // A street address is required before anything is called an address.
  const full = street ? [street, city, [region, postal].filter(Boolean).join(" "), country].filter(Boolean).join(", ") : null;
  return { full, city, region };
}

function formatHours(n: Node): string[] {
  const out: string[] = [];
  for (const h of asArray(n.openingHours)) if (str(h)) out.push(str(h)!);
  for (const s of asArray(n.openingHoursSpecification)) {
    if (!s || typeof s !== "object") continue;
    const spec = s as Node;
    const days = asArray(spec.dayOfWeek).map((d) => String(d).replace(/^https?:\/\/schema\.org\//, "").slice(0, 3)).join(", ");
    const opens = str(spec.opens);
    const closes = str(spec.closes);
    if (days && opens && closes) out.push(`${days} ${opens.slice(0, 5)}–${closes.slice(0, 5)}`);
  }
  return out;
}

function sentences(text: string) {
  return text
    .split(/\n|(?<=[.!?])\s+/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length >= 15 && s.length <= 240 && /[a-z]/i.test(s));
}

function nameFromTitle(title: string | null) {
  if (!title) return null;
  const parts = title.split(/\s+[|–—·:-]\s+/).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1];
  return last.length <= 60 ? last : null;
}

// Builds candidates from the crawled pages. `homepageUrl` is the final homepage URL after redirects.
export function extractCandidates(pages: PageData[], homepageUrl: string, sitemapPages: string[] = []): Candidate[] {
  const out: Candidate[] = [];
  const add = (c: Omit<Candidate, "origin"> & { origin?: Origin }) => {
    const value = c.value.replace(/\s+/g, " ").trim().slice(0, 500);
    if (value) out.push({ origin: "website", label: null, ...c, value });
  };
  const home = pages.find((p) => p.url === homepageUrl) ?? pages[0];
  const host = new URL(homepageUrl).hostname.toLowerCase();

  add({ kind: "website_url", value: new URL(homepageUrl).origin, source_url: homepageUrl, source_quote: "Homepage address after redirects", confidence: 0.95 });
  const canonicalHost = home?.canonical ? new URL(home.canonical).hostname.toLowerCase() : null;
  const domain = (canonicalHost && sameSite(canonicalHost, host) ? canonicalHost : host).replace(/^www\./, "");
  add({ kind: "canonical_domain", value: domain, source_url: homepageUrl, source_quote: home?.canonical ? `<link rel="canonical" href="${home.canonical}">` : "Homepage host", confidence: home?.canonical ? 0.95 : 0.85 });

  for (const page of pages) {
    const isHome = page === home;

    // Structured data: the most reliable source when present.
    for (const n of page.jsonLd.flatMap((j) => flatten(j))) {
      const t = types(n);
      if (t.some((x) => /^(Article|BlogPosting|NewsArticle)$/.test(x))) {
        const headline = str(n.headline) ?? str(n.name);
        if (headline) add({ kind: "article", value: urlOf(n.mainEntityOfPage) ?? page.url, label: headline, source_url: page.url, source_quote: quote("headline", headline), origin: "structured_data", confidence: 0.85 });
        continue;
      }
      if (t.includes("Service")) {
        const name = str(n.name) ?? str(n.serviceType);
        if (name) add({ kind: "service", value: name, source_url: page.url, source_quote: quote("name", name), origin: "structured_data", confidence: 0.85 });
        for (const a of asArray(n.areaServed)) {
          const area = nameOf(a);
          if (area) add({ kind: "service_area", value: area, source_url: page.url, source_quote: quote("areaServed", area), origin: "structured_data", confidence: 0.85 });
        }
        continue;
      }
      if (!t.length || t.every((x) => SKIP_TYPES.test(x))) continue;

      const sd = (kind: FactKind, value: string | null, key: string, raw: unknown, confidence = 0.95) => {
        if (value) add({ kind, value, source_url: page.url, source_quote: quote(key, raw), origin: "structured_data", confidence });
      };
      sd("name", str(n.name), "name", n.name);
      sd("phone", str(n.telephone), "telephone", n.telephone);
      sd("email", str(n.email)?.replace(/^mailto:/i, "") ?? null, "email", n.email);
      const addr = formatAddress(n.address);
      sd("address", addr.full, "address", n.address);
      sd("city", addr.city, "addressLocality", addr.city, 0.85);
      sd("region", addr.region, "addressRegion", addr.region, 0.85);
      for (const h of formatHours(n)) sd("hours", h, "openingHours", h, 0.9);
      sd("description", str(n.description), "description", n.description, 0.85);
      sd("usp", str(n.slogan), "slogan", n.slogan, 0.8);
      const logo = urlOf(n.logo);
      if (logo && /^https:\/\//.test(logo)) sd("logo", logo, "logo", logo, 0.9);
      for (const img of asArray(n.image)) {
        const u = urlOf(img);
        if (u && /^https:\/\//.test(u)) sd("image", u, "image", u, 0.8);
      }
      for (const s of asArray(n.sameAs)) {
        const profile = str(s) && socialProfile(str(s)!);
        if (profile) sd("social_link", profile, "sameAs", s, 0.95);
      }
      for (const a of asArray(n.areaServed)) sd("service_area", nameOf(a), "areaServed", nameOf(a), 0.9);
      const offers = [...asArray(n.makesOffer), ...asArray((n.hasOfferCatalog as Node | undefined)?.itemListElement)];
      for (const o of offers) {
        const item = o && typeof o === "object" ? ((o as Node).itemOffered ?? o) : o;
        sd("service", nameOf(item), "itemOffered", nameOf(item), 0.85);
      }
      for (const c of [...asArray(n.award), ...asArray(n.hasCredential)]) sd("certification", nameOf(c), "award", nameOf(c), 0.8);
    }

    // Metadata on the homepage.
    if (isHome) {
      if (page.meta["og:site_name"]) add({ kind: "name", value: page.meta["og:site_name"], source_url: page.url, source_quote: `<meta property="og:site_name" content="${page.meta["og:site_name"]}">`, confidence: 0.8 });
      const fromTitle = nameFromTitle(page.title);
      if (fromTitle) add({ kind: "name", value: fromTitle, source_url: page.url, source_quote: `<title>${page.title}</title>`, confidence: 0.45 });
      const desc = page.meta["description"] || page.meta["og:description"];
      if (desc) add({ kind: "description", value: desc, source_url: page.url, source_quote: `<meta name="description" content="${desc.slice(0, 200)}">`, confidence: 0.7 });
      const og = page.meta["og:image"];
      if (og && /^https:\/\//.test(og)) add({ kind: "image", value: og, source_url: page.url, source_quote: `<meta property="og:image" content="${og}">`, confidence: 0.7 });
      const logoImg = page.images.find((i) => /logo/i.test(`${i.cls} ${i.alt} ${new URL(i.src).pathname}`) && /^https:\/\//.test(i.src));
      if (logoImg) {
        add({ kind: "logo", value: logoImg.src, source_url: page.url, source_quote: `<img src="${logoImg.src}" alt="${logoImg.alt}">`, confidence: 0.65 });
        const alt = logoImg.alt.replace(/\s*logo\s*$/i, "").trim();
        if (alt.length >= 3 && alt.length <= 60) add({ kind: "name", value: alt, source_url: page.url, source_quote: `<img alt="${logoImg.alt}">`, confidence: 0.5 });
      } else if (page.icons[0]?.startsWith("https://")) {
        add({ kind: "logo", value: page.icons[0], source_url: page.url, source_quote: `<link rel="icon" href="${page.icons[0]}">`, confidence: 0.35 });
      }
    }

    // Contact details written on the page.
    for (const l of page.links) {
      if (/^tel:/i.test(l.href)) {
        const num = decodeURIComponent(l.href.slice(4)).trim();
        if (phoneDigits(num).length >= 10) add({ kind: "phone", value: /\d/.test(l.text) ? l.text : num, source_url: page.url, source_quote: `<a href="${l.href}">${l.text}</a>`, confidence: 0.9 });
      } else if (/^mailto:/i.test(l.href)) {
        const email = decodeURIComponent(l.href.slice(7).split("?")[0]).trim().toLowerCase();
        if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) && !IGNORED_EMAIL.test(email)) add({ kind: "email", value: email, source_url: page.url, source_quote: `<a href="${l.href}">${l.text}</a>`, confidence: 0.9 });
      } else {
        const profile = socialProfile(l.href);
        if (profile) add({ kind: "social_link", value: profile, source_url: page.url, source_quote: `<a href="${l.href}">${l.text || "link"}</a>`, confidence: 0.9 });
      }
    }
    for (const line of page.text.split("\n")) {
      for (const re of PHONE_PATTERNS) {
        for (const m of line.matchAll(re)) {
          const d = phoneDigits(m[0]);
          if (d.length >= 10 && d.length <= 15) add({ kind: "phone", value: m[0].trim(), source_url: page.url, source_quote: line.slice(0, 200), confidence: 0.6 });
        }
      }
      for (const m of line.matchAll(EMAIL_PATTERN)) {
        if (!IGNORED_EMAIL.test(m[0])) add({ kind: "email", value: m[0].toLowerCase(), source_url: page.url, source_quote: line.slice(0, 200), confidence: 0.6 });
      }
      for (const m of line.matchAll(HOURS_LINE)) add({ kind: "hours", value: m[0], source_url: page.url, source_quote: line.slice(0, 200), confidence: 0.6 });
      if (OPEN_247.test(line) && line.length < 120) add({ kind: "hours", value: "Open 24/7", source_url: page.url, source_quote: line.slice(0, 200), confidence: 0.5 });
    }
    // An <address> element is the site saying "this is our address". Plain text is never treated as one.
    for (const a of page.addresses) {
      if (!/\d/.test(a) || a.length > 200) continue;
      add({ kind: "address", value: a, source_url: page.url, source_quote: `<address>${a}</address>`, confidence: 0.7 });
      const m = a.match(/([A-Za-z .'-]{2,40}),\s*([A-Z]{2})\s+\d{5}(?:-\d{4})?/);
      if (m) {
        add({ kind: "city", value: m[1].trim(), source_url: page.url, source_quote: `<address>${a}</address>`, confidence: 0.6 });
        add({ kind: "region", value: m[2], source_url: page.url, source_quote: `<address>${a}</address>`, confidence: 0.6 });
      }
    }

    // Service, area and article pages.
    if (!isHome) {
      const path = new URL(page.url).pathname.toLowerCase();
      const heading = page.h1[0] ?? page.title?.split(/\s+[|–—·-]\s+/)[0] ?? null;
      const usable = heading && !GENERIC_HEADINGS.test(heading) && heading.length <= 90;
      if (isArticleUrl(page.url)) {
        if (heading) add({ kind: "article", value: page.url, label: heading, source_url: page.url, source_quote: `<h1>${heading}</h1>`, confidence: 0.8 });
      } else if (/\/(service-areas?|areas?-we-serve|locations?|areas?|cities)\/[^/]+/.test(path)) {
        if (usable) add({ kind: "service_area", value: heading!.replace(/^.*\bin\s+/i, ""), label: heading, source_url: page.url, source_quote: `<h1>${heading}</h1>`, confidence: 0.5 });
      } else if (pageScore(page.url) >= 60 && !/contact|about/.test(path)) {
        add({ kind: "service_page", value: page.url, label: heading ?? page.url, source_url: page.url, source_quote: heading ? `<h1>${heading}</h1>` : null, confidence: 0.7 });
        if (usable && /\/services?\/[^/]+/.test(path)) add({ kind: "service", value: heading!, source_url: page.url, source_quote: `<h1>${heading}</h1>`, confidence: 0.6 });
      }
    }

    // Claims, credentials and offers, quoted word for word so the user can check them.
    for (const s of sentences(page.text)) {
      if (CERT.test(s)) add({ kind: "certification", value: s, source_url: page.url, source_quote: s, confidence: 0.5 });
      else if (OFFER.test(s)) add({ kind: "offer", value: s, source_url: page.url, source_quote: s, confidence: 0.5 });
      else if (CLAIM.test(s)) add({ kind: "claim", value: s, source_url: page.url, source_quote: s, confidence: 0.45 });
    }
  }

  // Links to service pages from the homepage navigation.
  if (home) {
    for (const l of home.links) {
      let u: URL;
      try {
        u = new URL(l.href, home.url);
      } catch {
        continue;
      }
      if (!sameSite(u.hostname.toLowerCase(), host)) continue;
      if (/\/services?\/[^/]+/.test(u.pathname) && l.text && !GENERIC_HEADINGS.test(l.text) && l.text.length <= 60) {
        add({ kind: "service", value: l.text, source_url: home.url, source_quote: `<a href="${l.href}">${l.text}</a>`, confidence: 0.55 });
      }
    }
  }

  // Articles listed in the sitemap but not fetched.
  for (const u of sitemapPages.filter(isArticleUrl).slice(0, 15)) {
    const slug = new URL(u).pathname.split("/").filter(Boolean).pop() ?? "";
    add({ kind: "article", value: u, label: slug.replace(/[-_]+/g, " ").replace(/\.\w+$/, ""), source_url: u, source_quote: "Listed in sitemap.xml", confidence: 0.5 });
  }

  return mergeCandidates(out);
}

// ---- merging and field status

const PER_KIND_LIMIT: Partial<Record<FactKind, number>> = { claim: 8, certification: 8, offer: 8, image: 6, article: 15, service_page: 15, service: 25, service_area: 25, phone: 5, email: 5 };

export function factKey(kind: FactKind, value: string) {
  if (kind === "phone") return phoneDigits(value);
  if (kind === "name") return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\b(llc|inc|ltd|co|corp|company|pllc)\b/g, "").trim();
  if (["website_url", "logo", "image", "social_link", "article", "service_page"].includes(kind)) return value.replace(/\/+$/, "").toLowerCase();
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

// One candidate per (kind, value): keep the strongest source, then cap noisy kinds.
export function mergeCandidates(list: Candidate[]): Candidate[] {
  const best = new Map<string, Candidate>();
  for (const c of list) {
    const key = `${c.kind}|${factKey(c.kind, c.value)}`;
    const prev = best.get(key);
    if (!prev || (c.confidence ?? 0) > (prev.confidence ?? 0)) best.set(key, { ...c, label: c.label ?? prev?.label ?? null });
  }
  const byKind = new Map<FactKind, Candidate[]>();
  for (const c of best.values()) byKind.set(c.kind, [...(byKind.get(c.kind) ?? []), c]);
  return [...byKind.entries()].flatMap(([kind, cs]) => cs.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0)).slice(0, PER_KIND_LIMIT[kind] ?? 10));
}

// Fields of the brand profile and how they are filled.
export const PROFILE_FIELDS = [
  { field: "business_name", kind: "name", label: "Business name", single: true },
  { field: "website_url", kind: "website_url", label: "Website", single: true },
  { field: "canonical_domain", kind: "canonical_domain", label: "Domain", single: true },
  { field: "industry", kind: "industry", label: "Industry", single: true },
  { field: "niche", kind: "niche", label: "Niche", single: true },
  { field: "city", kind: "city", label: "City", single: true },
  { field: "region", kind: "region", label: "State or region", single: true },
  { field: "phone", kind: "phone", label: "Phone", single: true },
  { field: "email", kind: "email", label: "Email", single: true },
  { field: "address", kind: "address", label: "Address", single: true },
  { field: "hours", kind: "hours", label: "Business hours", single: true },
  { field: "description", kind: "description", label: "Description", single: true },
  { field: "value_proposition", kind: "usp", label: "Value proposition", single: true },
  { field: "tone", kind: "tone", label: "Tone of voice", single: true },
  { field: "logo_url", kind: "logo", label: "Logo", single: true },
  { field: "services", kind: "service", label: "Services and products", single: false },
  { field: "service_areas", kind: "service_area", label: "Service areas", single: false },
] as const;

export type ProfileField = (typeof PROFILE_FIELDS)[number]["field"];

// Kinds that are kept as lists the user confirms item by item, not copied into a profile field.
export const LIST_KINDS = [
  { kind: "social_link", label: "Social profiles on the website" },
  { kind: "service_page", label: "Service pages" },
  { kind: "article", label: "Articles and guides" },
  { kind: "image", label: "Brand images" },
  { kind: "certification", label: "Licences and certifications" },
  { kind: "claim", label: "Claims" },
  { kind: "offer", label: "Offers" },
] as const;

export type FieldStatus = "found" | "conflict" | "missing" | "suggested";

// For single-value fields, two website values conflict when neither contains the other.
export function fieldStatus(kind: FactKind, single: boolean, candidates: Pick<Candidate, "kind" | "value" | "origin" | "confidence">[]): FieldStatus {
  const facts = candidates.filter((c) => c.kind === kind);
  const site = facts.filter((c) => c.origin !== "ai_suggestion" && (c.confidence ?? 1) >= 0.5);
  if (!site.length) return facts.some((c) => c.origin === "ai_suggestion") ? "suggested" : "missing";
  if (!single) return "found";
  const keys = [...new Set(site.map((c) => factKey(kind, c.value)))];
  const conflict = keys.some((a, i) => keys.slice(i + 1).some((b) => !a.includes(b) && !b.includes(a)));
  return conflict ? "conflict" : "found";
}
