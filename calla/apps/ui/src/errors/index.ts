/**
 * Errors Barrel Export
 * ────────────────────
 * Single import point for the error layer: @/errors
 */

export { AppError, AppErrors, type AppErrorOptions } from "./AppError";
export {
  errorHandler,
  type ErrorListener,
  type HandleErrorOptions,
} from "./errorHandler";
