// The Scenes editor's camera: an orbit around a target point, sent to the engine as a `camera` override.
// Engine conventions: +Y up, +Z forward, -X right; the override's fov is vertical.

export type Vec3 = [number, number, number];

export interface Orbit {
	target: Vec3;
	/** Degrees around Y; 0 looks along +Z (from behind the target's -Z side). */
	yaw: number;
	/** Degrees above the horizon. */
	pitch: number;
	distance: number;
}

export const FOV = 50;

export function orbitPosition(o: Orbit): Vec3 {
	const y = (o.yaw * Math.PI) / 180;
	const p = (o.pitch * Math.PI) / 180;
	return [o.target[0] - Math.sin(y) * Math.cos(p) * o.distance, o.target[1] + Math.sin(p) * o.distance, o.target[2] - Math.cos(y) * Math.cos(p) * o.distance];
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3): Vec3 => {
	const l = Math.hypot(...a) || 1;
	return [a[0] / l, a[1] / l, a[2] / l];
};

/** The camera's forward, screen-right and screen-up axes. */
export function axes(o: Orbit): { forward: Vec3; right: Vec3; up: Vec3 } {
	const forward = norm(sub(o.target, orbitPosition(o)));
	const right = norm(cross(forward, [0, 1, 0]));
	return { forward, right, up: cross(right, forward) };
}

/** Frame pixel of a world point, or null behind the camera. */
export function project(o: Orbit, p: Vec3, width: number, height: number): { x: number; y: number } | null {
	const { forward, right, up } = axes(o);
	const d = sub(p, orbitPosition(o));
	const z = dot(d, forward);
	if (z <= 0.05) return null;
	const t = Math.tan((FOV * Math.PI) / 360);
	return { x: ((dot(d, right) / (z * t * (width / height)) + 1) / 2) * width, y: ((1 - dot(d, up) / (z * t)) / 2) * height };
}

/** Moves the target in the ground plane by a drag of (dx, dy) frame pixels. */
export function pan(o: Orbit, dx: number, dy: number, height: number): Orbit {
	const { right } = axes(o);
	const flatForward = norm([right[2], 0, -right[0]]);
	const k = (2 * o.distance * Math.tan((FOV * Math.PI) / 360)) / height;
	const t = o.target;
	return { ...o, target: [t[0] - right[0] * dx * k + flatForward[0] * dy * k, t[1], t[2] - right[2] * dx * k + flatForward[2] * dy * k] };
}

/**
 * The camera a scene opens with: prefabs from the front (models face +Z); scenes from the -Z side, like a game's
 * camera usually is, far enough out to see the top-level entities placed away from the origin (huge scaled ones,
 * like the ground, left out).
 */
export function defaultOrbit(entities: Record<string, unknown>[] | undefined, prefab: boolean): Orbit {
	if (prefab) return { target: [0, 0.6, 0], yaw: 160, pitch: 20, distance: 4 };
	const ps = (entities ?? []).flatMap((e) => {
		const t = e.Transform as { position?: number[]; parent?: number; scale?: number[] } | undefined;
		const p = t?.position;
		return Array.isArray(p) && !t?.parent && !t?.scale && (p[0] || p[2]) ? [p] : [];
	});
	const extent = Math.max(6, ...ps.map((p) => Math.hypot(p[0], p[2])));
	return { target: [0, 0, 0], yaw: 0, pitch: 50, distance: extent * 1.5 };
}
