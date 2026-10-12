import { jet } from "./jet";
import { temp } from "./temp";
import { wind } from "./wind";
import { precip } from "./precip";
import { h500 } from "./h500";
import { t850 } from "./t850";
import type { ViewDef, ViewId } from "./types";

export const VIEWS: ViewDef[] = [jet, temp, wind, precip, h500, t850];
export const VIEW_IDS = VIEWS.map((v) => v.id);

export function viewById(id: string): ViewDef {
  return VIEWS.find((v) => v.id === id) ?? jet;
}

export function defaultOverlays(view: ViewDef): string[] {
  return view.overlays.filter((o) => o.default).map((o) => o.id);
}

export function isViewId(id: string | null): id is ViewId {
  return !!id && (VIEW_IDS as string[]).includes(id);
}

/** Variables of `view` whose field the product has (all of them if it has no variables). */
export function availableVariables(view: ViewDef, fields: Set<string>) {
  return (view.variables ?? []).filter((v) => fields.has(v.field));
}

/** Can the product show this view at all? Its default shading field must exist. */
export function viewAvailable(view: ViewDef, fields: Set<string>): boolean {
  if (view.variables) return availableVariables(view, fields).length > 0;
  return fields.has(view.fields(view.defaultMode, "", new Set(defaultOverlays(view))).primary);
}
