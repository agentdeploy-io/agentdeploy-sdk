/**
 * ErrorBoundary Component
 * ───────────────────────
 * Catches render errors in child components and displays a fallback UI.
 * This is the safety net — no uncaught render error should ever crash
 * the entire application.
 *
 * Usage:
 *   <ErrorBoundary fallback={<MyFallback />}>
 *     <RiskyComponent />
 *   </ErrorBoundary>
 */

import React from "react";
import { errorHandler } from "../../errors/errorHandler";
import { AppError } from "../../errors/AppError";
import { ErrorCode } from "../../constants/errors";
import { COLORS } from "../../constants/theme";
import { Button } from "../ui/Button";

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
  <div
    style={{
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      padding: "48px 24px",
      minHeight: "200px",
      gap: "16px",
      textAlign: "center",
    }}
  >
    <div
      style={{
        width: "48px",
        height: "48px",
        borderRadius: "50%",
        backgroundColor: "var(--color-error-bg)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: "1.5rem",
      }}
    >
      ⚠️
    </div>
    <div>
      <h3 style={{ fontSize: "1rem", fontWeight: 600, color: COLORS.foreground, marginBottom: "4px" }}>
        Something went wrong
      </h3>
      <p style={{ fontSize: "0.8125rem", color: COLORS.mutedForeground, maxWidth: "400px" }}>
        {error.message}
      </p>
    </div>
    <div style={{ display: "flex", gap: "8px" }}>
      <Button variant="primary" size="sm" onClick={reset}>
        Try Again
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => window.location.reload()}
      >
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
