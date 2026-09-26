import type { ButtonHTMLAttributes } from "react";
import { Icon, type IconName } from "./Icon";
import { Tooltip } from "./Tooltip";

interface Props extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "title"> {
  icon: IconName;
  /** Accessible name, also shown as the tooltip. Required: an icon alone has no name. */
  label: string;
  shortcut?: string;
  /** Hidden until the parent row is hovered (sidebar rows). */
  reveal?: boolean;
  size?: "sm" | "md";
  tooltipSide?: "top" | "bottom";
}

/** A square, icon-only button with an accessible name and a tooltip. */
export function IconButton({ icon, label, shortcut, reveal, size = "sm", tooltipSide, className, type = "button", ...rest }: Props) {
  return (
    <Tooltip label={label} shortcut={shortcut} side={tooltipSide}>
      <button
        type={type}
        aria-label={label}
        className={`icon-btn ${size}${reveal ? " reveal" : ""}${className ? ` ${className}` : ""}`}
        {...rest}
      >
        <Icon name={icon} size={size === "sm" ? 14 : 16} />
      </button>
    </Tooltip>
  );
}
