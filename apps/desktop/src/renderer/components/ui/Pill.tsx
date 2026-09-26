import type { HTMLAttributes, ReactNode } from "react";

export type PillTone = "neutral" | "accent" | "warn" | "danger" | "claude" | "codex" | "auto";

interface Props extends Omit<HTMLAttributes<HTMLSpanElement>, "className"> {
  tone?: PillTone;
  /** Extra classes, e.g. "mono". */
  className?: string;
  children: ReactNode;
}

/** A small rounded label: status, backend, branch. Passes through data-* and ARIA attributes. */
export function Pill({ tone = "neutral", className, children, ...rest }: Props) {
  return (
    <span className={`pill tone-${tone}${className ? ` ${className}` : ""}`} {...rest}>
      {children}
    </span>
  );
}
