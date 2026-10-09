import { jet } from "./jet";
import { temp } from "./temp";
import { wind } from "./wind";
import { precip } from "./precip";
import type { ViewDef, ViewId } from "./types";

export const VIEWS: ViewDef[] = [jet, temp, wind, precip];
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
