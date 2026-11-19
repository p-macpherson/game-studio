package game

import "engine:engine"

main :: proc() {
	engine.run({init = init, update = update}, {title = "{{name}}"})
}

cube: engine.Entity

init :: proc() {
	sun := engine.spawn_at("Sun", {}, engine.euler(50, 30, 0))
	engine.add(sun, engine.Light{kind = .Directional, intensity = 1.2, shadows = true})

	cam := engine.spawn_at("Camera", {0, 3, -7})
	engine.add(cam, engine.Camera{})
	engine.look_at(cam, {0, 0.5, 0})

	ground := engine.spawn_at("Ground", {})
	engine.add(ground, engine.Transform{scale = {20, 1, 20}})
	engine.add(ground, engine.Mesh_Renderer{mesh = "plane", material = {color = {0.4, 0.6, 0.4, 1}}})

	cube = engine.spawn_at("Cube", {0, 1, 0})
	engine.add(cube, engine.Mesh_Renderer{mesh = "cube", material = {color = {0.9, 0.3, 0.2, 1}}})
}

update :: proc(dt: f32) {
	// The cube can be destroyed at runtime (by game code, a script or the studio), so check it still exists.
	if t := engine.get(cube, engine.Transform); t != nil do t.rotation *= engine.euler(0, 45 * dt, 0)
}
