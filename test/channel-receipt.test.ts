import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { sendTextWithReceipt, SendOutcomeUnknownError, createStdinChannel } from "../src/channel.ts";

const destination = { requestedSpaceId: "fixture-owner", providerSpaceId: "fixture-conversation" };
const accepted = () => Promise.resolve({ id: "fixture-message", space: { id: destination.providerSpaceId } });

test("a receipt binds provider ID, resolved destination and exact UTF-8 input", async () => {
	const body = "Fixture alert 👍\nhttps://example.com/item";
	let calls = 0;
	const receipt = await sendTextWithReceipt(destination, body, async () => { calls++; return accepted(); }, () => new Date("2026-01-01T00:00:00Z"));
	assert.equal(calls, 1);
	assert.deepEqual(receipt, { channel: "photon", boundary: "provider-accepted", messageId: "fixture-message",
		...destination, textSha256: createHash("sha256").update(body).digest("hex"), acceptedAt: "2026-01-01T00:00:00.000Z" });
	assert.ok(!JSON.stringify(receipt).includes(body));
});

test("missing IDs and wrong destinations stay unknown and never trigger a retry", async () => {
	for (const response of [undefined, {}, { id: "" }, { id: "  " }, { id: 1 }, { id: "fixture-message" },
		{ id: "fixture-message", space: { id: "other-conversation" } }]) {
		let calls = 0;
		await assert.rejects(sendTextWithReceipt(destination, "Fixture", async () => { calls++; return response; }), SendOutcomeUnknownError);
		assert.equal(calls, 1);
	}
});

test("a transport timeout remains ambiguous even if the provider accepted before disconnect", async () => {
	let acceptedCount = 0;
	const error = new Error("fixture connection closed after acceptance");
	await assert.rejects(sendTextWithReceipt(destination, "Fixture", async () => { acceptedCount++; throw error; }),
		(value: unknown) => value instanceof SendOutcomeUnknownError && value.cause === error && value.outcome === "unknown");
	assert.equal(acceptedCount, 1);
});

test("invalid input fails before the provider is called", async () => {
	let calls = 0;
	for (const input of ["", "  "]) await assert.rejects(sendTextWithReceipt(destination, input, async () => { calls++; return accepted(); }));
	await assert.rejects(sendTextWithReceipt({ ...destination, providerSpaceId: "" }, "Fixture", async () => { calls++; return accepted(); }));
	await assert.rejects(sendTextWithReceipt({ ...destination, requestedSpaceId: "" }, "Fixture", async () => { calls++; return accepted(); }));
	assert.equal(calls, 0);
});

test("a local metadata failure after acceptance cannot be treated as a safe resend", async () => {
	let calls = 0;
	await assert.rejects(sendTextWithReceipt(destination, "Fixture", async () => { calls++; return accepted(); }, () => new Date("invalid")), SendOutcomeUnknownError);
	assert.equal(calls, 1);
});

test("stdin cannot fabricate a provider acceptance receipt", () => {
	assert.equal(createStdinChannel().sendWithReceipt, undefined);
});


test("caller mutation during a send cannot rebind its receipt", async () => {
	const input = { ...destination };
	const receipt = await sendTextWithReceipt(input, "Fixture", async () => {
		input.requestedSpaceId = "other-owner";
		input.providerSpaceId = "other-conversation";
		return accepted();
	});
	assert.equal(receipt.requestedSpaceId, destination.requestedSpaceId);
	assert.equal(receipt.providerSpaceId, destination.providerSpaceId);
});
