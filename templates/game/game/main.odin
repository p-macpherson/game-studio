package game

import "engine:engine"

main :: proc() {
	engine.run({init = init, update = update}, {title = "{{name}}", scene = "scenes/main.json"})
}

cube: engine.Entity

init :: proc() {
	// The world is in assets/scenes/main.json (edit it in the Scenes section); code finds what it drives by name.
	cube = engine.find("Cube")
}

update :: proc(dt: f32) {
	// The cube can be destroyed at runtime (by game code, a script or the studio), so check it still exists.
	if t := engine.get(cube, engine.Transform); t != nil do t.rotation *= engine.euler(0, 45 * dt, 0)
}
