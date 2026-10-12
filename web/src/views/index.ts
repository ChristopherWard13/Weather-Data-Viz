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

/**
 * One entry in the Fields sidebar: a view, plus a variable for views that
 * have several. The sidebar lists every item for every model; the model bar
 * narrows to the models that output `fields`.
 */
export interface FieldItem {
  id: string;
  view: ViewId;
  variable: string;
  label: string;
  sub: string;
  group: "Surface" | "Upper air";
  /** Fields a model must output to offer this item: what the view shades in each mode. */
  fields: string[];
  /** For the banner: "AIFS doesn't output gusts". */
  noun: string;
  /** For the model bar's note: "no gust output". */
  short: string;
  /** What a difference map subtracts, when it isn't all of `noun` (500 mb differences heights only). */
  diffNoun?: string;
}

const item = (
  view: ViewId, variable: string, label: string, sub: string, group: FieldItem["group"], noun: string, short = noun,
): FieldItem => {
  const v = viewById(view);
  const fields = [...new Set(v.modes.map((m) => v.fields(m, variable, new Set(defaultOverlays(v))).primary))];
  return { id: variable ? `${view}:${variable}` : view, view, variable, label, sub, group, fields, noun, short };
};

/** The Fields sidebar, in order (number keys 1–8 follow it). */
export const FIELD_ITEMS: FieldItem[] = [
  item("t2m", "temp", "Temperature", "2 m", "Surface", "2 m temperature"),
  item("t2m", "dewpt", "Dew point", "2 m", "Surface", "dew point"),
  item("wind10", "speed", "Wind", "10 m sustained", "Surface", "sustained wind"),
  item("wind10", "gust", "Gusts", "surface", "Surface", "gusts", "gust"),
  item("precip", "", "Precipitation", "6 h, by type", "Surface", "precipitation"),
  item("t850", "", "850 mb", "temperature", "Upper air", "850 mb temperature"),
  { ...item("h500", "", "500 mb", "vorticity, heights", "Upper air", "500 mb heights and vorticity", "500 mb"), diffNoun: "500 mb heights" },
  item("jet", "", "250 mb jet", "wind speed", "Upper air", "250 mb wind"),
];

/** The sidebar item for a view and variable. */
export function fieldItem(view: ViewId, variable: string): FieldItem {
  return FIELD_ITEMS.find((i) => i.view === view && (i.variable === variable || !i.variable)) ?? FIELD_ITEMS[FIELD_ITEMS.length - 1];
}
