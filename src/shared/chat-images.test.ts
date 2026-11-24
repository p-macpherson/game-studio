import { describe, expect, it } from "vitest";
import { chatImagePath } from "./chat-images";

describe("chatImagePath", () => {
	const root = "/home/pat/wt/abc";
	it("takes repo paths as they are", () => {
		expect(chatImagePath("assets/ui/logo.png", root)).toBe("assets/ui/logo.png");
		expect(chatImagePath("./assets/ui/logo.png", root)).toBe("assets/ui/logo.png");
	});
	it("makes absolute paths in the worktree relative", () => {
		expect(chatImagePath("/home/pat/wt/abc/build/review/shot.png", root)).toBe("build/review/shot.png");
		expect(chatImagePath("file:///home/pat/wt/abc/a.png", root + "/")).toBe("a.png");
	});
	it("refuses paths outside the checkout", () => {
		expect(chatImagePath("/home/pat/wt/abcd/a.png", root)).toBeNull();
		expect(chatImagePath("/tmp/a.png", root)).toBeNull();
		expect(chatImagePath("../other/a.png", root)).toBeNull();
	});
});
