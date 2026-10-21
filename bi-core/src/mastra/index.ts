import { Mastra } from "@mastra/core";
import { crawlerAgent } from "./agents/crawler.js";
import { crawlWorkflow } from "./workflows/crawl.js";

export const mastra = new Mastra({
  agents: {
    crawler: crawlerAgent,
  },
  workflows: {
    crawl: crawlWorkflow,
  },
});

export { crawlerAgent } from "./agents/crawler.js";
export { crawlWorkflow } from "./workflows/crawl.js";
