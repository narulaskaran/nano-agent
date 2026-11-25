// Chat callers always speak one canonical tool-capable format; adapters translate
// only at the trusted provider boundary.
const textOf = (content) =>
	typeof content === "string"
		? content
		: (content ?? [])
				.filter((b) => b.type === "text")
				.map((b) => b.text)
				.join("\n");
export function anthropicRequest(input, model) {
	const system = (input.messages ?? [])
		.filter((m) => m.role === "system" || m.role === "developer")
		.map((m) => textOf(m.content))
		.join("\n");
	const messages = [];
	for (const m of input.messages ?? []) {
		if (["system", "developer"].includes(m.role)) continue;
		let content;
		if (m.role === "tool") content = [{ type: "tool_result", tool_use_id: m.tool_call_id, content: textOf(m.content) }];
		else {
			content =
				typeof m.content === "string"
					? [{ type: "text", text: m.content }]
					: (m.content ?? []).map((b) => {
							if (b.type === "text") return { type: "text", text: b.text };
							if (b.type === "image_url") {
								const raw = b.image_url?.url ?? "";
								const match = /^data:([^;]+);base64,(.*)$/.exec(raw);
								return {
									type: "image",
									source: match ? { type: "base64", media_type: match[1], data: match[2] } : { type: "url", url: raw },
								};
							}
							throw new Error("Unsupported Anthropic message content.");
						});
			for (const tool of m.tool_calls ?? []) {
				let args;
				try {
					args = JSON.parse(tool.function.arguments || "{}");
				} catch {
					throw new Error("Invalid tool arguments.");
				}
				content.push({ type: "tool_use", id: tool.id, name: tool.function.name, input: args });
			}
		}
		const role = m.role === "assistant" ? "assistant" : "user";
		if (!content.length) continue;
		if (messages.at(-1)?.role === role) messages.at(-1).content.push(...content);
		else messages.push({ role, content });
	}
	return {
		model,
		max_tokens: input.max_tokens ?? input.max_completion_tokens ?? 4096,
		messages,
		...(system ? { system } : {}),
		...(input.tools?.length
			? {
					tools: input.tools.map((t) => ({
						name: t.function.name,
						description: t.function.description,
						input_schema: t.function.parameters,
					})),
				}
			: {}),
		stream: false,
	};
}
function completion(model, text, tools = [], usage = {}) {
	return {
		id: "nano-" + Date.now(),
		object: "chat.completion",
		created: Math.floor(Date.now() / 1000),
		model,
		choices: [
			{
				index: 0,
				message: { role: "assistant", content: text || "", ...(tools.length ? { tool_calls: tools } : {}) },
				finish_reason: tools.length ? "tool_calls" : "stop",
			},
		],
		usage,
	};
}
export function anthropicResponse(data, model) {
	const text = (data.content ?? [])
		.filter((b) => b.type === "text")
		.map((b) => b.text)
		.join("");
	const tools = (data.content ?? [])
		.filter((b) => b.type === "tool_use")
		.map((b) => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input) } }));
	const result = completion(model, text, tools, {
		prompt_tokens: data.usage?.input_tokens ?? 0,
		completion_tokens: data.usage?.output_tokens ?? 0,
	});
	if (data.stop_reason === "max_tokens") result.choices[0].finish_reason = "length";
	return result;
}
export function completionResponse(value, stream) {
	if (!stream) return { status: 200, contentType: "application/json", body: Buffer.from(JSON.stringify(value)) };
	const choice = value.choices[0];
	const delta = {
		...choice.message,
		...(choice.message.tool_calls ? { tool_calls: choice.message.tool_calls.map((t, index) => ({ ...t, index })) } : {}),
	};
	const base = { id: value.id, object: "chat.completion.chunk", created: value.created, model: value.model };
	const chunks = [
		{ ...base, choices: [{ index: 0, delta, finish_reason: null }] },
		{ ...base, choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason }], usage: value.usage },
	];
	return {
		status: 200,
		contentType: "text/event-stream",
		body: Buffer.from(chunks.map((c) => "data: " + JSON.stringify(c) + "\n\n").join("") + "data: [DONE]\n\n"),
	};
}
