/**
 * Theme Constants
 * ───────────────
 * Design tokens extracted from edge.pen design system.
 * These are the single source of truth for all visual styling.
 * Reference 12factor.net factor III: Store config in the environment.
 *
 * Any visual change should be made here, NOT in component files.
 *
 * IMPORTANT — Dark mode architecture:
 *   COLORS values are CSS variable references (var(--color-*)), NOT
 *   hardcoded hex values. This means every component that uses
 *   COLORS.foreground, COLORS.card, etc. in inline styles will
 *   automatically respond to theme changes. The actual color values
 *   are defined in globals.css under :root (light) and
 *   [data-theme="dark"] (dark). When useTheme sets data-theme="dark"
 *   on <html>, the CSS variables change, and all COLORS.* values
 *   resolve to the dark palette without any React re-render.
 */

// ─── Color Palette ────────────────────────────────────────────────
// All values reference CSS custom properties defined in globals.css.
// This allows dark mode to work by switching CSS variables at the
// :root level without re-rendering any component.
export const COLORS = {
  // Primary brand color
  primary: "var(--color-primary)",
  primaryHover: "var(--color-primary-hover)",
  primaryActive: "var(--color-primary-active)",
  primaryForeground: "var(--color-primary-foreground)",

  // Secondary / muted surfaces
  secondary: "var(--color-secondary)",
  secondaryHover: "var(--color-secondary-hover)",
  secondaryActive: "var(--color-secondary-active)",
  secondaryForeground: "var(--color-secondary-foreground)",

  // Destructive
  destructive: "var(--color-destructive)",
  destructiveHover: "var(--color-destructive-hover)",
  destructiveActive: "var(--color-destructive-active)",
  destructiveForeground: "var(--color-destructive-foreground)",

  // Page backgrounds
  background: "var(--color-background)",
  foreground: "var(--color-foreground)",

  // Card surfaces
  card: "var(--color-card)",
  cardHover: "var(--color-card-hover)",

  // Borders & dividers
  border: "var(--color-border)",
  borderStrong: "var(--color-border-strong)",

  // Muted text
  mutedForeground: "var(--color-muted-foreground)",
  muted: "var(--color-muted)",
} as const;

// ─── Status Colors ───────────────────────────────────────────────
// Also reference CSS variables for dark mode support.
export const STATUS_COLORS = {
  success: "var(--color-success)",
  successForeground: "var(--color-success-foreground)",
  successBg: "var(--color-success-bg)",
  successBorder: "var(--color-success-border)",

  warning: "var(--color-warning)",
  warningForeground: "var(--color-warning-foreground)",
  warningBg: "var(--color-warning-bg)",
  warningBorder: "var(--color-warning-border)",

  error: "var(--color-error)",
  errorForeground: "var(--color-error-foreground)",
  errorBg: "var(--color-error-bg)",
  errorBorder: "var(--color-error-border)",

  info: "var(--color-info)",
  infoForeground: "var(--color-info-foreground)",
  infoBg: "var(--color-info-bg)",
  infoBorder: "var(--color-info-border)",
} as const;

// ─── Typography ──────────────────────────────────────────────────
export const TYPOGRAPHY = {
  fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, system-ui, sans-serif",
  fontMono: "'JetBrains Mono', 'SF Mono', 'Cascadia Code', 'Fira Code', monospace",

  // Font sizes (rem-based scale)
  fontSizeXs: "0.75rem",    // 12px — badges, labels
  fontSizeSm: "0.875rem",   // 14px — body text, buttons
  fontSizeBase: "1rem",     // 16px — base
  fontSizeLg: "1.125rem",   // 18px — card titles
  fontSizeXl: "1.25rem",    // 20px — view titles
  fontSize2xl: "1.5rem",    // 24px — page titles
  fontSize3xl: "1.875rem",  // 30px — hero metrics

  // Font weights
  fontWeightNormal: "400",
  fontWeightMedium: "500",
  fontWeightSemibold: "600",
  fontWeightBold: "700",

  // Line heights
  lineHeightTight: "1.25",
  lineHeightNormal: "1.5",
  lineHeightRelaxed: "1.625",
} as const;

// ─── Spacing Scale ───────────────────────────────────────────────
export const SPACING = {
  0: "0",
  1: "0.25rem",   // 4px
  2: "0.5rem",    // 8px
  3: "0.75rem",   // 12px
  4: "1rem",      // 16px
  5: "1.25rem",   // 20px
  6: "1.5rem",    // 24px
  8: "2rem",      // 32px
  10: "2.5rem",   // 40px
  12: "3rem",     // 48px
  16: "4rem",     // 64px
} as const;

// ─── Border Radius ───────────────────────────────────────────────
export const RADIUS = {
  none: "0",
  sm: "4px",
  md: "8px",      // buttons, inputs
  lg: "12px",     // cards
  xl: "16px",     // badges
  full: "9999px", // pills, dots
} as const;

// ─── Layout Dimensions ───────────────────────────────────────────
export const LAYOUT = {
  sidebarWidth: "280px",
  sidebarCollapsedWidth: "64px",
  topbarHeight: "64px",
  contentMaxWidth: "1440px",
  cardMinWidth: "240px",
  cardMinHeight: "120px",
} as const;

