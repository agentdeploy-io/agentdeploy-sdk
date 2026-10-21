/**
 * Chat Components Barrel Export
 * ─────────────────────────────
 * Single import point for the agent chat surface: @/components/chat
 */

export { MessageBubble, type MessageBubbleProps } from "./MessageBubble";
export { MessageList, type MessageListProps } from "./MessageList";
export { ChatInput, type ChatInputProps } from "./ChatInput";
export {
  SlashCommandMenu,
  type SlashCommandMenuProps,
} from "./SlashCommandMenu";
export {
  ConnectionBanner,
  type ConnectionBannerProps,
} from "./ConnectionBanner";
export {
  ToolCallIndicator,
  type ToolCallIndicatorProps,
  type ToolCallInfo,
} from "./ToolCallIndicator";
export { BrainChat, type BrainChatProps } from "./BrainChat";
