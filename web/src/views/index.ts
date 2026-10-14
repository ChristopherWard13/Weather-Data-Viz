import { jet } from "./jet";
import { temp } from "./temp";
import { wind } from "./wind";
import { precip } from "./precip";
import { h500 } from "./h500";
import { t850 } from "./t850";
import type { VariableDef, ViewDef, ViewId } from "./types";

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
  const ov = new Set(defaultOverlays(v));
  // An item listed once for a view with variables offers them as a Shading
  // choice: a mode requires a field only if every choice shades it (500 mb
  // trend: heights), so a model with heights but no vorticity keeps the item.
  const choices = !variable && v.variables ? v.variables.map((x) => x.id) : [variable];
  const fields = [...new Set(v.modes.flatMap((m) => {
    const shaded = new Set(choices.map((c) => v.fields(m, c, ov).primary));
    return shaded.size === 1 ? [...shaded] : [];
  }))];
  return { id: variable ? `${view}:${variable}` : view, view, variable, label, sub, group, fields, noun, short };
};

/**
 * Fields an overlay adds to what the view loads in this mode: a model without
 * one of them can't draw it (the ECMWF ENS mean has no 250 mb direction, so
 * no flow arrows or barbs).
 */
export function overlayFields(view: ViewDef, mode: "fcst" | "trend", variable: string, overlay: string): string[] {
  const base = view.fields(mode, variable, new Set()).current;
  return view.fields(mode, variable, new Set([overlay])).current.filter((f) => !base.includes(f));
}

/** The Fields sidebar, in order (number keys 1–8 follow it). */
export const FIELD_ITEMS: FieldItem[] = [
  item("t2m", "temp", "Temperature", "2 m", "Surface", "2 m temperature"),
  item("t2m", "dewpt", "Dew point", "2 m", "Surface", "dew point"),
  item("wind10", "speed", "Wind", "10 m sustained", "Surface", "sustained wind"),
  item("wind10", "gust", "Gusts", "surface", "Surface", "gusts", "gust"),
  item("precip", "", "Precipitation", "6 h, totals, snow", "Surface", "precipitation"),
  item("t850", "", "850 mb", "temperature", "Upper air", "850 mb temperature"),
  { ...item("h500", "", "500 mb", "vorticity, heights", "Upper air", "500 mb heights and vorticity", "500 mb"), diffNoun: "500 mb heights" },
  item("jet", "", "250 mb jet", "wind speed", "Upper air", "250 mb wind"),
];

/**
 * The variable a view shades, when it's strict (snowfall): models without its
 * field aren't offered while it's picked, as for a sidebar field of its own.
 */
export function strictVariable(view: ViewId, variable: string): VariableDef | null {
  const v = viewById(view).variables?.find((x) => x.id === variable);
  return v?.strict ? v : null;
}

/** Fields a model must output to show this view and variable: the sidebar item's, and a strict variable's own. */
export function requiredFields(view: ViewId, variable: string): string[] {
  const fields = fieldItem(view, variable).fields;
  const strict = strictVariable(view, variable);
  return strict && !fields.includes(strict.field) ? [...fields, strict.field] : fields;
}

/** What a model without the field lacks, for the banner ("snowfall") and the model bar's note ("no snowfall output"). */
export function missingNoun(view: ViewId, variable: string): { noun: string; short: string } {
  const strict = strictVariable(view, variable);
  if (strict) return { noun: strict.noun ?? strict.label.toLowerCase(), short: strict.noun ?? strict.label.toLowerCase() };
  const it = fieldItem(view, variable);
  return { noun: it.noun, short: it.short };
}

/** The sidebar item for a view and variable. */
export function fieldItem(view: ViewId, variable: string): FieldItem {
  return FIELD_ITEMS.find((i) => i.view === view && (i.variable === variable || !i.variable)) ?? FIELD_ITEMS[FIELD_ITEMS.length - 1];
}
