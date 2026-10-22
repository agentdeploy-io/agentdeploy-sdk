/** Legacy dev entry retained for existing Calla launcher commands.
 * BI Edge now has its own Worker-only entrypoint and native SQLite adapter.
 * Do not monkey-patch transactions into passthroughs or rewrite SQL globally.
 */
export { default, BiEdgeAgent, Supervisor } from '../../bi-edge/src/worker.js';
