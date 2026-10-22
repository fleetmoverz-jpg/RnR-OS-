"use client";

import { useActionState } from "react";
import type { ActionResult } from "@/app/(app)/actions";

// A button that runs a server action, shows a pending label, and reports the result.
export function ActionButton({
  action,
  label,
  pendingLabel,
  variant = "primary",
}: {
  action: () => Promise<ActionResult>;
  label: string;
  pendingLabel: string;
  variant?: "primary" | "secondary";
}) {
  const [result, run, pending] = useActionState(async () => action(), null);
  const style =
    variant === "primary"
      ? "bg-accent text-white hover:opacity-90"
      : "border border-line bg-surface text-ink hover:bg-bg";
  return (
    <form action={run} className="flex flex-col items-start gap-1 sm:items-end">
      <button
        type="submit"
        disabled={pending}
        className={`rounded-lg px-3 py-1.5 text-sm font-medium disabled:opacity-60 ${style}`}
      >
        {pending ? pendingLabel : label}
      </button>
      {result && !pending && (
        <p className={`max-w-xs text-xs ${result.ok ? "text-good" : "text-bad"}`}>{result.message}</p>
      )}
    </form>
  );
}
