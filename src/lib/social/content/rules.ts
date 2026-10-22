// Platform constraints, content safety checks and near-duplicate detection. Pure functions.
// Errors block approval; warnings are shown for the user to judge.

export const CATEGORIES = ["educational", "faq", "maintenance_tips", "seasonal", "industry_update", "service_explainer", "local_relevance"] as const;
export type Category = (typeof CATEGORIES)[number];
export const CATEGORY_LABEL: Record<Category, string> = {
  educational: "Educational",
  faq: "Customer questions",
  maintenance_tips: "Maintenance tips",
  seasonal: "Seasonal advice",
  industry_update: "Industry updates",
  service_explainer: "Service explainers",
  local_relevance: "Local relevance",
};
// Categories whose posts usually depend on current facts, so they're researched before drafting.
export const TIME_SENSITIVE: Category[] = ["seasonal", "industry_update", "local_relevance"];

export type PlatformRule = {
  label: string;
  maxChars: number;
  idealChars: [number, number];
  maxHashtags: number;
  idealHashtags: [number, number];
  links: "allowed" | "not_clickable" | "none";
  imageRequired: boolean;
  urlCharCost?: number; // X counts every link as 23 characters
  noPhoneInText?: boolean;
  notes: string;
};

// Limits from each platform's documentation; ideal ranges are editorial defaults.
export const PLATFORM_RULES: Record<string, PlatformRule> = {
  facebook_page: { label: "Facebook Page", maxChars: 63206, idealChars: [80, 600], maxHashtags: 5, idealHashtags: [0, 3], links: "allowed", imageRequired: false, notes: "Short posts with one clear call to action do best." },
  instagram: { label: "Instagram", maxChars: 2200, idealChars: [100, 1200], maxHashtags: 30, idealHashtags: [3, 8], links: "not_clickable", imageRequired: true, notes: "Needs an image. Links in captions aren't clickable, so point to the bio." },
  linkedin_page: { label: "LinkedIn page", maxChars: 3000, idealChars: [150, 1300], maxHashtags: 5, idealHashtags: [0, 3], links: "allowed", imageRequired: false, notes: "Professional tone; explain the why." },
  linkedin_profile: { label: "LinkedIn profile", maxChars: 3000, idealChars: [150, 1300], maxHashtags: 5, idealHashtags: [0, 3], links: "allowed", imageRequired: false, notes: "First-person, professional." },
  google_business: { label: "Google Business Profile", maxChars: 1500, idealChars: [100, 750], maxHashtags: 0, idealHashtags: [0, 0], links: "none", imageRequired: false, noPhoneInText: true, notes: "No hashtags. Google may reject posts with phone numbers in the text; use the call button instead." },
  x: { label: "X", maxChars: 280, idealChars: [60, 260], maxHashtags: 2, idealHashtags: [0, 2], links: "allowed", imageRequired: false, urlCharCost: 23, notes: "280 characters; every link counts as 23." },
  threads: { label: "Threads", maxChars: 500, idealChars: [60, 450], maxHashtags: 1, idealHashtags: [0, 1], links: "allowed", imageRequired: false, notes: "500 characters, one topic tag." },
  pinterest: { label: "Pinterest", maxChars: 500, idealChars: [100, 500], maxHashtags: 5, idealHashtags: [0, 3], links: "allowed", imageRequired: true, notes: "Needs an image; the description is searchable." },
};

export type Validation = { errors: string[]; warnings: string[] };

export type Facts = {
  phones: string[]; // confirmed phone numbers
  domains: string[]; // the brand's own domains
  sourceUrls: string[]; // research sources attached to this draft
  credentials: string[]; // confirmed certifications/claims text
};

