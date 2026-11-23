import type { Transport } from "../../src/decide.ts";

/**
 * A decision model that is always down. Tests that do not script decisions pass it, so a real key in the
 * developer's environment (OPENROUTER_API_KEY, NANO_DECIDE_URL) never turns a test into a network call.
 */
export const noDecisionModel: Transport = async () => ({ status: 503, text: "no decision model in tests" });
