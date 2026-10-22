// Input validation for the Social module. The database enforces the same rules; these give friendly messages first.
import { z } from "zod";

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
}

export function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Accepts "example.com", "https://www.example.com/path" or a Search Console "sc-domain:example.com".
export function normalizeWebsite(input: string): { url: string; domain: string } | null {
  let raw = input.trim();
  if (!raw) return null;
  if (raw.startsWith("sc-domain:")) raw = `https://${raw.slice("sc-domain:".length)}`;
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  const domain = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return null;
  return { url: `${parsed.protocol}//${parsed.hostname.toLowerCase()}`, domain };
}

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Keep this under ${max} characters.`)
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .optional()
    .transform((v) => v ?? null);

const list = (maxItems: number) =>
  z
    .string()
    .optional()
    .transform((v) =>
      (v ?? "")
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, maxItems),
    );

export const brandInput = z.object({
  name: z.string().trim().min(1, "Give the brand a name.").max(80, "Keep the name under 80 characters."),
  niche: optionalText(120),
  timezone: z
    .string()
    .trim()
    .default("UTC")
    .refine((tz) => isTimeZone(tz), "Choose a valid time zone, for example Europe/London."),
});
export type BrandInput = z.infer<typeof brandInput>;

export const profileInput = z.object({
  business_name: optionalText(120),
  phone: optionalText(40),
  email: optionalText(200).refine((v) => v === null || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v), "Enter a valid email address."),
  address: optionalText(300),
  services: list(50),
  service_areas: list(50),
  tone: optionalText(200),
  description: optionalText(2000),
});
export type ProfileInput = z.infer<typeof profileInput>;

const lines = (maxItems: number, maxLength = 120) =>
  z
    .string()
    .optional()
    .transform((v) => [...new Set((v ?? "").split("\n").map((s) => s.trim()).filter(Boolean))].slice(0, maxItems))
    .refine((items) => items.every((i) => i.length <= maxLength), `Keep each line under ${maxLength} characters.`);

const optionalUrl = (https: boolean) =>
  optionalText(500).refine((v) => v === null || (https ? /^https:\/\/\S+$/ : /^https?:\/\/\S+$/).test(v), https ? "Use an https:// link." : "Use a full link starting with http:// or https://.");

// The brand profile review form. Every field the user saves counts as confirmed by them.
export const brandProfileInput = z.object({
  business_name: optionalText(120),
  website_url: optionalUrl(false),
  canonical_domain: optionalText(253).transform((v) => v?.toLowerCase().replace(/^www\./, "") ?? null),
  industry: optionalText(120),
  niche: optionalText(120),
  city: optionalText(120),
  region: optionalText(120),
  phone: optionalText(40),
  email: optionalText(200).refine((v) => v === null || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v), "Enter a valid email address."),
  address: optionalText(300),
  hours: optionalText(500),
  description: optionalText(2000),
  value_proposition: optionalText(500),
  tone: optionalText(200),
  logo_url: optionalUrl(true),
  services: lines(50),
  service_areas: lines(50),
});
export type BrandProfileInput = z.infer<typeof brandProfileInput>;

export const websiteInput = z.object({
  url: z
    .string()
    .trim()
    .min(1, "Enter a website address.")
    .transform((v, ctx) => {
      const site = normalizeWebsite(v);
      if (!site) {
        ctx.addIssue({ code: "custom", message: "Enter a valid website address, for example example.com." });
        return z.NEVER;
      }
      return site;
    }),
});

export const postDraftInput = z.object({
  brand_id: z.uuid("Choose a brand."),
  title: z.string().trim().min(1, "Give the post a title.").max(200, "Keep the title under 200 characters."),
  body: z.string().trim().max(5000, "Keep the text under 5,000 characters.").default(""),
});
export type PostDraftInput = z.infer<typeof postDraftInput>;

export const workspaceInput = z.object({
  name: z.string().trim().min(1, "Give the workspace a name.").max(80, "Keep the name under 80 characters."),
});

// First validation message, for showing next to a form.
export function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Check the form and try again.";
}

// FormData → plain object of strings, for zod.
export function formObject(form: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of form.entries()) if (typeof v === "string") out[k] = v;
  return out;
}
