import { describe, expect, it } from "vitest";
import { type KeyPress, sendsMessage } from "./enter-to-send";

const press = (mods: Partial<KeyPress> = {}): KeyPress => ({ key: "Enter", shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...mods });

describe("sendsMessage", () => {
	it("with Enter to send on: Enter sends, Shift+Enter is a new line, Ctrl+Shift+Enter sends", () => {
		expect(sendsMessage(press(), true)).toBe(true);
		expect(sendsMessage(press({ shiftKey: true }), true)).toBe(false);
		expect(sendsMessage(press({ ctrlKey: true, shiftKey: true }), true)).toBe(true);
		expect(sendsMessage(press({ ctrlKey: true }), true)).toBe(true);
	});

	it("with it off: Enter and Shift+Enter are new lines, Ctrl+Enter and Ctrl+Shift+Enter still send", () => {
		expect(sendsMessage(press(), false)).toBe(false);
		expect(sendsMessage(press({ shiftKey: true }), false)).toBe(false);
		expect(sendsMessage(press({ ctrlKey: true }), false)).toBe(true);
		expect(sendsMessage(press({ ctrlKey: true, shiftKey: true }), false)).toBe(true);
		expect(sendsMessage(press({ metaKey: true }), false)).toBe(true);
	});

	it("never sends on another key, or while an input method is composing", () => {
		expect(sendsMessage(press({ key: "a", ctrlKey: true }), true)).toBe(false);
		expect(sendsMessage(press({ isComposing: true }), true)).toBe(false);
	});
});
