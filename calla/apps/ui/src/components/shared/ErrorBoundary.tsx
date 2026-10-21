/**
 * ErrorBoundary Component
 * ───────────────────────
 * Catches render errors in child components and displays a fallback UI.
 * This is the safety net — no uncaught render error should ever crash
 * the entire application.
 *
 * Tailwind rewrite of the playground shared/ErrorBoundary — same logic:
 *   - getDerivedStateFromError wraps into AppError(COMPONENT_RENDER_ERROR)
 *   - componentDidCatch reports through the centralized errorHandler
 *   - resetKeys change (or manual reset) clears the boundary
 *
 * Usage:
 *   <ErrorBoundary fallback={MyFallback}>
 *     <RiskyComponent />
 *   </ErrorBoundary>
 */

import React from "react";
import { AlertTriangle } from "lucide-react";
import { errorHandler } from "@/errors/errorHandler";
import { AppError } from "@/errors/AppError";
import { ErrorCode } from "@/constants/errors";
import { Button } from "@/components/ui";

// ─── Props ───────────────────────────────────────────────────────

export interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** Custom fallback UI */
  fallback?: React.ComponentType<{ error: AppError; reset: () => void }>;
  /** Called when an error is caught */
  onError?: (error: AppError) => void;
  /** Reset keys — when these change, the boundary resets */
  resetKeys?: unknown[];
}

interface ErrorBoundaryState {
  error: AppError | null;
}

// ─── Default Fallback ────────────────────────────────────────────

const DefaultFallback: React.FC<{ error: AppError; reset: () => void }> = ({ error, reset }) => (
  <div className="flex min-h-[200px] flex-col items-center justify-center gap-4 px-6 py-12 text-center">
    <div className="flex size-12 items-center justify-center rounded-full bg-destructive/15">
      <AlertTriangle className="size-6 text-destructive" />
    </div>
    <div>
      <h3 className="mb-1 text-base font-semibold text-foreground">Something went wrong</h3>
      <p className="max-w-[400px] text-[0.8125rem] text-muted-foreground">{error.message}</p>
    </div>
    <div className="flex gap-2">
      <Button size="sm" onClick={reset}>
        Try Again
      </Button>
      <Button variant="ghost" size="sm" onClick={() => window.location.reload()}>
        Reload Page
      </Button>
    </div>
  </div>
);

// ─── ErrorBoundary Class Component ───────────────────────────────

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error: AppError.fromCaught(error, ErrorCode.COMPONENT_RENDER_ERROR) };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    const appError = AppError.fromCaught(error, ErrorCode.COMPONENT_RENDER_ERROR);
    appError.context.reactInfo = errorInfo.componentStack;
    this.props.onError?.(appError);
    errorHandler.handleError(appError, { showToast: true });
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps) {
    // Reset on resetKeys change
    if (this.state.error && prevProps.resetKeys !== this.props.resetKeys) {
      this.setState({ error: null });
    }
  }

  reset = () => {
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      const Fallback = this.props.fallback ?? DefaultFallback;
      return <Fallback error={this.state.error} reset={this.reset} />;
    }

    return this.props.children;
  }
}
