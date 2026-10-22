// Social platforms the module plans to support, and what each one needs before it can be connected.
// Connecting is not built yet; readiness only reports whether the app credentials exist.

export const PLATFORMS = ["facebook_page", "instagram", "linkedin_profile", "linkedin_page", "google_business", "x", "pinterest", "threads"] as const;
export type Platform = (typeof PLATFORMS)[number];

export type PlatformInfo = {
  id: Platform;
  label: string;
  envVars: string[];
  note: string;
};

export const PLATFORM_INFO: Record<Platform, PlatformInfo> = {
  facebook_page: { id: "facebook_page", label: "Facebook Page", envVars: ["META_APP_ID", "META_APP_SECRET"], note: "Pages you administer." },
  instagram: { id: "instagram", label: "Instagram", envVars: ["META_APP_ID", "META_APP_SECRET"], note: "Business or Creator accounts only. JPEG images." },
  linkedin_profile: { id: "linkedin_profile", label: "LinkedIn profile", envVars: ["LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET"], note: "Your personal profile." },
  linkedin_page: { id: "linkedin_page", label: "LinkedIn page", envVars: ["LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET"], note: "Company pages where you are an admin." },
  google_business: { id: "google_business", label: "Google Business Profile", envVars: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"], note: "Needs Business Profile API access from Google." },
  x: { id: "x", label: "X (Twitter)", envVars: ["X_CLIENT_ID", "X_CLIENT_SECRET"], note: "Paid per post." },
  pinterest: { id: "pinterest", label: "Pinterest", envVars: ["PINTEREST_APP_ID", "PINTEREST_APP_SECRET"], note: "Planned." },
  threads: { id: "threads", label: "Threads", envVars: ["META_APP_ID", "META_APP_SECRET"], note: "Planned." },
};

export const platformLabel = (p: string) => (PLATFORM_INFO as Record<string, PlatformInfo>)[p]?.label ?? p;

// Reads only whether variables are set; values never leave the server.
export function missingEnv(platform: Platform, env: Record<string, string | undefined> = process.env): string[] {
  return PLATFORM_INFO[platform].envVars.filter((name) => !env[name]);
}
