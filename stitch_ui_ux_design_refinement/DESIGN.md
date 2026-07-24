---
name: Obsidian Flux
colors:
  surface: '#0b1326'
  surface-dim: '#0b1326'
  surface-bright: '#31394e'
  surface-container-lowest: '#060d20'
  surface-container-low: '#131b2e'
  surface-container: '#171f33'
  surface-container-high: '#222a3e'
  surface-container-highest: '#2d3449'
  on-surface: '#dbe2fd'
  on-surface-variant: '#c1c6d7'
  inverse-surface: '#dbe2fd'
  inverse-on-surface: '#283044'
  outline: '#8b90a0'
  outline-variant: '#414755'
  surface-tint: '#adc6ff'
  primary: '#adc6ff'
  on-primary: '#002e69'
  primary-container: '#4b8eff'
  on-primary-container: '#00285c'
  inverse-primary: '#005bc1'
  secondary: '#4edea3'
  on-secondary: '#003824'
  secondary-container: '#00a572'
  on-secondary-container: '#00311f'
  tertiary: '#ffb2b7'
  on-tertiary: '#67001b'
  tertiary-container: '#ff516a'
  on-tertiary-container: '#5b0017'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#d8e2ff'
  primary-fixed-dim: '#adc6ff'
  on-primary-fixed: '#001a41'
  on-primary-fixed-variant: '#004493'
  secondary-fixed: '#6ffbbe'
  secondary-fixed-dim: '#4edea3'
  on-secondary-fixed: '#002113'
  on-secondary-fixed-variant: '#005236'
  tertiary-fixed: '#ffdadb'
  tertiary-fixed-dim: '#ffb2b7'
  on-tertiary-fixed: '#40000d'
  on-tertiary-fixed-variant: '#92002a'
  background: '#0b1326'
  on-background: '#dbe2fd'
  surface-variant: '#2d3449'
  surface-accent: '#1E293B'
  electric-blue: '#007AFF'
  emerald-live: '#10B981'
  rose-error: '#F43F5E'
  amber-warn: '#F59E0B'
  text-primary: '#dae2fd'
  text-secondary: '#c1c6d7'
  text-muted: '#8b90a0'
  glass-stroke: rgba(255, 255, 255, 0.08)
typography:
  headline-lg:
    fontFamily: Inter
    fontSize: 32px
    fontWeight: '700'
    lineHeight: '1.2'
    letterSpacing: -0.02em
  headline-md:
    fontFamily: Inter
    fontSize: 24px
    fontWeight: '600'
    lineHeight: '1.3'
  headline-sm:
    fontFamily: Inter
    fontSize: 18px
    fontWeight: '600'
    lineHeight: '1.4'
  body-lg:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '400'
    lineHeight: '1.6'
  body-md:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '400'
    lineHeight: '1.5'
  body-sm:
    fontFamily: Inter
    fontSize: 13px
    fontWeight: '400'
    lineHeight: '1.5'
  data-lg:
    fontFamily: JetBrains Mono
    fontSize: 16px
    fontWeight: '600'
    lineHeight: '1.2'
  data-md:
    fontFamily: JetBrains Mono
    fontSize: 14px
    fontWeight: '500'
    lineHeight: '1.2'
  data-sm:
    fontFamily: JetBrains Mono
    fontSize: 12px
    fontWeight: '500'
    lineHeight: '1.2'
    letterSpacing: 0.05em
  label-caps:
    fontFamily: Inter
    fontSize: 11px
    fontWeight: '700'
    lineHeight: '1'
    letterSpacing: 0.1em
rounded:
  sm: 0.25rem
  DEFAULT: 0.5rem
  md: 0.75rem
  lg: 1rem
  xl: 1.5rem
  full: 9999px
spacing:
  base: 4px
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 32px
  xxl: 48px
  container-max: 1240px
  gutter: 16px
---

## Brand & Style

The design system is a high-end "Mission Control" interface designed for technical precision and high-density data management. It targets power users who require a sense of security, speed, and futuristic sophistication.

The design style is **Glassmorphism 2.0**. It evolves the standard frosted-glass look by introducing multi-layered depth, "Surface Dim" foundations, and atmospheric lighting. The interface should feel like a holographic display projected onto a dark obsidian surface. 

**Key Visual Principles:**
- **Atmospheric Depth:** Use deep radial gradients in the background to simulate ambient light sources.
- **Micro-Glows:** Use subtle glow effects for active states and critical status indicators to draw the eye without creating visual noise.
- **Technical Precision:** Use sharp internal alignments and monospaced data to reinforce the "pro-tool" personality.
- **Glass Optics:** Borders are not just solid lines but "strokes of light" that define the edges of translucent panels.

## Colors

