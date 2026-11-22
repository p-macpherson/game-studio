import { describe, expect, it } from "vitest";
import { splitAttachments, withAttachments } from "./attachments";

describe("attachments", () => {
	it("names the saved images after the person's words, and splits them apart again", () => {
		const paths = [".studio/attachments/s1/a-1.png", ".studio/attachments/s1/a-2.jpg"];
		const sent = withAttachments("make it look like this", paths);
		expect(sent.startsWith("make it look like this\n\n<attached-images>")).toBe(true);
		expect(splitAttachments(sent)).toEqual({ text: "make it look like this", paths });
	});

	it("leaves a message without images alone, and carries images with no words", () => {
		expect(withAttachments("hello", [])).toBe("hello");
		expect(splitAttachments("hello <b>there</b>")).toEqual({ text: "hello <b>there</b>", paths: [] });
		expect(splitAttachments(withAttachments("  ", [".studio/attachments/s1/a-1.png"]))).toEqual({ text: "", paths: [".studio/attachments/s1/a-1.png"] });
	});
});
