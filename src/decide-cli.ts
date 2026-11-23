import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { buildQuestion, decide, type DecisionRequest, top } from "./decide.ts";

const USAGE = `usage: nano-decide [options] "<question>" [file]
Asks the decision model one question about a file or stdin and prints the answer. Not for private
material: the decision model is not bound to zero data retention.

  (default)                 yes/no question; prints yes or no
  --yes TEXT --no TEXT      optional: what yes and no mean
  --option ID=TEXT          repeatable: pick one of these; prints the chosen ID
  --level TEXT              repeatable: rate on these ordered levels, lowest first; prints the level number (0, 1, ...)
  --min P                   exit 3 instead of answering when the answer's probability is below P
  --json                    print the full answer, with probabilities, as JSON
  --request                 the input is a whole request {"state": ..., "questions": {...}}; print the whole response
  --source NAME             label for the decision log (default: $NANO_DECIDE_SOURCE)

Exit codes: 0 answered, 3 below --min, 2 no decision model configured, 1 error, 64 usage.
Every decision is logged to <data>/decisions.jsonl with its probabilities, never the input text.`;

class Uncertain extends Error {}

async function main(): Promise<number> {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			yes: { type: "string" },
			no: { type: "string" },
			option: { type: "string", multiple: true },
			level: { type: "string", multiple: true },
			min: { type: "string" },
			json: { type: "boolean" },
			request: { type: "boolean" },
			source: { type: "string" },
			help: { type: "boolean", short: "h" },
		},
	});
	if (values.help) {
		console.error(USAGE);
		return 0;
	}
	const [first, second] = positionals;
	const file = values.request ? first : second;
	if (!values.request && !first) {
		console.error(USAGE);
		return 64;
	}
	const input = file ? readFileSync(file, "utf8") : process.stdin.isTTY ? "" : readFileSync(0, "utf8");
	const min = values.min === undefined ? undefined : Number(values.min);
	if (min !== undefined && !(min >= 0 && min <= 1)) throw new Error("--min must be a probability between 0 and 1");

	const request: DecisionRequest = values.request
		? (JSON.parse(input) as DecisionRequest)
		: { state: input, questions: { answer: buildQuestion(first as string, values) } };
	const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const logPath = join(resolve(process.env.NANO_DATA_DIR ?? join(appDir, "data")), "decisions.jsonl");
	const source = values.source ?? (process.env.NANO_DECIDE_SOURCE || undefined);
	const response = await decide(request, { logPath, source }).catch((error: Error) => {
		if (/no decision model is configured/.test(error.message)) {
			console.error(`nano-decide: ${error.message}`);
			process.exit(2);
		}
		throw error;
	});

	if (values.request) {
		process.stdout.write(`${JSON.stringify(response)}\n`);
		return 0;
	}
	const answer = response.answers.answer as NonNullable<(typeof response.answers)[string]>;
	const best = top(answer);
	if (values.json) process.stdout.write(`${JSON.stringify({ ...best, answer, model: response.model })}\n`);
	if (min !== undefined && best.p < min) throw new Uncertain(`uncertain: ${best.label} at ${best.p.toFixed(2)}, below ${min}`);
	if (!values.json) process.stdout.write(`${best.label}\n`);
	return 0;
}

main().then(
	(code) => process.exit(code),
	(error) => {
		console.error(`nano-decide: ${(error as Error)?.message ?? error}`);
		process.exit(error instanceof Uncertain ? 3 : 1);
	},
);
