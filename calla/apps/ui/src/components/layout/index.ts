/**
 * Layout Barrel Export
 * ────────────────────
 * Single import point for the app shell: @/components/layout
 */

export { ConsoleLayout, type ConsoleLayoutProps } from "./ConsoleLayout";
export { Sidebar, type SidebarProps } from "./Sidebar";
export { TopBar, type TopBarProps } from "./TopBar";
export {
  CommandPalette,
  type CommandItem,
  type CommandPaletteProps,
} from "./CommandPalette";
export {
  ConsoleApprovalsProvider,
  ConsoleEventsProvider,
  useConsoleApprovals,
  useConsoleEvents,
} from "./console-context";