// ─── Component Specs ─────────────────────────────────────────────
export const COMPONENT_SPEC = {
  button: {
    borderRadius: RADIUS.md,
    paddingY: "10px",
    paddingX: "16px",
    fontSize: TYPOGRAPHY.fontSizeSm,
    fontWeight: TYPOGRAPHY.fontWeightMedium,
    gap: "8px",
    height: "40px",
  },
  badge: {
    borderRadius: RADIUS.xl,
    paddingY: "4px",
    paddingX: "12px",
    fontSize: TYPOGRAPHY.fontSizeXs,
    fontWeight: TYPOGRAPHY.fontWeightMedium,
  },
  card: {
    borderRadius: RADIUS.lg,
    padding: "20px",
    borderWidth: "1px",
    borderStyle: "solid",
  },
  input: {
    borderRadius: RADIUS.md,
    height: "40px",
    paddingY: "8px",
    paddingX: "12px",
    borderWidth: "1px",
    borderStyle: "solid",
  },
  navItem: {
    height: "40px",
    gap: "12px",
    paddingX: "12px",
    borderRadius: RADIUS.md,
  },
  tab: {
    height: "48px",
    paddingX: "16px",
    fontSize: TYPOGRAPHY.fontSizeSm,
    activeBorderWidth: "2px",
  },
  tableHeader: {
    height: "44px",
  },
  tableRow: {
    height: "48px",
  },
} as const;

// ─── Z-Index Scale ───────────────────────────────────────────────
export const Z_INDEX = {
  base: 0,
  dropdown: 100,
  sticky: 200,
  overlay: 900,
  modal: 1000,
  toast: 1100,
  tooltip: 1200,
} as const;

// ─── Shadows ─────────────────────────────────────────────────────
export const SHADOWS = {
  sm: "0 1px 2px 0 rgba(0, 0, 0, 0.05)",
  md: "0 4px 6px -1px rgba(0, 0, 0, 0.07), 0 2px 4px -2px rgba(0, 0, 0, 0.05)",
  lg: "0 10px 15px -3px rgba(0, 0, 0, 0.08), 0 4px 6px -4px rgba(0, 0, 0, 0.05)",
  xl: "0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.05)",
} as const;

// ─── Transitions ─────────────────────────────────────────────────
export const TRANSITIONS = {
  fast: "150ms cubic-bezier(0.4, 0, 0.2, 1)",
  normal: "200ms cubic-bezier(0.4, 0, 0.2, 1)",
  slow: "300ms cubic-bezier(0.4, 0, 0.2, 1)",
} as const;

// ─── Type Exports ─────────────────────────────────────────────────
export type ButtonVariant = "primary" | "secondary" | "outline" | "ghost" | "destructive";
export type BadgeVariant = "success" | "warning" | "error" | "info" | "neutral";
export type CardVariant = "default" | "metric" | "outline";

// ─── CSS Variable Definitions (light theme defaults) ─────────────
// These raw hex values define the light theme. They are injected as
// CSS custom properties on :root by main.tsx. The dark theme
// overrides are in globals.css under [data-theme="dark"].
//
// NOTE: We inject via JS (not hardcoded in :root in globals.css) so
// that the values stay in the TypeScript type system as the single
// source of truth. The dark overrides in globals.css use literal hex
// values because they are theme-specific.
export const CSS_VARS = {
  "--color-primary": "#2563EB",
  "--color-primary-hover": "#1D4ED8",
  "--color-primary-active": "#1E40AF",
  "--color-primary-foreground": "#FFFFFF",

  "--color-secondary": "#F4F4F5",
  "--color-secondary-hover": "#E4E4E7",
  "--color-secondary-active": "#D4D4D8",
  "--color-secondary-foreground": "#09090B",

  "--color-destructive": "#DC2626",
  "--color-destructive-hover": "#B91C1C",
  "--color-destructive-active": "#991B1B",
  "--color-destructive-foreground": "#FFFFFF",

  "--color-background": "#FFFFFF",
  "--color-foreground": "#09090B",

  "--color-card": "#FFFFFF",
  "--color-card-hover": "#FAFAFA",

  "--color-border": "#E4E4E7",
  "--color-border-strong": "#D4D4D8",

  "--color-muted": "#F4F4F5",
  "--color-muted-foreground": "#71717A",

  "--color-success": "#22C55E",
  "--color-success-foreground": "#FFFFFF",
  "--color-success-bg": "#F0FDF4",
  "--color-success-border": "#BBF7D0",

  "--color-warning": "#F59E0B",
  "--color-warning-foreground": "#FFFFFF",
  "--color-warning-bg": "#FFFBEB",
  "--color-warning-border": "#FDE68A",

  "--color-error": "#EF4444",
  "--color-error-foreground": "#FFFFFF",
  "--color-error-bg": "#FEF2F2",
  "--color-error-border": "#FECACA",

  "--color-info": "#3B82F6",
  "--color-info-foreground": "#FFFFFF",
  "--color-info-bg": "#EFF6FF",
  "--color-info-border": "#BFDBFE",

  "--radius-sm": RADIUS.sm,
  "--radius-md": RADIUS.md,
  "--radius-lg": RADIUS.lg,
  "--radius-xl": RADIUS.xl,
  "--radius-full": RADIUS.full,

  "--font-sans": TYPOGRAPHY.fontFamily,
  "--font-mono": TYPOGRAPHY.fontMono,

  "--shadow-sm": SHADOWS.sm,
  "--shadow-md": SHADOWS.md,
  "--shadow-lg": SHADOWS.lg,
  "--shadow-xl": SHADOWS.xl,

  "--sidebar-width": LAYOUT.sidebarWidth,
  "--topbar-height": LAYOUT.topbarHeight,
} as const;