The palette is anchored in **Surface Dim (#0b1326)**, providing a high-contrast foundation for translucent layers. 

- **Primary (Electric Blue):** Used for critical paths, primary actions, and focus states. It should always carry a subtle outer glow when active.
- **Secondary (Emerald Live):** Reserved for "active" or "success" statuses. It represents the "pulse" of the system.
- **Tertiary (Rose Error):** Used sparingly for destructive actions and critical system failures.
- **Neutral:** A range of deep slates and navies used to create a hierarchy of containment.

**Glass Implementation:**
Glass panels use `--bg-slate-surface` at 60-80% opacity with a `backdrop-filter: blur(20px)`. The stroke must be a semi-transparent white or a light-tinted version of the accent color to simulate light hitting the edge of the glass.

## Typography

The typography strategy leverages **Inter** for all interface labels and narrative text to ensure maximum legibility at small sizes. **JetBrains Mono** is reserved strictly for technical data, file paths, IDs, and status badges.

- **Headlines:** Should use tighter letter spacing and heavy weights to feel authoritative.
- **Data Roles:** Any text representing a system value or a file attribute must use the `data` tokens.
- **Label Caps:** Used for table headers and small metadata category labels.
- **Mobile Scaling:** For mobile devices, `headline-lg` should scale down to `24px` (`headline-md`) to prevent awkward text wrapping on small glass panels.

## Layout & Spacing

The system uses an **8px base grid** for most components, with a **4px sub-grid** for tight micro-interactions like icon padding or small labels.

**Layout Model:**
- **Dashboard Grid:** A 12-column fluid grid for the main content area.
- **Fixed Constraints:** Modals and specific utility panels use fixed max-widths (760px for inspectors, 900px for lightboxes) to maintain a centered "focus mode."
- **Margins & Gutters:** Main viewports use 24px margins on desktop, scaling down to 16px on mobile.

**Responsive Reflow:**
- **Desktop (1024px+):** Full multi-column view with sidebar navigation.
- **Tablet (768px - 1023px):** Sidebars collapse into icons or a hamburger menu; cards stack into two columns.
- **Mobile (<768px):** All grids collapse to a single column. Horizontal padding is reduced to 16px.

## Elevation & Depth

This design system does not use traditional shadows to simulate height. Instead, depth is conveyed through **Tonal Layering** and **Optical Blurs**.

- **Level 0 (Base):** The `--bg-surface-dim` background with subtle radial gradients.
- **Level 1 (Panels):** Large containers using `backdrop-filter: blur(16px)` and a `--glass-stroke` border.
- **Level 2 (Cards):** Inner elements like list items or dashboard cards. These use a slightly lighter background (`--bg-surface-container`) and `blur(12px)`.
- **Level 3 (Interactive):** Elements that are being hovered or focused. These receive a secondary glow effect using a low-opacity version of the primary color (`rgba(0, 122, 255, 0.2)`).
- **Floating (Toasts/Modals):** High-opacity (`0.9`) glass with the most aggressive blur (24px) and a large, diffused black shadow to separate the element from the dashboard beneath.

## Shapes

The shape language balances modern approachability with technical structure.

- **Main Cards & Panels:** Use the `rounded-lg` (16px) or `rounded-xl` (24px) for a premium, integrated feel.
- **Inputs & Buttons:** Use `rounded-md` (8px) to maintain a crisp, functional appearance.
- **Status Pills:** Always use `rounded-full` to distinguish them from interactive buttons.

Borders on all shapes should be thin (1px) and use the semi-transparent glass stroke to ensure they feel like part of the atmospheric environment rather than heavy dividers.

## Components

### Buttons
- **Primary:** Solid Electric Blue with white text. Hover state triggers a `0 0 15px` blue glow.
- **Secondary/Action:** Translucent glass button with white stroke. 
- **Pulse Button:** A specific variant for "Live" or "Running" tasks, featuring a subtle scaling animation on a small status dot within the button.

### Input Fields
- **Glow Inputs:** Dark backgrounds with a 1px `glass-stroke`. On focus, the border transitions to Electric Blue and an inner glow is applied. Labels should use `data-sm` for a technical feel.

### Cards & Glass Panels
- All cards must feature a 1px top-highlight (a lighter stroke on the top edge than the bottom) to simulate a light source from above.

### Chips & Badges
- **Tech Tags:** Small, monospaced (`data-sm`), using low-saturation versions of the status colors (e.g., a dark emerald background with bright emerald text).

### List Items (The Ledger)
- High-density rows with `1px` dividers. Each row should have a subtle hover state that increases the background opacity slightly, making it feel "lit from behind."

### Keypad (Auth)
- Large, tactile glass buttons. Active states for keys should use the `fadeInScale` animation to provide immediate visual feedback.