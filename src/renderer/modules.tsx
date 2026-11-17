// Renderer side of the module registry: which view draws each module's section.
import type { ComponentType } from "react";
import { DesignDocsView } from "../modules/design-docs/view";
import type { ModuleInfo } from "../shared/modules";

export const MODULE_VIEWS: Record<string, ComponentType<{ module: ModuleInfo }>> = {
	"design-docs": DesignDocsView,
};
