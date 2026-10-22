"use client";

import { useActionState } from "react";
import { Loader2 } from "lucide-react";
import type { ActionResult } from "@/app/(app)/actions";
import { buttonClass, cn, type ButtonVariant } from "./ui";

// Runs a server action with a pending state and shows the result under the button.
export function ActionButton({
  action,
  label,
  pendingLabel,
  icon,
  variant = "secondary",
  align = "end",
}: {
  action: () => Promise<ActionResult>;
  label: string;
  pendingLabel: string;
  icon?: React.ReactNode;
  variant?: ButtonVariant;
  align?: "start" | "end";
}) {
  const [result, run, pending] = useActionState(async () => action(), null);
  return (
    <form action={run} className={cn("flex flex-col gap-1.5", align === "end" ? "items-start sm:items-end" : "items-start")}>
      <button type="submit" disabled={pending} className={buttonClass(variant)}>
        {pending ? <Loader2 className="size-4 animate-spin" /> : icon}
        {pending ? pendingLabel : label}
      </button>
      {result && !pending && (
        <p className={cn("max-w-xs text-xs", result.ok ? "text-success-ink" : "text-danger-ink", align === "end" && "sm:text-right")}>
          {result.message}
        </p>
      )}
    </form>
  );
}
