import type { BudgetFence } from "./types.js";

class BudgetFenceImpl implements BudgetFence {
  private tokensUsed = 0;
  private vmMinutesUsed = 0;
  private maxTokens: number;
  private maxVmHours: number;
  private warningCallbacks: Array<() => void> = [];
  private exhaustedCallbacks: Array<() => void> = [];
  private warningFired = false;
  private exhaustedFired = false;
  private bootTime: number;

  constructor(maxTokensPerDay: number, maxVmHoursPerDay: number) {
    this.maxTokens = maxTokensPerDay;
    this.maxVmHours = maxVmHoursPerDay;
    this.bootTime = Date.now();
  }

  tokensRemaining(): number {
    return Math.max(0, this.maxTokens - this.tokensUsed);
  }

  vmMinutesRemaining(): number {
    const maxMinutes = this.maxVmHours * 60;
    return Math.max(0, maxMinutes - this.vmMinutesUsed);
  }

  percentUsed(): number {
    const tokenPct = this.maxTokens > 0 ? (this.tokensUsed / this.maxTokens) * 100 : 0;
    const vmPct = this.maxVmHours > 0 ? (this.vmMinutesUsed / (this.maxVmHours * 60)) * 100 : 0;
    return Math.max(tokenPct, vmPct);
  }

  onWarning(callback: () => void): void {
    this.warningCallbacks.push(callback);
  }

  onExhausted(callback: () => void): void {
    this.exhaustedCallbacks.push(callback);
  }

  reportTokenUsage(tokens: number): void {
    this.tokensUsed += tokens;
    this.checkThresholds();
  }

  tickVmMinutes(): void {
    const elapsed = (Date.now() - this.bootTime) / 60_000;
    this.vmMinutesUsed = elapsed;
    this.bootTime = Date.now();
    this.checkThresholds();
  }

  private checkThresholds(): void {
    const pct = this.percentUsed();
    if (pct >= 90 && !this.warningFired) {
      this.warningFired = true;
      for (const cb of this.warningCallbacks) {
        try { cb(); } catch (e) { console.error("[budget-fence] warning callback error:", e); }
      }
    }
    if (pct >= 100 && !this.exhaustedFired) {
      this.exhaustedFired = true;
      for (const cb of this.exhaustedCallbacks) {
        try { cb(); } catch (e) { console.error("[budget-fence] exhausted callback error:", e); }
      }
    }
  }
}

export function createBudgetFence(maxTokensPerDay: number, maxVmHoursPerDay: number): BudgetFenceImpl {
  const fence = new BudgetFenceImpl(maxTokensPerDay, maxVmHoursPerDay);

  setInterval(() => {
    fence.tickVmMinutes();
  }, 60_000).unref();

  return fence;
}
