/**
 * @agentdeploy/edge-ui/theme — Theme system for UI shells
 *
 * Provides a simple CSS variable-based theming system that sellers
 * can customize per-deployment. Themes are applied as CSS custom
 * properties on the shell root element.
 */

export interface UITheme {
  /** Primary brand color */
  primary: string;
  /** Primary text color on primary background */
  primaryText: string;
  /** Background color for the shell root */
  background: string;
  /** Surface/card background */
  surface: string;
  /** Surface hover state */
  surfaceHover: string;
  /** Main text color */
  text: string;
  /** Secondary/muted text color */
  textMuted: string;
  /** Border color */
  border: string;
  /** Error/danger color */
  error: string;
  /** Success color */
  success: string;
  /** Warning color */
  warning: string;
  /** Border radius (px) */
  radius: number;
  /** Font family */
  fontFamily: string;
  /** Font size base (px) */
  fontSize: number;
  /** Max content width (px) */
  maxWidth: number;
  /** Compact spacing (px) for widget mode */
  compactSpacing: number;
  /** Whether dark mode is enabled */
  dark: boolean;
}

export const DEFAULT_LIGHT_THEME: UITheme = {
  primary: "#2563eb",
  primaryText: "#ffffff",
  background: "#ffffff",
  surface: "#f8fafc",
  surfaceHover: "#f1f5f9",
  text: "#0f172a",
  textMuted: "#64748b",
  border: "#e2e8f0",
  error: "#dc2626",
  success: "#16a34a",
  warning: "#d97706",
  radius: 12,
  fontFamily: "system-ui, -apple-system, sans-serif",
  fontSize: 15,
  maxWidth: 480,
  compactSpacing: 8,
  dark: false,
};

export const DEFAULT_DARK_THEME: UITheme = {
  primary: "#3b82f6",
  primaryText: "#ffffff",
  background: "#0f172a",
  surface: "#1e293b",
  surfaceHover: "#334155",
  text: "#f1f5f9",
  textMuted: "#94a3b8",
  border: "#334155",
  error: "#ef4444",
  success: "#22c55e",
  warning: "#f59e0b",
  radius: 12,
  fontFamily: "system-ui, -apple-system, sans-serif",
  fontSize: 15,
  maxWidth: 480,
  compactSpacing: 8,
  dark: true,
};

/**
 * Convert a UITheme object to CSS custom properties.
 * Applied as inline style on the shell root.
 */
export function themeToCSSVars(theme: UITheme): Record<string, string> {
  return {
    "--ad-primary": theme.primary,
    "--ad-primary-text": theme.primaryText,
    "--ad-bg": theme.background,
    "--ad-surface": theme.surface,
    "--ad-surface-hover": theme.surfaceHover,
    "--ad-text": theme.text,
    "--ad-text-muted": theme.textMuted,
    "--ad-border": theme.border,
    "--ad-error": theme.error,
    "--ad-success": theme.success,
    "--ad-warning": theme.warning,
    "--ad-radius": `${theme.radius}px`,
    "--ad-font-family": theme.fontFamily,
    "--ad-font-size": `${theme.fontSize}px`,
    "--ad-max-width": `${theme.maxWidth}px`,
    "--ad-spacing": `${theme.compactSpacing}px`,
  };
}

/**
 * Merge a partial theme override with defaults.
 */
export function createTheme(
  overrides: Partial<UITheme> = {},
  base: UITheme = DEFAULT_LIGHT_THEME,
): UITheme {
  return { ...base, ...overrides };
}

/**
 * Auto-detect dark mode from system preference.
 */
export function isSystemDark(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

/**
 * Get a theme that auto-switches based on system preference.
 */
export function autoTheme(
  overrides: Partial<UITheme> = {},
): UITheme {
  const base = isSystemDark() ? DEFAULT_DARK_THEME : DEFAULT_LIGHT_THEME;
  return createTheme(overrides, base);
}
