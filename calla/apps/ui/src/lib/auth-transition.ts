/**
 * AuthTransition
 * ───────────────
 * Full-screen overlay shown immediately before a 401 re-exchange redirect.
 *
 * Why: when the edge JWT is stale, the app redirects to the token-exchange
 * endpoint mid-render. Without an overlay, the user sees a brief flash of
 * raw/unauthenticated UI before navigation. This paints a branded
 * "Re-authenticating…" screen synchronously so the flash never appears.
 *
 * Usage: call `showAuthTransition()` (or `redirectWithAuthTransition(url)`)
 * right before assigning `window.location.href`.
 *
 * Zero dependencies — plain DOM + inline CSS variables so it works even
 * before React/Tailwind have painted.
 */

const OVERLAY_ID = "calla-auth-transition-overlay";

/**
 * Show the re-authentication overlay. Idempotent — safe to call twice.
 * Uses CSS custom properties from the theme so it matches light/dark.
 */
export function showAuthTransition(message = "Re-authenticating…"): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(OVERLAY_ID)) return;

  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;
  overlay.setAttribute("role", "status");
  overlay.setAttribute("aria-live", "polite");

  overlay.style.cssText = [
    "position:fixed",
    "inset:0",
    "z-index:9999",
    "display:flex",
    "flex-direction:column",
    "align-items:center",
    "justify-content:center",
    "gap:16px",
    "background:hsl(var(--background, 0 0% 100%))",
    "color:hsl(var(--muted-foreground, 240 5% 65%))",
    "font-family:var(--font-sans, system-ui, sans-serif)",
    "font-size:0.875rem",
  ].join(";");

  const spinner = document.createElement("div");
  spinner.style.cssText = [
    "width:28px",
    "height:28px",
    "border-radius:50%",
    "border:3px solid hsl(var(--border, 240 6% 90%))",
    "border-top-color:hsl(var(--primary, 221 83% 53%))",
    "animation:calla-auth-spin 0.8s linear infinite",
  ].join(";");

  const label = document.createElement("span");
  label.textContent = message;

  const style = document.createElement("style");
  style.textContent = "@keyframes calla-auth-spin{to{transform:rotate(360deg)}}";

  overlay.appendChild(spinner);
  overlay.appendChild(label);
  overlay.appendChild(style);
  document.body.appendChild(overlay);
}

/**
 * Show the overlay, then navigate. Small delay lets the browser paint the
 * overlay before the beforeunload/navigation freezes rendering.
 */
export function redirectWithAuthTransition(
  url: string,
  message?: string,
): void {
  showAuthTransition(message);
  window.location.href = url;
}

/** Remove the overlay (used after a failed exchange returns to the app). */
export function hideAuthTransition(): void {
  if (typeof document === "undefined") return;
  document.getElementById(OVERLAY_ID)?.remove();
}
