export interface TourStep {
  id: string;
  target: string;
  title: string;
  caption: string;
  route: string;
}

export const TOUR_STEPS: TourStep[] = [
  {
    id: "data-studio",
    target: "data-studio",
    title: "Data Studio",
    caption: "All your leads in one place. Filter, edit, import/export CSV. This is where data lives.",
    route: "/data-studio",
  },
  {
    id: "pipeline",
    target: "pipeline",
    title: "Pipeline",
    caption: "See the full funnel. Every lead tracked from raw discovery to replied. Cost per lead visible.",
    route: "/pipeline",
  },
  {
    id: "hitl",
    target: "hitl",
    title: "HITL Center",
    caption: "Human approves every email. Review leads, approve reply drafts, confirm flagged websites.",
    route: "/hitl",
  },
  {
    id: "wire",
    target: "wire",
    title: "Agent Wire",
    caption: "One purchase, three agents, one bill. Edge thinks, Core crawls, jev qualifies.",
    route: "/observability",
  },
  {
    id: "cost",
    target: "cost",
    title: "Cost",
    caption: "Full cost transparency. VM-minutes, tokens, est. cost. Budget caps enforced.",
    route: "/pipeline",
  },
];

export function isTourMode(): boolean {
  if (typeof window === "undefined") return false;
  const params = new URLSearchParams(window.location.search);
  return params.get("tour") === "1";
}

export function getTourTargetElement(stepId: string): HTMLElement | null {
  return document.querySelector(`[data-tour="${stepId}"]`);
}
