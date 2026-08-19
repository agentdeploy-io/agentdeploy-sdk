/**
 * Card Component
 * ──────────────
 * Container for grouping related content. Supports:
 *   - default: White card with border
 *   - metric: Card optimized for displaying a metric + label
 *   - outline: Transparent card with border only (no bg)
 *
 * Design spec: cornerRadius:12, padding:20, border:1px solid #E4E4E7
 *
 * Variants:
 *   <Card>                    — standard content card
 *   <Card variant="metric">   — metric display (value + label + trend)
 *   <Card variant="outline">  — subtle container
 *
 * Sub-components:
 *   <Card.Header>  — title, subtitle, and actions row
 *   <Card.Body>    — main content area
 *   <Card.Footer>  — footer actions/metadata
 */

import React from "react";
import { COMPONENT_SPEC, COLORS, RADIUS, SHADOWS, STATUS_COLORS } from "../../constants/theme";
import type { CardVariant } from "../../constants/theme";

// ─── Types for Sub-components ────────────────────────────────────

export interface CardHeaderProps {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  icon?: React.ReactNode;
  actions?: React.ReactNode;
  style?: React.CSSProperties;
}

interface CardBodyProps {
  children: React.ReactNode;
  style?: React.CSSProperties;
}

// ─── Main Card Type ──────────────────────────────────────────────

export interface CardProps {
  variant?: CardVariant;
  children: React.ReactNode;
  padding?: "none" | "sm" | "md" | "lg";
  hoverable?: boolean;
  onClick?: () => void;
  style?: React.CSSProperties;
  id?: string;
  className?: string;
}

type CardComponent = React.FC<CardProps> & {
  Header: React.FC<CardHeaderProps>;
  Body: React.FC<CardBodyProps>;
  Footer: React.FC<CardBodyProps>;
};

// ─── Main Card ───────────────────────────────────────────────────

const CardBase: React.FC<CardProps> = React.memo(
  ({ variant = "default", children, padding = "md", hoverable = false, onClick, style, id, className }) => {
    return (
      <div
        id={id}
        className={className}
        onClick={onClick}
        role={onClick ? "button" : undefined}
        tabIndex={onClick ? 0 : undefined}
        style={{
          borderRadius: COMPONENT_SPEC.card.borderRadius,
          padding: paddingSizes[padding],
          border: `${COMPONENT_SPEC.card.borderWidth} solid ${COLORS.border}`,
          backgroundColor: variant === "outline" ? "transparent" : COLORS.card,
          boxShadow: variant === "default" ? SHADOWS.sm : "none",
          transition: onClick || hoverable ? "box-shadow 200ms ease, border-color 200ms ease" : "none",
          cursor: onClick ? "pointer" : "default",
          ...style,
        }}
      >
        {children}
      </div>
    );
  },
);

CardBase.displayName = "Card";

// ─── Card Header ─────────────────────────────────────────────────

const CardHeader: React.FC<CardHeaderProps> = ({ title, subtitle, icon, actions, style }) => (
  <div
    style={{
      display: "flex",
      alignItems: "flex-start",
      justifyContent: "space-between",
      gap: "16px",
      marginBottom: "16px",
      ...style,
    }}
  >
    <div style={{ display: "flex", alignItems: "center", gap: "12px", minWidth: 0 }}>
      {icon && <span style={{ flexShrink: 0 }}>{icon}</span>}
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontSize: "1rem",
            fontWeight: 600,
            color: COLORS.foreground,
            lineHeight: 1.3,
          }}
        >
          {title}
        </div>
        {subtitle && (
          <div
            style={{
              fontSize: "0.8125rem",
              color: COLORS.mutedForeground,
              marginTop: "2px",
            }}
          >
            {subtitle}
          </div>
        )}
      </div>
    </div>
    {actions && <div style={{ flexShrink: 0, display: "flex", gap: "8px" }}>{actions}</div>}
  </div>
);

CardHeader.displayName = "Card.Header";

// ─── Card Body ───────────────────────────────────────────────────

const CardBody: React.FC<CardBodyProps> = ({
  children,
  style,
}) => (
  <div style={{ fontSize: "0.875rem", color: COLORS.foreground, ...style }}>{children}</div>
);

CardBody.displayName = "Card.Body";

// ─── Card Footer ─────────────────────────────────────────────────

const CardFooter: React.FC<CardBodyProps> = ({
  children,
  style,
}) => (
  <div
    style={{
      marginTop: "16px",
      paddingTop: "16px",
      borderTop: `1px solid ${COLORS.border}`,
      display: "flex",
      alignItems: "center",
      justifyContent: "flex-end",
      gap: "8px",
      ...style,
    }}
  >
    {children}
  </div>
);

CardFooter.displayName = "Card.Footer";

// ─── Create Compound Component ───────────────────────────────────

export const Card = CardBase as CardComponent;
Card.Header = CardHeader;
Card.Body = CardBody;
Card.Footer = CardFooter;

// ─── Metric Card ─────────────────────────────────────────────────

export interface MetricCardProps {
  label: string;
  value: string | number;
  /** Change indicator (e.g., "+12.5%" or "-3.2%") */
  change?: string;
  changeDirection?: "up" | "down" | "neutral";
  icon?: React.ReactNode;
  onClick?: () => void;
}

export const MetricCard: React.FC<MetricCardProps> = React.memo(
  ({ label, value, change, changeDirection = "neutral", icon, onClick }) => {
    const changeColor =
      changeDirection === "up"
        ? STATUS_COLORS.success
        : changeDirection === "down"
          ? STATUS_COLORS.error
          : COLORS.mutedForeground;

    return (
      <Card onClick={onClick} hoverable={!!onClick}>
        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <span style={{ fontSize: "0.8125rem", color: COLORS.mutedForeground, fontWeight: 500 }}>
              {label}
            </span>
            {icon && <span style={{ color: COLORS.mutedForeground }}>{icon}</span>}
          </div>
          <span style={{ fontSize: "1.875rem", fontWeight: 700, color: COLORS.foreground, lineHeight: 1.2 }}>
            {value}
          </span>
          {change && (
            <span style={{ fontSize: "0.8125rem", color: changeColor, fontWeight: 500 }}>
              {changeDirection === "up" ? "↑" : changeDirection === "down" ? "↓" : "→"} {change}
            </span>
          )}
        </div>
      </Card>
    );
  },
);

MetricCard.displayName = "MetricCard";

// ─── Padding Sizes ───────────────────────────────────────────────

const paddingSizes: Record<string, string> = {
  none: "0",
  sm: "12px",
  md: COMPONENT_SPEC.card.padding,
  lg: "24px",
};
