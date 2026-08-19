/**
 * UI Primitives Barrel Export
 * ───────────────────────────
 * Single import point for all UI primitive components.
 *
 * Usage:
 *   import { Button, Badge, Card, MetricCard } from "../components/ui";
 */

export { Button } from "./Button";
export type { ButtonProps } from "./Button";

export { Badge } from "./Badge";
export type { BadgeProps } from "./Badge";

export { Card, MetricCard } from "./Card";
export type { CardProps, CardHeaderProps, MetricCardProps } from "./Card";

export { Input, Textarea } from "./Input";
export type { InputProps, TextareaProps } from "./Input";

export { Tabs } from "./Tabs";
export type { TabsProps, TabItem } from "./Tabs";

export { Table } from "./Table";
export type { TableProps } from "./Table";

export { StatusDot } from "./StatusDot";
export type { StatusDotProps } from "./StatusDot";

export { EnvironmentSwitcher } from "./EnvironmentSwitcher";

export { ThemeToggle } from "./ThemeToggle";

export { Tooltip } from "./Tooltip";
export type { TooltipProps } from "./Tooltip";

export { Modal, ConfirmDialog } from "./Modal";
export type { ModalProps, ConfirmDialogProps } from "./Modal";

export { Dropdown } from "./Dropdown";
export type { DropdownProps, DropdownItemProps } from "./Dropdown";

export { CodeBlock } from "./CodeBlock";
export type { CodeBlockProps } from "./CodeBlock";
