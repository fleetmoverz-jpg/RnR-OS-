import { redirect } from "next/navigation";
import { getSessionEmail } from "@/lib/auth/session";

const ERRORS: Record<string, string> = {
  denied: "That Google account is not allowed to use this app.",
  state: "The sign-in link expired. Try again.",
  google: "Google sign-in failed. Try again.",
};

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  if (await getSessionEmail()) redirect("/search-console");
  const { error } = await searchParams;
  const message = typeof error === "string" ? ERRORS[error] : undefined;

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-xl border border-line bg-surface p-8 text-center">
        <h1 className="text-2xl font-semibold">RnR Os</h1>
        <p className="mt-2 text-sm text-ink-2">
          Sign in with the Google account that owns your Search Console properties.
        </p>
        {message && <p className="mt-4 rounded-md bg-bad/10 p-2 text-sm text-bad">{message}</p>}
        <a
          href="/api/auth/google"
          className="mt-6 inline-flex w-full items-center justify-center rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-white hover:opacity-90"
        >
          Continue with Google
        </a>
      </div>
    </main>
  );
}
