/**
 * Dropdown Menu Component
 * ───────────────────────
 * Click-triggered dropdown menu with items.
 *
 * Features:
 *   - Trigger element (button or custom)
 *   - Items with icon, label, description
 *   - Dividers between items
 *   - Destructive item variant
 *   - Disabled items
 *   - Keyboard navigation
 *   - Click outside to close
 *
 * Usage:
 *   <Dropdown trigger={<Button>Actions</Button>}>
 *     <Dropdown.Item onClick={handleEdit}>Edit</Dropdown.Item>
 *     <Dropdown.Divider />
 *     <Dropdown.Item onClick={handleDelete} destructive>Delete</Dropdown.Item>
 *   </Dropdown>
 */

import React from "react";
import { COLORS, RADIUS, Z_INDEX, TRANSITIONS, STATUS_COLORS } from "../../constants/theme";

// ─── Types ───────────────────────────────────────────────────────

export interface DropdownProps {
  trigger: React.ReactElement;
  children: React.ReactNode;
  align?: "left" | "right";
  width?: number;
}

export interface DropdownItemProps {
  children: React.ReactNode;
  icon?: React.ReactNode;
  onClick?: () => void;
  destructive?: boolean;
  disabled?: boolean;
}

// ─── Component ───────────────────────────────────────────────────

export const Dropdown: React.FC<DropdownProps> & {
  Item: React.FC<DropdownItemProps>;
  Divider: React.FC;
} = ({ trigger, children, align = "right", width = 200 }) => {
  const [open, setOpen] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement>(null);

  // Close on outside click
  React.useEffect(() => {
    if (!open) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };

    // Delay to avoid immediate close from the trigger click
    const timer = setTimeout(() => {
      document.addEventListener("mousedown", handleClickOutside);
    }, 0);

    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [open]);

  // Close on Escape
  React.useEffect(() => {
    if (!open) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  // Clone trigger to handle click
  const triggerProps = trigger.props as React.HTMLAttributes<HTMLElement>;
  const triggerElement = React.cloneElement(trigger, {
    onClick: (e: React.MouseEvent<HTMLElement>) => {
      e.stopPropagation();
      setOpen((prev) => !prev);
      (triggerProps.onClick as ((e: React.MouseEvent<HTMLElement>) => void) | undefined)?.(e);
    },
  } as React.HTMLAttributes<HTMLElement>);

  // Wrap children items to auto-close on click
  const wrappedChildren = React.Children.map(children, (child) => {
    if (React.isValidElement(child) && child.type === DropdownItem) {
      return React.cloneElement(child as React.ReactElement<DropdownItemProps>, {
        onClick: () => {
          (child.props as DropdownItemProps).onClick?.();
          setOpen(false);
        },
      });
    }
    return child;
  });

  return (
    <div ref={containerRef} style={{ position: "relative", display: "inline-flex" }}>
      {triggerElement}

      {open && (
        <div
          role="menu"
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            [align]: 0,
            minWidth: `${width}px`,
            backgroundColor: COLORS.card,
            border: `1px solid ${COLORS.border}`,
            borderRadius: RADIUS.md,
            boxShadow: "0 4px 12px rgba(0,0,0,0.1)",
            zIndex: Z_INDEX.dropdown,
            padding: "4px",
            animation: "slideIn 100ms ease-out",
          }}
        >
          {wrappedChildren}
        </div>
      )}
    </div>
  );
};

// ─── Dropdown Item ───────────────────────────────────────────────

const DropdownItem: React.FC<DropdownItemProps> = ({
  children,
  icon,
  onClick,
  destructive = false,
  disabled = false,
}) => (
  <button
    role="menuitem"
    onClick={disabled ? undefined : onClick}
    disabled={disabled}
    style={{
      display: "flex",
      alignItems: "center",
      gap: "8px",
      width: "100%",
      padding: "8px 10px",
      borderRadius: RADIUS.sm,
      border: "none",
      backgroundColor: "transparent",
      color: disabled
        ? COLORS.mutedForeground
        : destructive
          ? STATUS_COLORS.error
          : COLORS.foreground,
      fontSize: "0.8125rem",
      fontWeight: 500,
      textAlign: "left",
      cursor: disabled ? "not-allowed" : "pointer",
      opacity: disabled ? 0.5 : 1,
      transition: `background-color ${TRANSITIONS.fast}`,
    }}
    onMouseEnter={(e) => {
      if (!disabled) e.currentTarget.style.backgroundColor = COLORS.secondary;
    }}
    onMouseLeave={(e) => {
      e.currentTarget.style.backgroundColor = "transparent";
    }}
  >
    {icon && <span style={{ flexShrink: 0, display: "flex" }}>{icon}</span>}
    <span style={{ flex: 1 }}>{children}</span>
  </button>
);

// ─── Dropdown Divider ────────────────────────────────────────────

const DropdownDivider: React.FC = () => (
  <div style={{ height: "1px", backgroundColor: COLORS.border, margin: "4px 0" }} />
);

// ─── Attach Sub-components ───────────────────────────────────────

Dropdown.Item = DropdownItem;
Dropdown.Divider = DropdownDivider;

Dropdown.displayName = "Dropdown";
DropdownItem.displayName = "Dropdown.Item";
DropdownDivider.displayName = "Dropdown.Divider";
