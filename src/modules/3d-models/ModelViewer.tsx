// Interactive glTF viewer (three.js): orbit, studio lighting, a metre grid, wireframe and skeleton overlays,
// a 1.75 m person for scale, and animation clip playback.
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { themeColor } from "../../renderer/appearance";

/** The viewer's backdrop from the theme: the sunken background, a grid in its border colours, the accent for scale. */
const themed = () => ({ bg: themeColor("sunken") || "#121317", line: themeColor("border") || "#2e333b", accent: themeColor("accent") || "#6aa6ff" });
const themedGrid = (c: ReturnType<typeof themed>) => new THREE.GridHelper(20, 20, new THREE.Color(c.line).offsetHSL(0, 0, 0.08), new THREE.Color(c.line));

export interface ViewerOptions {
	wireframe: boolean;
	skeleton: boolean;
	scaleReference: boolean;
	/** Animation clip to play, or null for the rest pose. */
	clip: string | null;
}

interface Scene {
	renderer: THREE.WebGLRenderer;
	scene: THREE.Scene;
	camera: THREE.PerspectiveCamera;
	controls: OrbitControls;
	model?: THREE.Object3D;
	skeleton?: THREE.SkeletonHelper;
	person: THREE.Object3D;
	mixer?: THREE.AnimationMixer;
	clips: THREE.AnimationClip[];
}

function personSilhouette(): THREE.Object3D {
	const material = new THREE.MeshStandardMaterial({ color: new THREE.Color(themed().accent), transparent: true, opacity: 0.35, roughness: 0.9 });
	const person = new THREE.Group();
	const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 1.05, 6, 16), material);
	body.position.y = 0.2 + 1.05 / 2 + 0.03;
	const head = new THREE.Mesh(new THREE.SphereGeometry(0.12, 16, 12), material);
	head.position.y = 1.75 - 0.12;
	person.add(body, head);
	person.name = "scale-reference";
	return person;
}

