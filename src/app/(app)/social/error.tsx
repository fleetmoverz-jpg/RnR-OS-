"use client";

import { RotateCcw, TriangleAlert } from "lucide-react";
import { buttonClass, Card, EmptyState } from "@/components/ui";

// Shown when a Social page fails to load. Missing tables are handled earlier, in layout.tsx.
export default function SocialError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <Card>
      <EmptyState
        icon={TriangleAlert}
        title="This page couldn't load"
        action={
          <button onClick={reset} className={buttonClass("secondary")}>
            <RotateCcw className="size-4" /> Try again
          </button>
        }
      >
        {error.digest ? `Something went wrong on the server (reference ${error.digest}). Try again, or check the Vercel logs.` : error.message}
      </EmptyState>
    </Card>
  );
}
