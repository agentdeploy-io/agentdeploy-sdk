import React, { useEffect, useState, useCallback, useRef } from "react";
import { TOUR_STEPS, getTourTargetElement } from "./tour";
import { COLORS, RADIUS, Z_INDEX } from "../constants/theme";

export interface ShowcaseOverlayProps {
  stepIndex: number;
  onNext: () => void;
  onPrev: () => void;
  onSkip: () => void;
  totalSteps: number;
}

export const ShowcaseOverlay: React.FC<ShowcaseOverlayProps> = ({
  stepIndex,
  onNext,
  onPrev,
  onSkip,
  totalSteps,
}) => {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const rafRef = useRef<number>(0);

  const step = TOUR_STEPS[stepIndex];

  const updateRect = useCallback(() => {
    if (!step) return;
    const el = getTourTargetElement(step.target);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      setTimeout(() => {
        const r = el.getBoundingClientRect();
        setRect(r);
      }, 350);
    }
  }, [step]);

  useEffect(() => {
    updateRect();
    const handleResize = () => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(updateRect);
    };
    window.addEventListener("resize", handleResize);
    window.addEventListener("scroll", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("scroll", handleResize);
      cancelAnimationFrame(rafRef.current);
    };
  }, [updateRect, stepIndex]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
      if (e.key === "ArrowRight" || e.key === " ") {
        e.preventDefault();
        onNext();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        onPrev();
      } else if (e.key === "Escape") {
        e.preventDefault();
        onSkip();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onNext, onPrev, onSkip]);

  if (!step) return null;

  const padding = 12;
  const spotTop = rect ? rect.top - padding : 0;
  const spotLeft = rect ? rect.left - padding : 0;
  const spotWidth = rect ? rect.width + padding * 2 : 0;
  const spotHeight = rect ? rect.height + padding * 2 : 0;

  const captionWidth = 380;
  let captionLeft = spotLeft + spotWidth / 2 - captionWidth / 2;
  captionLeft = Math.max(16, Math.min(captionLeft, window.innerWidth - captionWidth - 16));

  let captionTop = rect
    ? spotTop + spotHeight + 16
    : window.innerHeight / 2;

  if (captionTop + 200 > window.innerHeight) {
    captionTop = spotTop - 200 - 16;
  }

  const isLast = stepIndex === totalSteps - 1;
  const isFirst = stepIndex === 0;

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: Z_INDEX.overlay + 10, pointerEvents: "none" }}>
      <div
        style={{
          position: "fixed",
          inset: 0,
          background: "transparent",
          boxShadow: rect
            ? `0 0 0 9999px rgba(0, 0, 0, 0.55), inset 0 0 0 9999px rgba(0, 0, 0, 0)`
            : "0 0 0 9999px rgba(0, 0, 0, 0.55)",
          clipPath: rect
            ? `polygon(
                0% 0%, 0% 100%, ${spotLeft}px 100%, ${spotLeft}px ${spotTop}px,
                ${spotLeft + spotWidth}px ${spotTop}px,
                ${spotLeft + spotWidth}px ${spotTop + spotHeight}px,
                ${spotLeft}px ${spotTop + spotHeight}px,
                ${spotLeft}px 100%, 100% 100%, 100% 0%
              )`
            : undefined,
          transition: "clip-path 400ms cubic-bezier(0.4, 0, 0.2, 1)",
          pointerEvents: "auto",
        }}
      />

      {rect && (
        <div
          style={{
            position: "fixed",
            top: spotTop,
            left: spotLeft,
            width: spotWidth,
            height: spotHeight,
            borderRadius: RADIUS.lg,
            border: `2px solid ${COLORS.primary}`,
            boxShadow: `0 0 0 4px rgba(59, 130, 246, 0.15), 0 0 20px rgba(59, 130, 246, 0.2)`,
            pointerEvents: "none",
            transition: "all 400ms cubic-bezier(0.4, 0, 0.2, 1)",
          }}
        />
      )}

      <div
        style={{
          position: "fixed",
          top: captionTop,
          left: captionLeft,
          width: captionWidth,
          backgroundColor: COLORS.card,
          border: `1px solid ${COLORS.border}`,
          borderRadius: RADIUS.lg,
          boxShadow: "0 20px 45px -5px rgba(0,0,0,0.25), 0 8px 10px -6px rgba(0,0,0,0.1)",
          pointerEvents: "auto",
          zIndex: Z_INDEX.overlay + 20,
          overflow: "hidden",
          transition: "all 400ms cubic-bezier(0.4, 0, 0.2, 1)",
        }}
      >
        <div
          style={{
            padding: "20px 24px 16px",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: "8px",
            }}
          >
            <span
              style={{
                fontSize: "0.6875rem",
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.08em",
                color: COLORS.primary,
              }}
            >
              {step.title}
            </span>
            <span
              style={{
                fontSize: "0.6875rem",
                fontWeight: 500,
                color: COLORS.mutedForeground,
              }}
            >
              {stepIndex + 1} / {totalSteps}
            </span>
          </div>
          <p
            style={{
              fontSize: "0.9375rem",
              fontWeight: 500,
              color: COLORS.foreground,
              lineHeight: 1.6,
              margin: 0,
            }}
          >
            {step.caption}
          </p>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "12px 24px 16px",
            borderTop: `1px solid ${COLORS.border}`,
          }}
        >
          <button
            onClick={onSkip}
            style={{
              fontSize: "0.8125rem",
              fontWeight: 500,
              color: COLORS.mutedForeground,
              background: "none",
              border: "none",
              cursor: "pointer",
              padding: "4px 0",
            }}
          >
            Skip tour
          </button>
          <div style={{ display: "flex", gap: "8px" }}>
            {!isFirst && (
              <button
                onClick={onPrev}
                style={{
                  height: "34px",
                  padding: "0 16px",
                  borderRadius: RADIUS.md,
                  border: `1px solid ${COLORS.border}`,
                  backgroundColor: "transparent",
                  color: COLORS.foreground,
                  fontSize: "0.8125rem",
                  fontWeight: 500,
                  cursor: "pointer",
                  transition: "background-color 150ms ease",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = COLORS.secondary)}
                onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
              >
                Back
              </button>
            )}
            <button
              onClick={isLast ? onSkip : onNext}
              style={{
                height: "34px",
                padding: "0 16px",
                borderRadius: RADIUS.md,
                border: "none",
                backgroundColor: COLORS.primary,
                color: COLORS.primaryForeground,
                fontSize: "0.8125rem",
                fontWeight: 500,
                cursor: "pointer",
                transition: "background-color 150ms ease",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = COLORS.primaryHover)}
              onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = COLORS.primary)}
            >
              {isLast ? "Finish tour" : "Next"}
              {!isLast && (
                <span style={{ marginLeft: "6px", opacity: 0.7 }}>→</span>
              )}
            </button>
          </div>
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "center",
            gap: "6px",
            padding: "0 24px 16px",
          }}
        >
          {TOUR_STEPS.map((_, i) => (
            <div
              key={i}
              style={{
                width: i === stepIndex ? "20px" : "6px",
                height: "6px",
                borderRadius: "3px",
                backgroundColor: i === stepIndex ? COLORS.primary : COLORS.border,
                transition: "all 300ms ease",
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
};
