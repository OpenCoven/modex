# Design tokens: where the numbers come from

`src/renderer/tokens.css` holds the tokens for the Codex-parity chat UI. This file records how each
measured value was taken, so a later phase can re-measure instead of guessing. `e2e/layout.spec.ts`
("Phase 2 · tokens") asserts every measured value, so a change to one of them is a deliberate design
decision and shows up in review.

## Reference

Codex desktop screenshots at **1786×1049, 1× scale**. The red traffic light measures 12 px, which is
macOS's native size, so screenshot pixels map 1:1 to CSS px. The images show private project names and
stay out of the repo. Coordinates below are for screenshot #1: the empty "What should we build in
coven-threads?" screen, with the sidebar expanded and the composer at the bottom.

## Colours

Surfaces are single flat pixels. Text is the **brightest glyph-core pixel** in the text's box, because
anti-aliased edges are darker than the real colour.

| Token | Value | Sampled at (x,y) or box |
|---|---|---|
| `--bg-window` | `#1b1b1c` | (600,20) titlebar, (23,400) rail |
| `--bg-sidebar` | `#131315` | (170,120) |
| `--bg-main` | `#0f0f11` | (1000,300) |
| `--bg-row-selected` | `#222224` | (160,181), the selected project row |
| `--bg-composer` | `#262729` | (1000,975) |
| `--bg-composer-context` | `#151517` | (1000,912), the project · Local · branch strip |
| `--bg-user-bubble` | `#1a1a1c` | user message, screenshot #8 |
| `--border-pane` | `#2a2a2b` | x=289, the sidebar/main divider |
| `--border-rail` | `#1f1f21` | x=48 |
| `--border-composer` | `#2b2c2e` | (668,975) left edge, (1000,931) top edge |
| `--rule` | `#1f1f21` | rule under "Working for 7s", screenshot #8 |
| `--text-1` | `#e3e4e6` | heading box 795–1276 × 476–506. Also the context strip and model label |
| `--text-2` | `#c4c5c6` | thread row "Review incomplete tasks" 89–250 × 235–252. Project row reads `#c7c7c9` |
| `--text-3` | `#757577` | "Show more" 89–162 × 523–539. Model effort "High" reads `#7f8082` |
| `--text-4` | `#5c5c5f` | "Projects" 65–120 × 142–158 |
| `--text-placeholder` | `#535455` | "Do anything" 680–760 × 947–963 |
| `--accent-warn` | `#dc9258` | "Full access", most saturated pixel in 735–802 × 999–1015 |

**Derived** (no reference pixel): `--bg-row-hover`, `--bg-elevated`, `--bg-sunken` and
`--border-strong`, each chosen between measured neighbours. `--accent` stays Modex's blue. Codex is
monochrome apart from "Full access".

## Type sizes

Cap heights can't tell 13 px from 14 px apart: both render a 10 px cap. So sizes are fitted by
**ink width**. The same string is measured in Electron's own font stack (`-apple-system`, canvas
`measureText` actual bounding box) and compared with the reference ink width. PIL's SF Pro render
isn't a substitute: it lacks the small-size optical tracking and reads 1–2 px narrow.

| String (where) | Reference ink px | Best fit | Token |
|---|---|---|---|
| "Full access" (composer bar) | 65 | 13/400 = 65 | `--text-sm` |
| "coven-threads" (context strip) | 87 | 13/400 = 87 | `--text-sm` |
| "GPT-6 Astra" (model label) | 74 | 13/400 = 73 | `--text-sm` |
| "Do anything" (placeholder) | 76 | 14/400 = 75 | `--text-md` |
| "New chat" (sidebar) | 60 | 14/400 = 59, 14/500 = 60 | `--text-md` |
| "Review incomplete tasks" (row) | 159 | 14/400 = 157, 14/500 = 161 | `--text-md` |
| "Show more" (sidebar) | 71 | 14/400 = 71 | `--text-md` |
| "Projects" (section label) | 53 | 14/500 = 52 | `--text-md`, medium |
| "Codex" (sidebar title, cap 13 px) | ≈52 | 18/600 | `--text-lg` |
| "What should we build in coven-threads?" | 481 | 28/400 = 480 | `--text-xl` |

## Radii

Measured along the top edge of a filled box: the number of pixels, row by row, before the fill starts.
The inset profile is then compared with a circle.

| Token | Value | Profile (inset px, rows from the top edge) |
|---|---|---|
| `--radius-row` | 10 px | selected row at (57,166): 9 5 4 3 2 1 1 1 1 0 |
| `--radius-composer` | 20 px ±2 | composer at (668,931): 18 15 12 11 7 6 5 6 5 5 4 3 3 3 2 2 0. The 1 px border's anti-aliasing adds noise; Phase 4 re-checks it against the rendered box |

## Geometry

Consumed by later phases, asserted in `layout.spec.ts` as each phase ships: rail 48 px, sidebar
240 px (x 49–288), 1 px dividers, titlebar ≈42 px, composer ≈736×98 at x 668–1403 / y 931–1028,
context strip 38 px tall (y 893–931) starting at x 681.

## Capture size in CI

GitHub's macOS runner has a small display, and macOS clamps a window to the screen, so captures came out
at 1024×677. The e2e window now opens with `enableLargerThanScreen` when `MODEX_E2E` is set, and the capture
test **fails** if the viewport isn't 1786×1049. A local check asked for 4400×2600, larger than any
attached display: with the flag the window got 4400×2600, and without it the height was clamped to 1050.
