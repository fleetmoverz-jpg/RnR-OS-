import type { Metadata } from "next";

export const metadata: Metadata = { title: "Privacy policy · RnR Os" };

// Public page required by Google's OAuth consent screen.
export default function PrivacyPage() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-12 text-sm leading-relaxed">
      <h1 className="text-2xl font-semibold">Privacy policy</h1>
      <p className="mt-1 text-muted">Last updated 22 October 2026</p>

      <p className="mt-6">
        RnR Os is a private tool used only by its owner. Sign-in is limited to a single Google account; no one else can
        create an account or log in.
      </p>

      <h2 className="mt-6 text-lg font-semibold">What we access</h2>
      <p className="mt-2">
        With your permission, RnR Os reads your email address and, read-only, your Google Search Console data (search
        performance and URL inspection results) for the properties you own. It cannot change anything in your Google
        account or Search Console.
      </p>

      <h2 className="mt-6 text-lg font-semibold">How it is used and stored</h2>
      <p className="mt-2">
        The data is stored in the owner&apos;s private database and used only to show reports and generate SEO
        recommendations. A summary of the search data is sent to the Claude API (Anthropic) to write those
        recommendations. Nothing is sold, shared for advertising, or used for any other purpose.
      </p>

      <h2 className="mt-6 text-lg font-semibold">Removing access</h2>
      <p className="mt-2">
        You can revoke access at any time from your Google Account under Security → Third-party apps with account
        access. Contact the owner to have stored data deleted.
      </p>
    </main>
  );
}
