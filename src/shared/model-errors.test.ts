import { describe, expect, it } from "vitest";
import { describeModelError, retryLine } from "./model-errors";

describe("describeModelError", () => {
	it("reads an overloaded error out of the provider's JSON as temporary", () => {
		const e = describeModelError('{"type":"error","error":{"details":null,"type":"overloaded_error","message":"Overloaded"},"request_id":"req_011ChKeH4J59tjiUCqGkFBFJ"}');
		expect(e).toMatchObject({ title: "The model's servers are overloaded", temporary: true });
		expect(e.detail).toContain("Nothing in the session is lost");
	});

	it("tells limits, account problems and network failures apart", () => {
		expect(describeModelError('{"error":{"type":"rate_limit_error","message":"slow down"}}')).toMatchObject({ title: "The model's rate limit was reached", temporary: true });
		expect(describeModelError('{"error":{"type":"authentication_error","message":"invalid x-api-key"}}')).toMatchObject({ title: "The model's provider refused the account", temporary: false });
		expect(describeModelError("insufficient_quota: add credit")).toMatchObject({ title: "The account's usage limit was reached", temporary: false });
		expect(describeModelError("fetch failed")).toMatchObject({ title: "The request to the model failed", temporary: true });
		expect(describeModelError("The tool schema is invalid")).toEqual({ title: "The session stopped with an error", detail: "The tool schema is invalid", temporary: false });
	});

	it("counts down to the next try", () => {
		expect(retryLine({ attempt: 2, maxAttempts: 12, delayMs: 8000, startedAt: 1000 }, 1500)).toBe("Trying again in 8 s (attempt 2 of 12)");
		expect(retryLine({ attempt: 2, maxAttempts: 12, delayMs: 8000, startedAt: 1000 }, 9500)).toBe("Trying again… (attempt 2 of 12)");
	});
});
