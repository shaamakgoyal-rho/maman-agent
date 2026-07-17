import type { ReactNode } from "react";
import * as Switch from "@radix-ui/react-switch";

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`card p-4 ${className}`}>{children}</div>;
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return <h2 className="text-sm font-semibold text-ink mb-2">{children}</h2>;
}

export function Muted({ children }: { children: ReactNode }) {
  return <p className="text-xs text-muted leading-relaxed">{children}</p>;
}

export function Button({
  children,
  onClick,
  variant = "primary",
  disabled,
  type = "button",
  ariaLabel,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "secondary" | "danger" | "ghost";
  disabled?: boolean;
  type?: "button" | "submit";
  ariaLabel?: string;
}) {
  const styles: Record<string, string> = {
    primary: "bg-primary text-white hover:bg-primary-hover",
    secondary: "bg-panel text-ink border border-line hover:bg-bg",
    danger: "bg-danger text-white hover:opacity-90",
    ghost: "bg-transparent text-primary hover:bg-bg",
  };
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${styles[variant]}`}
    >
      {children}
    </button>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  description,
  id,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  description?: string;
  id: string;
}) {
  return (
    <div className="flex items-start justify-between gap-3 py-2">
      <div>
        <label htmlFor={id} className="text-sm text-ink cursor-pointer">
          {label}
        </label>
        {description && <p className="text-xs text-muted mt-0.5">{description}</p>}
      </div>
      <Switch.Root
        id={id}
        checked={checked}
        onCheckedChange={onChange}
        className="relative h-5 w-9 shrink-0 rounded-full bg-line data-[state=checked]:bg-primary transition-colors"
      >
        <Switch.Thumb className="block h-4 w-4 translate-x-0.5 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-4" />
      </Switch.Root>
    </div>
  );
}

export function StatusPill({
  tone,
  children,
}: {
  tone: "success" | "warning" | "danger" | "muted" | "primary";
  children: ReactNode;
}) {
  const tones: Record<string, string> = {
    success: "bg-success/10 text-success",
    warning: "bg-warning/10 text-warning",
    danger: "bg-danger/10 text-danger",
    muted: "bg-line/50 text-muted",
    primary: "bg-primary/10 text-primary",
  };
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${tones[tone]}`}
    >
      {/* status is never conveyed by color alone — the pill always carries text */}
      {children}
    </span>
  );
}

export function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="card p-6 text-center">
      <p className="text-sm font-medium text-ink">{title}</p>
      <p className="mt-1 text-xs text-muted leading-relaxed">{body}</p>
    </div>
  );
}
