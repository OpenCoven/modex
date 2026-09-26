import type { ReactNode } from "react";

/** A keyboard shortcut chip, e.g. <Kbd>⌘⏎</Kbd>. */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}
