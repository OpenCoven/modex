/**
 * Inline stroke icons on a 16×16 grid, drawn in `currentColor` so they follow text colour.
 * The set is limited to glyphs in the parity plan's capability map (controls Modex actually has), so the
 * shell and composer phases draw from one vocabulary; nothing here stands for a feature Modex lacks.
 */
const PATHS = {
  plus: "M8 3.5v9M3.5 8h9",
  home: "M2.5 7.25L8 2.75l5.5 4.5v5.75a.5.5 0 0 1-.5.5h-3.25v-4h-3.5v4H3a.5.5 0 0 1-.5-.5z",
  close: "M4.5 4.5l7 7M11.5 4.5l-7 7",
  check: "M3.5 8.5l3 3 6-7",
  "chevron-down": "M4.5 6.25L8 9.75l3.5-3.5",
  "chevron-up": "M4.5 9.75L8 6.25l3.5 3.5",
  "chevron-right": "M6.25 4.5L9.75 8l-3.5 3.5",
  "arrow-left": "M12.5 8h-9M7 4.5L3.5 8 7 11.5",
  "arrow-right": "M3.5 8h9M9 4.5L12.5 8 9 11.5",
  "arrow-up": "M8 12.5v-9M4.5 7L8 3.5 11.5 7",
  stop: "M5 5h6v6H5z",
  branch: "M5 5.5v5M11 6.5c0 2.5-6 1.5-6 4M5 2.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM5 10.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM11 3.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z",
  folder: "M2.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h4.5a1 1 0 0 1 1 1v5.5a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z",
  search: "M7 11.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zM10.5 10.5l3 3",
  compose: "M8.5 3H4a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V7.5M11.5 2.5l2 2L8 10H6V8z",
  sidebar: "M3 3.5h10a.5.5 0 0 1 .5.5v8a.5.5 0 0 1-.5.5H3a.5.5 0 0 1-.5-.5V4a.5.5 0 0 1 .5-.5zM6.5 3.5v9",
  more: "M4 8h.01M8 8h.01M12 8h.01",
  gear: "M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM8 2v1.5M8 12.5V14M2 8h1.5M12.5 8H14M3.75 3.75l1.06 1.06M11.19 11.19l1.06 1.06M3.75 12.25l1.06-1.06M11.19 4.81l1.06-1.06",
  info: "M8 13.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11zM8 7.5v3M8 5.25h.01",
  laptop: "M3.5 4.5h9v6h-9zM2 12h12",
  changes: "M3 3.5h10v9H3zM9.5 3.5v9",
} as const;

export type IconName = keyof typeof PATHS;
export const ICON_NAMES = Object.keys(PATHS) as IconName[];

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      className={className ? `icon-svg ${className}` : "icon-svg"}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={name === "more" ? 2.25 : 1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      data-icon={name}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
