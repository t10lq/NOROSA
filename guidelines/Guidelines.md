# NOROSA — Visual Guidelines

## Aesthetic: Dark Immersive

A cryptographic meeting room where the server sees nothing. The interface recedes into darkness — controls appear only when needed, surfaces are near-invisible, and the one accent color (deep red) signals destruction, urgency, and the boundary between safety and exposure.

## Palette

| Token | Value | Use |
|-------|-------|-----|
| Background | `#0A0A0B` | Page ground — near-black |
| Surface | `#111113` | Elevated panels, cards |
| Surface-2 | `#18181B` | Hover, selected states |
| Off-white | `#F0EEE9` | Primary text |
| Muted | `#5C5C63` | Labels, captions, secondary |
| Deep red | `#B3241F` | Danger, exit, recording alert |
| Red dim | `#6B1512` | Red hover states |
| Border | `rgba(255,255,255,0.06)` | Hairline rules |
| Border-hover | `rgba(255,255,255,0.12)` | Interactive borders |

## Typography

- **Display/UI:** Outfit — clean, geometric, restrained. Used for names, headings, button labels.
- **Mono:** Space Mono — room codes, generated identities, security hashes. Signals cryptographic authenticity.
- Scale anchored to golden ratio (φ = 1.618): 10 / 13 / 21 / 34px steps.

## Golden Ratio

φ = 1.618 governs spacing and proportion:
- Base unit: 8px → 13 → 21 → 34 → 55 → 89px
- Video grid: 16:9.89 aspect (≈ φ²)
- Sidebar: screen width / φ for chat panel
- Control bar height: 55px (Fibonacci)

## Structure

- **Full-bleed darkness** — no contained "app shell", content bleeds to viewport edges
- **Receding chrome** — controls at opacity 0.4, rise to 1 on hover/focus
- **Single red thread** — `#B3241F` appears only for destructive/alert states; never decorative
- **Thin progress** — a 1px line is the only persistent chrome
- **Minimal overlays** — alerts use translucent dark panels, never modal backdrops

## Never

- Glow, neon, multicolor gradients
- Condensed all-caps type
- Horizontal information bands or tickers
- Rounded cards on gray
- Blue accents