const URL_RE = /\bhttps?:\/\/[^\s)]+/gi;
const PHONE_RE = /(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g;
const BAIT = /\b(like (this|if)|share (this|if)|tag (a|3|three|your) (friend|friends)|comment ["']?(yes|below if|amen)|type ["']?(yes|amen)|smash (that|the) like|follow for more|don'?t scroll)\b/i;
const CREDENTIAL = /\b(licensed|certified|accredited|bonded|insured|award[- ]winning|bbb|a\+ rating|#1|number one|best in)\b/i;
const STAT = /\b\d+(\.\d+)?\s?(%|percent)|\b\d{1,3}(,\d{3})+\b|\b\d+ out of \d+\b/i;
const TESTIMONIAL = /\b(one of our (customers|clients)|a (customer|client) (told|said|wrote)|our (customers|clients) (say|said|told))\b/i;
const QUOTED_REVIEW = /"[^"]{10,}"\s*[-–—]\s*[A-Z][a-z]+/;
const STOP = new Set("a an and are as at be but by for from has have how i if in is it its of on or our so that the their them they this to was we what when where which who why will with you your".split(" "));

const digits = (s: string) => s.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
const host = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
};

export function charCount(platform: string, body: string, hashtags: string[] = [], link: string | null = null) {
  const rule = PLATFORM_RULES[platform];
  const tags = hashtags.length ? ` ${hashtags.map((h) => `#${h}`).join(" ")}` : "";
  const text = `${body}${tags}${link && !body.includes(link) ? ` ${link}` : ""}`;
  if (!rule?.urlCharCost) return [...text].length;
  return [...text.replace(URL_RE, "")].length + (text.match(URL_RE)?.length ?? 0) * rule.urlCharCost;
}

export function normalizeHashtags(tags: string[]) {
  return [...new Set(tags.map((t) => t.replace(/^#+/, "").replace(/[^\p{L}\p{N}_]/gu, "")).filter((t) => t.length >= 2 && t.length <= 50))];
}

// Checks one platform variant against the platform's rules and the brand's confirmed facts.
export function validateVariant(platform: string, v: { body: string; hashtags: string[]; link_url: string | null }, facts: Facts): Validation {
  const rule = PLATFORM_RULES[platform];
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!rule) return { errors: [`Unknown platform ${platform}.`], warnings };
  const body = v.body.trim();
  if (!body) errors.push("The post is empty.");
  const count = charCount(platform, body, v.hashtags, v.link_url);
  if (count > rule.maxChars) errors.push(`${count} characters; ${rule.label} allows ${rule.maxChars}.`);
  else if (count > rule.idealChars[1]) warnings.push(`${count} characters is long for ${rule.label} (aim for under ${rule.idealChars[1]}).`);
  else if (count < rule.idealChars[0]) warnings.push(`Very short for ${rule.label}.`);

  const inlineTags = body.match(/#[\p{L}\p{N}_]+/gu)?.length ?? 0;
  const tagCount = v.hashtags.length + inlineTags;
  if (tagCount > rule.maxHashtags) errors.push(rule.maxHashtags === 0 ? `${rule.label} posts shouldn't use hashtags.` : `${tagCount} hashtags; keep to ${rule.maxHashtags} or fewer on ${rule.label}.`);
  else if (tagCount > rule.idealHashtags[1]) warnings.push(`${tagCount} hashtags; ${rule.idealHashtags[1]} or fewer usually reads better.`);

  const urls = [...(body.match(URL_RE) ?? []), ...(v.link_url ? [v.link_url] : [])];
  if (rule.links === "none" && urls.length) errors.push(`${rule.label} posts can't include links in the text; use the post's button instead.`);
  if (rule.links === "not_clickable" && urls.length) warnings.push(`Links aren't clickable on ${rule.label}; say "link in bio" instead.`);
  const allowedHosts = new Set([...facts.domains.map((d) => d.replace(/^www\./, "")), ...facts.sourceUrls.map(host)]);
  for (const u of urls) if (!allowedHosts.has(host(u))) errors.push(`Link to ${host(u) || u} isn't the brand's website or a cited source.`);

  const phones = body.match(PHONE_RE) ?? [];
  if (rule.noPhoneInText && phones.length) errors.push(`${rule.label} may reject posts with phone numbers in the text.`);
  const known = new Set(facts.phones.map(digits));
  for (const p of phones) if (!known.has(digits(p))) errors.push(`Phone number ${p} isn't a confirmed number for this brand.`);

  const credential = body.match(CREDENTIAL);
  if (credential && !facts.credentials.some((c) => c.toLowerCase().includes(credential[0].toLowerCase()))) {
    errors.push(`"${credential[0]}" isn't backed by a confirmed claim or certification in the brand profile.`);
  }
  if (STAT.test(body) && facts.sourceUrls.length === 0) errors.push("Contains a statistic or figure with no research source attached.");
  if (TESTIMONIAL.test(body) || QUOTED_REVIEW.test(body)) errors.push("Looks like a testimonial or customer story; these must never be invented.");
  if (BAIT.test(body)) errors.push("Engagement bait (\"like if…\", \"tag a friend\") isn't allowed.");

  const words = body.toLowerCase().match(/\p{L}[\p{L}'-]+/gu) ?? [];
  const counts = new Map<string, number>();
  for (const w of words) if (!STOP.has(w) && w.length > 3) counts.set(w, (counts.get(w) ?? 0) + 1);
  const [top, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
  if (words.length >= 30 && n >= 5 && n / words.length > 0.06) warnings.push(`"${top}" appears ${n} times; it may read as keyword stuffing.`);
  const letters = body.replace(/[^A-Za-z]/g, "");
  if (letters.length > 20 && letters.replace(/[^A-Z]/g, "").length / letters.length > 0.4) warnings.push("A lot of capital letters.");
  if (rule.imageRequired) warnings.push(`${rule.label} needs an image when it's published.`);
  return { errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}

// ---- near duplicates

function shingles(text: string, size = 3) {
  const words = text.toLowerCase().replace(/https?:\/\/\S+/g, " ").replace(/#\S+/g, " ").match(/[\p{L}\p{N}']+/gu) ?? [];
  const out = new Set<string>();
  if (words.length < size) {
    if (words.length) out.add(words.join(" "));
    return out;
  }
  for (let i = 0; i + size <= words.length; i++) out.add(words.slice(i, i + size).join(" "));
  return out;
}

export function similarity(a: string, b: string) {
  const sa = shingles(a);
  const sb = shingles(b);
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  for (const s of sa) if (sb.has(s)) inter++;
  return inter / (sa.size + sb.size - inter);
}

export const DUPLICATE_THRESHOLD = 0.5;

export function nearestDuplicate<T extends { id: string; body: string }>(body: string, others: T[], threshold = DUPLICATE_THRESHOLD) {
  let best: { item: T; score: number } | null = null;
  for (const o of others) {
    const score = similarity(body, o.body);
    if (score >= threshold && (!best || score > best.score)) best = { item: o, score };
  }
  return best;
}

// Titles are short, so compare words rather than phrases.
export function titleSimilarity(a: string, b: string) {
  const wa = new Set((a.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => !STOP.has(w)));
  const wb = new Set((b.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => !STOP.has(w)));
  if (!wa.size || !wb.size) return 0;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  return inter / (wa.size + wb.size - inter);
}
