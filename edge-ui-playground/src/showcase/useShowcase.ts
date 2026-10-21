import { useState, useEffect, useCallback, useRef } from "react";
import { TOUR_STEPS, isTourMode } from "./tour";
import { generateSeedData, type SeedDataset } from "./seed-data";

export function useShowcase() {
  const [tourActive, setTourActive] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [seedData, setSeedData] = useState<SeedDataset | null>(null);
  const navigatedRef = useRef<Set<number>>(new Set());

  useEffect(() => {
    if (isTourMode()) {
      setTourActive(true);
      setSeedData(generateSeedData());
    }
  }, []);

  const navigateToStep = useCallback((index: number) => {
    const step = TOUR_STEPS[index];
    if (!step) return;
    if (!navigatedRef.current.has(index)) {
      navigatedRef.current.add(index);
      window.history.pushState({}, "", step.route + "?tour=1");
      window.dispatchEvent(new PopStateEvent("popstate"));
    }
  }, []);

  const handleNext = useCallback(() => {
    if (stepIndex < TOUR_STEPS.length - 1) {
      const nextIdx = stepIndex + 1;
      setStepIndex(nextIdx);
      navigateToStep(nextIdx);
    } else {
      setTourActive(false);
      window.history.pushState({}, "", window.location.pathname.replace("?tour=1", "").replace("?tour=1", ""));
    }
  }, [stepIndex, navigateToStep]);

  const handlePrev = useCallback(() => {
    if (stepIndex > 0) {
      const prevIdx = stepIndex - 1;
      setStepIndex(prevIdx);
      navigateToStep(prevIdx);
    }
  }, [stepIndex, navigateToStep]);

  const handleSkip = useCallback(() => {
    setTourActive(false);
    const url = new URL(window.location.href);
    url.searchParams.delete("tour");
    window.history.pushState({}, "", url.pathname + url.search);
  }, []);

  useEffect(() => {
    if (tourActive) {
      const timer = setTimeout(() => navigateToStep(0), 500);
      return () => clearTimeout(timer);
    }
  }, [tourActive, navigateToStep]);

  return {
    tourActive,
    stepIndex,
    totalSteps: TOUR_STEPS.length,
    seedData,
    onNext: handleNext,
    onPrev: handlePrev,
    onSkip: handleSkip,
  };
}