export function ModelViewer({ url, options, onLoaded }: { url: string; options: ViewerOptions; onLoaded?(info: { clips: string[]; error?: string }): void }) {
	const host = useRef<HTMLDivElement>(null);
	const state = useRef<Scene | null>(null);
	const [loading, setLoading] = useState(true);

	// Renderer, scene and render loop: created once.
	useEffect(() => {
		const el = host.current!;
		const renderer = new THREE.WebGLRenderer({ antialias: true });
		renderer.setPixelRatio(window.devicePixelRatio);
		renderer.outputColorSpace = THREE.SRGBColorSpace;
		renderer.toneMapping = THREE.ACESFilmicToneMapping;
		el.appendChild(renderer.domElement);
		const scene = new THREE.Scene();
		let colors = themed();
		scene.background = new THREE.Color(colors.bg);
		const pmrem = new THREE.PMREMGenerator(renderer);
		scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
		const sun = new THREE.DirectionalLight(0xffffff, 1.6);
		sun.position.set(3, 6, 4);
		scene.add(sun, new THREE.HemisphereLight(0xdde6ff, 0x30302a, 0.6));
		let grid = themedGrid(colors);
		scene.add(grid);
		const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 200);
		const controls = new OrbitControls(camera, renderer.domElement);
		controls.enableDamping = true;
		const person = personSilhouette();
		scene.add(person);
		const s: Scene = { renderer, scene, camera, controls, person, clips: [] };
		state.current = s;
		// A theme change recolours the backdrop, the grid and the scale figure.
		const retheme = () => {
			colors = themed();
			scene.background = new THREE.Color(colors.bg);
			scene.remove(grid);
			grid.dispose();
			grid = themedGrid(colors);
			scene.add(grid);
			person.traverse((o) => o instanceof THREE.Mesh && (o.material as THREE.MeshStandardMaterial).color.set(colors.accent));
		};
		window.addEventListener("studio-appearance", retheme);

		const resize = () => {
			const { clientWidth: w, clientHeight: h } = el;
			renderer.setSize(w, h, false);
			camera.aspect = w / Math.max(h, 1);
			camera.updateProjectionMatrix();
		};
		const observer = new ResizeObserver(resize);
		observer.observe(el);
		resize();
		const clock = new THREE.Clock();
		renderer.setAnimationLoop(() => {
			s.mixer?.update(clock.getDelta());
			controls.update();
			renderer.render(scene, camera);
		});
		return () => {
			window.removeEventListener("studio-appearance", retheme);
			observer.disconnect();
			renderer.setAnimationLoop(null);
			controls.dispose();
			pmrem.dispose();
			renderer.dispose();
			el.removeChild(renderer.domElement);
			state.current = null;
		};
	}, []);

	// The model: reloaded when the URL changes.
	useEffect(() => {
		const s = state.current!;
		let cancelled = false;
		setLoading(true);
		new GLTFLoader().load(
			url,
			(gltf) => {
				if (cancelled) return;
				if (s.model) s.scene.remove(s.model);
				if (s.skeleton) s.scene.remove(s.skeleton);
				const model = gltf.scene;
				s.model = model;
				s.scene.add(model);
				s.skeleton = new THREE.SkeletonHelper(model);
				s.scene.add(s.skeleton);
				s.mixer = new THREE.AnimationMixer(model);
				s.clips = gltf.animations;
				// Frame it: orbit around its middle, from the front (+Z) and a little above.
				const box = new THREE.Box3().setFromObject(model);
				const size = box.getSize(new THREE.Vector3());
				const centre = box.getCenter(new THREE.Vector3());
				// Fit the bounding sphere (model and the scale person) in the narrower of the two fields of view.
				s.person.position.set(box.min.x - 0.6, 0, 0);
				const framed = box.clone().union(new THREE.Box3(new THREE.Vector3(box.min.x - 0.85, 0, -0.25), new THREE.Vector3(box.min.x - 0.35, 1.75, 0.25)));
				framed.getCenter(centre);
				const radius = Math.max(framed.getSize(new THREE.Vector3()).length() / 2, 0.3);
				const vFov = (s.camera.fov * Math.PI) / 180;
				const hFov = 2 * Math.atan(Math.tan(vFov / 2) * s.camera.aspect);
				const distance = (radius / Math.sin(Math.min(vFov, hFov) / 2)) * 1.15;
				s.controls.target.copy(centre);
				s.camera.position.copy(centre).add(new THREE.Vector3(0.45, 0.35, 1).normalize().multiplyScalar(distance));
				s.camera.near = distance / 100;
				s.camera.far = distance * 100;
				s.camera.updateProjectionMatrix();
				setLoading(false);
				onLoaded?.({ clips: gltf.animations.map((c) => c.name) });
			},
			undefined,
			(err) => {
				if (cancelled) return;
				setLoading(false);
				onLoaded?.({ clips: [], error: err instanceof Error ? err.message : String(err) });
			},
		);
		return () => {
			cancelled = true;
		};
	}, [url, onLoaded]);

	// Display options.
	useEffect(() => {
		const s = state.current;
		if (!s?.model) return;
		s.model.traverse((o) => {
			const mesh = o as THREE.Mesh;
			if (!mesh.isMesh) return;
			for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) (m as THREE.MeshStandardMaterial).wireframe = options.wireframe;
		});
		if (s.skeleton) s.skeleton.visible = options.skeleton;
		s.person.visible = options.scaleReference;
		s.mixer?.stopAllAction();
		const clip = s.clips.find((c) => c.name === options.clip);
		if (clip) s.mixer?.clipAction(clip).play();
	}, [options, loading]);

	return (
		<div className="model-viewer" ref={host} data-testid="model-viewer" data-loaded={!loading}>
			{loading && <div className="viewer-loading">Loading model…</div>}
		</div>
	);
}
