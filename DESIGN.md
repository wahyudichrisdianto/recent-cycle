# Design context

Recent Cycle uses a restrained product UI system for a browser popup and a companion setup page.

## Shared foundation

- `ui.css` owns tokens, typography, focus states, panels, status banners, buttons, and keyboard badges.
- `popup.css` owns only the popup shell, configuration rows, recent-tab list, and compact responsive behavior.
- `companion.css` owns only the setup page grid and content layout.
- Both surfaces load `ui.css` first and reuse the same panel, border, type, and state vocabulary.

## Visual language

- Tinted neutral canvas, solid panels, quiet borders, and one green action accent.
- Orange is reserved for degraded companion coverage and warnings.
- System sans for readable content, monospace for shortcuts and small state labels.
- No colored glow shadows, gradient text, or nested panel containers.
- Compact labels are at least 11px; content text is at least 12px.

## Responsive behavior

- The popup window stays fixed at 380px, matching Chrome action-popup sizing; only its inner controls reflow at narrow breakpoints.
- The setup page uses a two-column platform comparison above 680px and a single-column flow below it.
- Focus-visible states are always present for keyboard interaction.
