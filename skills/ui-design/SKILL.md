---
name: ui-design
description: Game Studio's UI screens (assets/ui/<name>.json, drawn by the engine) and UI art (assets/ui/art/): the screen format, layout in UI units at any width, bindings and actions, generating and judging frames, buttons and icons, checking with preview_ui, and how game code shows screens and handles their actions. Use whenever making or changing a screen or wiring one into the game.
---
# UI screens

A screen is `assets/ui/<name>.json`; the game shows it with `engine.ui_show("<name>")`. The engine draws shown
screens over the game (bottom to top) and reloads a file when it changes.

```json
{"notes": "The pause menu", "pauses": true, "modal": true, "elements": [
	{"id": "box", "type": "panel", "frame": "ui/art/panel/panel.png", "border": 36, "anchor": "center", "size": [400, 440], "padding": 44, "children": [
		{"id": "title", "type": "text", "text": "Paused", "anchor": "top", "font_size": 40, "color": "#3b2412"},
		{"id": "gold", "type": "text", "text": "Gold: {gold}", "anchor": "top", "offset": [0, 64], "color": "#3b2412"},
		{"id": "menu", "type": "stack", "anchor": "bottom", "size": [280, 220], "gap": 14, "children": [
			{"id": "resume", "type": "button", "text": "Resume", "frame": "ui/art/button/button.png", "border": 28, "size": [280, 64], "color": "#fff3d6", "action": "resume"},
			{"id": "volume", "type": "slider", "text": "Volume", "bind": "volume", "size": [280, 40], "action": "volume"},
			{"id": "quit", "type": "button", "text": "Quit to title", "frame": "ui/art/button/button.png", "border": 28, "size": [280, 64], "color": "#fff3d6", "action": "quit"}
		]}
	]}
]}
```

| Field | |
|---|---|
| `id` | Every element has one, unique in the screen: the studio, tests and actions name it |
| `type` | `panel` (a frame image, or a plain fill `color`), `text`, `image` (fitted, aspect kept), `button`, `slider`, `checkbox`, `bar` (progress of `bind` between `min` and `max`), `stack` (children one after another, `gap` apart, `direction` vertical or horizontal) |
| `anchor`, `offset`, `size` | Where in the parent: `top_left` (default) … `center` … `bottom_right`; `offset` moves it towards the centre; `size` in UI units (0 fills the parent; text sizes itself) |
| `padding` | Between an element's edge and its children (inside a frame: keep children off the border) |
| `text`, `font_size`, `color`, `align` | `{name}` shows a binding. Colours `"#rrggbb"` or `"#rrggbbaa"` |
| `frame`, `border`, `tint` | A 9-slice image (`ui/art/<name>/<name>.png`); `border`: how wide its corners are drawn, in UI units |
| `image` | An icon or picture (`ui/art/icons/coin/coin.png`) |
| `action` | What a button click (or a slider/checkbox change) reports to the game |
| `bind` | The value a slider, checkbox or bar shows and changes |
| `visible` | Shown only while a binding is set (`"has_map"`), or isn't (`"!has_map"`) |
| `pauses`, `modal` (screen) | `pauses` freezes the game while shown (pause menus); `modal` makes screens below inert (menus over the HUD) |

## Layout
- The screen is **720 UI units tall** and as wide as the window allows (1280 at 16:9, 960 at 4:3, 1680 ultrawide).
  Anchor to the edge or centre an element belongs to, never to a fixed x: a HUD in the top-left corner is
  `"anchor": "top_left", "offset": [16, 16]`; a menu is `"center"`; a hint is `"bottom"`.
- Put things that belong together in a panel or stack and lay its children out inside it: moving the panel moves them.
- Sizes that read: body text 22-26, headings 34-44, buttons 56-70 tall, at least 12 units between buttons. HUD text
  must be readable over the busiest part of the scene: put it on a panel.
- Contrast: dark text on parchment or light frames (`#3b2412`), light text on wood or dark frames (`#fff3d6`).

## UI art
- `generate_ui_art` with `kind`: `frame` (a panel's border), `button`, or `icon`. Prompt the subject **and the game's
  style** (from `docs/design/`, passed as `style`): "a carved dark wooden border with small gold rivets, a plain
  parchment inside". The studio adds the framing and a plain background, cuts it out, and makes frames and buttons
  exactly symmetric with their slice insets.
- **Judge the sheet**, which shows each candidate as screens use it: frames stretched to three shapes, buttons as a menu,
  icons at 48 and 96 px. Reject ornaments that smear when stretched, squashed round ends, ragged cut-out edges, and
  icons that don't read at 48 px. Buttons should be pills or rounded rectangles (ovals can't stretch).
- `make_ui_art` with the chosen `source`; check the preview. Correct `slice` if anything that mustn't stretch (a
  rivet, a round end) falls outside the corners.
- One frame and one button style across all screens; icons in the same style.

## Checking
`preview_ui` shows a screen in the game's engine with `values` for its bindings, and returns where every element
landed (`rect` [x, y, w, h] in UI units), the bindings it reads, the actions it reports, bindings you didn't give and
problems in the file. Check with realistic values **and** the extremes (0, 99999, the longest text), and look at the
image every time: overlaps, text spilling out of frames, unreadable colours.

## Wiring it into the game (for the code)
```odin
// init: the title over the scene; the HUD under everything once playing.
engine.ui_show("title")

// update: values every frame (cheap), then actions from the last frame.
engine.ui_set("gold", game.gold)
engine.ui_set("chests_left", chests_left)
for a in engine.ui_actions() {
	switch a.action {
	case "play":   engine.ui_hide("title"); engine.ui_show("hud")
	case "pause":  engine.ui_show("pause")
	case "resume": engine.ui_hide("pause")
	case "volume": engine.set_volume(.Master, a.value)
	case "quit":   engine.ui_clear(); engine.ui_show("title")
	}
}
if input.key_pressed(.ESCAPE) && engine.ui_shown("hud") && !engine.ui_shown("pause") do engine.ui_show("pause")
if engine.ui_blocking() do return // a menu is up: no gameplay input
```
A screen with `pauses: true` freezes the simulation while shown (`update` still runs, so menus work). A scripted test
can click buttons by label (`{"cmd": "ui_click", "label": "Resume"}`), read `ui_tree` and `ui_actions`, and set values
with `ui_set`.
