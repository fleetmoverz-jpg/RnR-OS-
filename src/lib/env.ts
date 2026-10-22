// Server-only configuration. Every secret comes from the environment; nothing is committed.
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

export const env = {
  appUrl: () => required("APP_URL").replace(/\/$/, ""),
  allowedEmail: () => required("ALLOWED_EMAIL").toLowerCase(),
  sessionSecret: () => required("SESSION_SECRET"),
  googleClientId: () => required("GOOGLE_CLIENT_ID"),
  googleClientSecret: () => required("GOOGLE_CLIENT_SECRET"),
  supabaseUrl: () => required("SUPABASE_URL"),
  supabaseServiceRoleKey: () => required("SUPABASE_SERVICE_ROLE_KEY"),
  cronSecret: () => required("CRON_SECRET"),
  anthropicApiKey: () => process.env.ANTHROPIC_API_KEY,
  anthropicModel: () => process.env.ANTHROPIC_MODEL || "claude-opus-5-5",
  backfillDays: () => Number(process.env.GSC_BACKFILL_DAYS || 90),
  inspectLimit: () => Number(process.env.GSC_INSPECT_LIMIT || 40),
  aiReportEveryDays: () => Number(process.env.AI_REPORT_EVERY_DAYS || 7),
};
