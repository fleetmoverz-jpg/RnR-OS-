"use client";

import { startTransition, useActionState, useEffect, useRef } from "react";
import { CheckCircle2, Loader2, TriangleAlert } from "lucide-react";
import type { ActionResult } from "@/app/(app)/actions";
import { buttonClass, cn, type ButtonVariant } from "./ui";

// A form bound to a server action: disables while saving and shows the success or error message.
export function ActionForm({
  action,
  children,
  submitLabel,
  pendingLabel = "Saving…",
  variant = "primary",
  resetOnSuccess = false,
  className,
}: {
  action: (prev: ActionResult, form: FormData) => Promise<ActionResult>;
  children?: React.ReactNode;
  submitLabel: string;
  pendingLabel?: string;
  variant?: ButtonVariant;
  resetOnSuccess?: boolean;
  className?: string;
}) {
  const [result, run, pending] = useActionState(action, null);
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (resetOnSuccess && result?.ok) ref.current?.reset();
  }, [result, resetOnSuccess]);

  return (
    // Submitting through onSubmit (not the form action prop) stops React resetting the fields,
    // so a validation error doesn't wipe what was typed.
    <form
      ref={ref}
      onSubmit={(e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        startTransition(() => run(data));
      }}
      className={cn("space-y-4", className)}
    >
      <fieldset disabled={pending} className="min-w-0 space-y-4">
        {children}
      </fieldset>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending} className={buttonClass(variant)}>
          {pending && <Loader2 className="size-4 animate-spin" />}
          {pending ? pendingLabel : submitLabel}
        </button>
        {result && !pending && (
          <p role="status" className={cn("flex items-center gap-1.5 text-xs", result.ok ? "text-success-ink" : "text-danger-ink")}>
            {result.ok ? <CheckCircle2 className="size-3.5" /> : <TriangleAlert className="size-3.5" />}
            {result.message}
          </p>
        )}
      </div>
    </form>
  );
}
