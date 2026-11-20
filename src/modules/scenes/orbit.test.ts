import { describe, expect, it } from "vitest";
import { type Orbit, orbitDrag, orbitPosition, project } from "./orbit";

describe("scene view camera", () => {
	const o: Orbit = { target: [0, 0, 0], yaw: 30, pitch: 40, distance: 10 };
	// A point between the camera and the target, so turning the scene moves it sideways on screen.
	const near = orbitPosition({ ...o, distance: 4 });
	near[1] = 0;

	it("turns the scene with the mouse when dragging sideways", () => {
		const before = project(o, near, 1280, 720)!;
		expect(project(orbitDrag(o, 20, 0), near, 1280, 720)!.x).toBeGreaterThan(before.x);
		expect(project(orbitDrag(o, -20, 0), near, 1280, 720)!.x).toBeLessThan(before.x);
	});
});
