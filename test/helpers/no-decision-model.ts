import { createDecider, type Decider, type Transport } from "../../src/decide.ts";

/**
 * A decision transport that behaves like an unconfigured decision model. Tests that do not script decisions pass it,
 * so a real key in the developer's environment (OPENROUTER_API_KEY, NANO_DECIDE_URL) never turns a test into a network call.
 */
export const noDecisionModel: Transport = async () => {
	throw new Error("no decision model in tests");
};

/** A decider that never calls a real model. Pass a scripted transport to answer decisions. */
export function testDecider(dataDir: string, transport: Transport = noDecisionModel): Decider {
	return createDecider({ dataDir, transport, refusePrivate: true });
}
