// A texture lit on a plane and a sphere (three.js), with its normal and roughness maps, tiled at its size in metres.
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { themeColor } from "../../renderer/appearance";

export function TexturePreview3D({ colour, normal, roughness, tile }: { colour: string; normal: string; roughness: string; tile: number }) {
	const host = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const el = host.current!;
		const renderer = new THREE.WebGLRenderer({ antialias: true });
		renderer.setPixelRatio(window.devicePixelRatio);
		renderer.outputColorSpace = THREE.SRGBColorSpace;
		renderer.toneMapping = THREE.ACESFilmicToneMapping;
		el.appendChild(renderer.domElement);
		const scene = new THREE.Scene();
		scene.background = new THREE.Color(themeColor("sunken") || "#121317");
		const sun = new THREE.DirectionalLight(0xffffff, 2.2);
		sun.position.set(-3, 5, 2);
		scene.add(sun, new THREE.HemisphereLight(0xdde6ff, 0x30302a, 0.7));
		const loader = new THREE.TextureLoader();
		const map = (url: string, repeat: number, srgb = false) => {
			const t = loader.load(url);
			t.wrapS = t.wrapT = THREE.RepeatWrapping;
			t.repeat.set(repeat, repeat);
			if (srgb) t.colorSpace = THREE.SRGBColorSpace;
			t.anisotropy = 8;
			return t;
		};
		const material = (repeat: number) =>
			new THREE.MeshStandardMaterial({ map: map(colour, repeat, true), normalMap: map(normal, repeat), roughnessMap: map(roughness, repeat), metalness: 0 });
		const plane = new THREE.Mesh(new THREE.PlaneGeometry(6, 6), material(6 / tile));
		plane.rotation.x = -Math.PI / 2;
		const sphere = new THREE.Mesh(new THREE.SphereGeometry(0.8, 64, 32), material(Math.max(1, (1.6 * Math.PI) / tile)));
		sphere.position.set(1.2, 0.8, 1.2);
		scene.add(plane, sphere);
		const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 100);
		camera.position.set(-3.2, 2.6, -3.2);
		const controls = new OrbitControls(camera, renderer.domElement);
		controls.target.set(0.4, 0.2, 0.4);
		controls.enableDamping = true;
		const resize = () => {
			renderer.setSize(el.clientWidth, el.clientHeight, false);
			camera.aspect = el.clientWidth / Math.max(el.clientHeight, 1);
			camera.updateProjectionMatrix();
		};
		const observer = new ResizeObserver(resize);
		observer.observe(el);
		resize();
		renderer.setAnimationLoop(() => {
			controls.update();
			renderer.render(scene, camera);
		});
		return () => {
			observer.disconnect();
			renderer.setAnimationLoop(null);
			controls.dispose();
			for (const m of [plane.material, sphere.material]) {
				for (const t of [m.map, m.normalMap, m.roughnessMap]) t?.dispose();
				m.dispose();
			}
			renderer.dispose();
			el.removeChild(renderer.domElement);
		};
	}, [colour, normal, roughness, tile]);
	return <div ref={host} className="texture-3d" data-testid="texture-3d" />;
}
