// Renderer side of the module registry: which view draws each module's section.
import type { ComponentType } from "react";
import { DesignDocsView } from "../modules/design-docs/view";
import { GameCodeView } from "../modules/game-code/view";
import { ModelsView } from "../modules/3d-models/view";
import { MusicView } from "../modules/music/view";
import { EffectsView } from "../modules/effects/view";
import { ScenesView } from "../modules/scenes/view";
import { ShadersView } from "../modules/shaders/view";
import { SoundsView } from "../modules/sounds/view";
import { VoicesView } from "../modules/voices/view";
import { TexturesView } from "../modules/textures/view";
import { UiView } from "../modules/ui/view";
import { ScenariosView } from "../modules/scenarios/view";
import type { ModuleInfo } from "../shared/modules";

export const MODULE_VIEWS: Record<string, ComponentType<{ module: ModuleInfo }>> = {
	"design-docs": DesignDocsView,
	"game-code": GameCodeView,
	"3d-models": ModelsView,
	music: MusicView,
	scenes: ScenesView,
	effects: EffectsView,
	shaders: ShadersView,
	sounds: SoundsView,
	voices: VoicesView,
	textures: TexturesView,
	ui: UiView,
	scenarios: ScenariosView,
};
