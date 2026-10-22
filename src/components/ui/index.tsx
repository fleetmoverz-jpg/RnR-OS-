import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { Info } from "lucide-react";

export function cn(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(" ");
}

export function Card({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn("min-w-0 rounded-xl border border-line bg-card shadow-card", className)}>{children}</div>;
}

export function CardHeader({
  title,
  description,
  icon: Icon,
  action,
}: {
  title: string;
  description?: React.ReactNode;
  icon?: LucideIcon;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 border-b border-line px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        {Icon && (
          <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand">
            <Icon className="size-4" />
          </span>
        )}
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
          {description && <p className="mt-0.5 text-[13px] text-ink-2">{description}</p>}
        </div>
      </div>
      {action}
    </div>
  );
}

type Tone = "neutral" | "brand" | "ai" | "success" | "warning" | "danger" | "accent";
const TONES: Record<Tone, string> = {
  neutral: "bg-subtle text-ink-2 ring-line",
  brand: "bg-brand-soft text-brand ring-brand/15",
  ai: "bg-ai-soft text-ai ring-ai/15",
  success: "bg-success-soft text-success-ink ring-success/20",
  warning: "bg-warning-soft text-warning-ink ring-warning/25",
  danger: "bg-danger-soft text-danger-ink ring-danger/20",
  accent: "bg-cyan-50 text-cyan-700 ring-accent/20",
};

export function Badge({ tone = "neutral", children, className }: { tone?: Tone; children: React.ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset", TONES[tone], className)}>
      {children}
    </span>
  );
}

const BUTTON = {
  primary: "bg-brand text-white hover:bg-brand-hover shadow-sm",
  secondary: "border border-line bg-card text-ink hover:bg-subtle shadow-sm",
  ghost: "text-ink-2 hover:bg-subtle hover:text-ink",
  ai: "bg-gradient-to-r from-brand to-ai text-white hover:opacity-95 shadow-sm",
};
export type ButtonVariant = keyof typeof BUTTON;
export const buttonClass = (variant: ButtonVariant = "secondary", className?: string) =>
  cn(
    "inline-flex h-9 items-center justify-center gap-2 rounded-lg px-3.5 text-[13px] font-medium transition-colors disabled:pointer-events-none disabled:opacity-60",
    BUTTON[variant],
    className,
  );

export function ButtonLink({ href, variant, children, className }: { href: string; variant?: ButtonVariant; children: React.ReactNode; className?: string }) {
  return (
    <Link href={href} className={buttonClass(variant, className)}>
      {children}
    </Link>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: React.ReactNode;
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
      <div className="min-w-0">
        {eyebrow && <p className="text-[13px] text-ink-2">{eyebrow}</p>}
        <h1 className="mt-1 text-page-title font-semibold tracking-tight">{title}</h1>
        {description && <div className="mt-1.5 text-[13px] text-ink-2">{description}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-start gap-2">{actions}</div>}
    </div>
  );
}

// Native tooltip keeps this server-renderable; the icon makes the hint discoverable.
export function InfoTip({ text }: { text: string }) {
  return (
    <span title={text} aria-label={text} className="inline-flex cursor-help text-ink-3 hover:text-ink-2">
      <Info className="size-3.5" />
    </span>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  children,
  action,
}: {
  icon: LucideIcon;
  title: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center">
      <span className="flex size-11 items-center justify-center rounded-xl bg-subtle text-ink-3 ring-1 ring-line">
        <Icon className="size-5" />
      </span>
      <p className="mt-4 font-medium">{title}</p>
      {children && <div className="mt-1 max-w-sm text-[13px] text-ink-2">{children}</div>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return (
    <div className={cn("relative overflow-hidden rounded-md bg-subtle", className)}>
      <div className="absolute inset-0 -translate-x-full animate-[shimmer_1.4s_infinite] bg-gradient-to-r from-transparent via-white/70 to-transparent" />
    </div>
  );
}

// Form field pieces, shared by server pages and client forms.
export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-[13px] font-medium">{label}</span>
      <div className="mt-1.5">{children}</div>
      {hint && <span className="mt-1 block text-xs text-ink-3">{hint}</span>}
    </label>
  );
}

export const inputClass =
  "block w-full rounded-lg border border-line bg-card px-3 py-2 text-[13px] text-ink shadow-sm outline-none placeholder:text-ink-3 focus:border-brand focus:ring-2 focus:ring-brand/15 disabled:opacity-60";
