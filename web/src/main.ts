import "./styles.css";
import {
  config, DEFAULT_PRODUCT, gridCovers, productById, regionById, regionDepth,
  type ProductConfig, type RegionConfig,
} from "./config";
import { loadManifest, productBase } from "./manifest";
import { FrameCache, frameEvents, FrameUnavailable } from "./frames";
import { frameQueue } from "./fetchqueue";
import { chipRun } from "./freshness";
import { pairFor, type FramePair } from "./alignment";
import {
  cycleLabel, hasHour, hoursFor, hoursOf, loadFields, planFrame, totalsGap, viewModeOf,
  type FramePlan, type Product, type Source, type TotalGap,
} from "./sources";
import { PERIODS, type Window } from "./accum";
import { MapView } from "./mapview";
import { regionAt, stateAt } from "./basemap";
import { renderColorbar } from "./colorbar";
import {
  FIRST_VISIT, parseState, rememberable, serializeState, viewDefaults, type ViewPrefs, type ViewState,
} from "./state";
import {
  addHours, dayLabel, fhrLabel, fmtDay, fmtLocal, fmtStamp, fmtTime, fmtValid, fmtZ, parseRunId, runId, ZONES, zoneById, type Zone,
} from "./time";
import { axisOf, clip, coverage, dayTicks, daysWindow, hoursBetween, type Axis, type Span } from "./timeaxis";
import { FPS_OPTIONS, loadPrefs, savePrefs, type DisplayPrefs } from "./prefs";
import { parsePresent, Presentation, type SavedLayout } from "./present";
import { fieldName } from "./slot";
import { fmtLatLon, trendLimits } from "./views/util";
import { FIELD_ITEMS, fieldItem, missingNoun, overlayFields, requiredFields, strictVariable, viewById, type FieldItem } from "./views";
import type { Mode, Row, Scene, Sides, ViewDef, ViewId, ViewInputs } from "./views/types";
import type { Bands, Manifest } from "./types";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

declare global {
  interface Window {
    __wxtrend?: {
      renders: number;
      last?: Record<string, unknown>;
      /** Page position of a lon/lat on the (first) map, for the browser tests. */
      toScreen?: (lon: number, lat: number) => { x: number; y: number } | null;
      /** Presentation mode's frame rendered offscreen at `k` (as a PNG export would be), for the browser tests. */
      presentFrame?: (k: number, outWidth?: number) => Promise<{ width: number; height: number; png: string }>;
    };
  }
}

interface Notice {
  text: string;
  /** "run": stays until the run changes; "any": cleared by the next change. */
  clearOn: "run" | "any";
  action?: { label: string; onClick: () => void };
}

type FrameState = "delta" | "forecast" | "no-comparison" | "no-frame";

interface Rendered {
  view: ViewDef;
  mode: Mode;
  cur: Record<string, Bands | null>;
  old: Record<string, Bands | null>;
  sides: Sides;
  frame: FrameState;
  /** Memo key prefix: both sources, so a key never leaks across frames or products. */
  prefix: string;
  pair: FramePair;
  /** The drawn product's model outputs precipitation type. */
  precipType: boolean;
  /** The window `cur` and `old` were totalled over, or null for single frames. */
  acc: Window | null;
}

/** One map on screen: canvas, tooltip and what was last drawn on it. */
class Panel {
  map: MapView;
  scene: Scene | null = null;
  rendered: Rendered | null = null;
  pointer: { clientX: number; clientY: number } | null = null;
  grid: Manifest["grid"];

  constructor(public wrap: HTMLElement, private canvas: HTMLCanvasElement, public tooltip: HTMLElement, grid: Manifest["grid"]) {
    this.grid = grid;
    this.map = new MapView(wrap, canvas, grid);
  }

  /** Use another display grid (a new map; the old one's canvases go). */
  setGrid(grid: Manifest["grid"]): void {
    if (grid.id === this.grid.id) return;
    this.map.dispose();
    const labels = this.map.labelsOn;
    this.grid = grid;
    this.map = new MapView(this.wrap, this.canvas, grid);
    this.map.setLabels(labels);
  }
}

function productUrl(id: string): string {
  return productBase(import.meta.env.VITE_DATA_BASE, id, document.baseURI);
}

/**
 * Decoded frames each model keeps (a field's frame is about 425 KB decoded).
 * Phones keep fewer: enough for a whole run of a trend view's main field.
 */
const FRAME_CAPACITY = window.matchMedia("(pointer: coarse)").matches ? 160 : 400;

async function loadProduct(cfg: ProductConfig): Promise<Product> {
  const manifest = await loadManifest(productUrl(cfg.id));
  if (!manifest.latest || manifest.runs.length === 0) throw new Error("no processed runs yet");
  return { cfg, manifest, frames: new FrameCache(manifest, productUrl(cfg.id), FRAME_CAPACITY) };
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

class App {
  private prefs = new Map<ViewId, ViewPrefs>();
  private memo = new Map<string, unknown>();
  private token = 0;
  /** The newest render drawn: a scrub draws frames as they arrive, but never an older one over a newer. */
  private drawn = 0;
  /** When the last few steps were taken: four in quick succession preload the whole run. */
  private stepTimes: number[] = [];
  /** The view (everything but the time) a fast scrub asked to preload whole. */
  private wholeRun = "";
  private notice: Notice | null = null;
  private a: Panel;
  private b: Panel;
  private product: Product;
  private playing = false;
  /** Bumped to stop a running loop (and a running preload). */
  private playGen = 0;
  private preloadGen = 0;
  /** What the last "Preload loop" fetched for, so a change resets the button. */
  private preloadKey = "";
  /** The latest render, so the loop waits for a frame to be drawn before the next. */
  private lastRender: Promise<void> = Promise.resolve();
  private display: DisplayPrefs = loadPrefs();
  /** The scrubber's valid-time axis: every model's latest run, and the run shown. */
  private axis!: Axis;
  /** A total's first missing 6-h amount among the runs it sums: the axis ends before it. */
  private gap: TotalGap | null = null;
  /** The loop's valid times, or null for the shown model's whole range on the scrubber. */
  private loop: Span | "week" | null = null;
  /** Days 1–7 on the axis, worked out once per update. */
  private week: Span | null = null;
  /** Phones hide the zoom button, so they ignore a zoom saved on a wider screen. */
  private narrow = window.matchMedia("(max-width: 640px)");
  /** The viewer chose a shading (or a link named one), so models stop choosing it for them. */
  private shadingPicked: boolean;
  private presentation: Presentation | null = null;

  constructor(
    private state: ViewState,
    private products: Map<string, Product>,
    private failed: Map<string, string>,
    notice: Notice | null,
    shadingPicked: boolean,
  ) {
    this.shadingPicked = shadingPicked;
    this.product = products.get(state.product)!;
    this.notice = notice;
    const manifest = this.manifest;
    if (this.state.run === manifest.latest) {
      this.state.run = null;
    } else if (this.state.run && !manifest.runs.some((r) => r.id === this.state.run)) {
      this.notice = {
        text: `The ${fmtTime(parseRunId(this.state.run))} run from this link is no longer retained; showing the latest run.`,
        clearOn: "any",
      };
      this.state.run = null;
    } else if (this.state.run) {
      // A shared link pins its run; say so when something newer exists.
      this.notice = {
        text: `This link shows the ${fmtTime(parseRunId(this.state.run))} run. A newer run, ${fmtTime(parseRunId(manifest.latest!))}, is available.`,
        clearOn: "run",
        action: { label: "Show latest", onClick: () => this.selectRun(null) },
      };
    }
    this.a = new Panel($("map-wrap"), $("map") as HTMLCanvasElement, $("tooltip"), manifest.grid);
    this.b = new Panel($("map-wrap-b"), $("map-b") as HTMLCanvasElement, $("tooltip-b"), manifest.grid);
    for (const p of [this.a, this.b]) p.map.setLabels(this.display.labels);
    $<HTMLInputElement>("labels").checked = this.display.labels;
    window.__wxtrend = {
      renders: 0,
      toScreen: (lon, lat) => {
        const p = this.a.map.toScreen(lon, lat);
        const box = this.a.wrap.getBoundingClientRect();
        return p && { x: box.left + p[0], y: box.top + p[1] };
      },
    };
    this.buildStaticControls();
    this.buildProductControls();
    this.resolveLinkTime();
    this.ensureUsableProduct();
    this.applyShadingDefault();
    this.applyFocus();
    this.bindEvents();
    for (const p of [this.a, this.b]) {
      new ResizeObserver(() => {
        if (p.map.resize()) this.redraw(p);
      }).observe(p.wrap);
    }
    this.a.map.resize();
    this.update();
    reservePinnedSpace();
  }

  /** Presentation mode, made the first time it's opened. */
  private get presenter(): Presentation {
    return (this.presentation ??= new Presentation({
      products: this.products,
      display: () => this.display,
      seed: () => ({ state: { ...this.state }, compare: this.compareId, valid: this.valid }),
      setFps: (fps) => {
        this.display = { ...this.display, fps };
        savePrefs(this.display);
        $<HTMLSelectElement>("fps").value = String(fps);
      },
      exit: () => {
        // Prefs (labels, units, zone) may have changed; the URL goes back to the site's
        $<HTMLInputElement>("labels").checked = this.display.labels;
        this.update();
      },
    }));
  }

  /** Open presentation mode: the layout picker, or a linked layout. */
  present(layout?: SavedLayout & { valid: string | null }): void {
    this.stopPlay();
    if (layout) this.presenter.restore(layout, layout.valid);
    else this.presenter.openPicker();
  }

  private get manifest(): Manifest {
    return this.product.manifest;
  }

  private get cfg(): ProductConfig {
    return this.product.cfg;
  }

  private get run(): string {
    return this.state.run ?? this.manifest.latest!;
  }

  private get view(): ViewDef {
    return viewById(this.state.view);
  }

  private get item(): FieldItem {
    return fieldItem(this.state.view, this.state.variable);
  }

  private get region(): RegionConfig {
    return regionById(this.state.region)!;
  }

  /** The mode the view draws in: compare is the forecast side by side, or a trend-style difference. */
  private get viewMode(): Mode {
    return viewModeOf(this.state);
  }

  private get hours() {
    return hoursOf(this.product);
  }

  private get valid(): Date {
    return addHours(parseRunId(this.run), this.state.fhr);
  }

  private get zone(): Zone {
    return zoneById(this.display.zone)!;
  }

  /** Valid times the shown run covers. */
  private coverageOf(p = this.product, run = this.run): Span {
    return coverage(parseRunId(run), hoursOf(p));
  }

  /** The shown run has a frame at the valid time on the scrubber. */
  private get covered(): boolean {
    return hasHour(this.product, this.state.fhr);
  }

  /**
   * The scrubber spans what's on screen: the shown model's latest run and the
   * run shown, and in compare mode the other model's latest. A model with a
   * shorter range ends the scrubber where its data ends; switching model keeps
   * the valid time, though the thumb moves when the ranges differ.
   */
  private computeAxis(): void {
    const shown = [this.product];
    if (this.state.mode === "compare" && this.compareId) shown.push(this.products.get(this.compareId)!);
    const spans = shown.map((p) => this.coverageOf(p, p.manifest.latest!));
    spans.push(this.coverageOf());
    this.axis = axisOf(spans, Math.min(...shown.map((p) => p.cfg.fhr.step)));
    // A total can't reach past a missing 6-h amount, so the scrubber (and the loop) stop before it
    const compare = this.state.mode === "compare" && this.compareId ? this.products.get(this.compareId)! : null;
    this.gap = totalsGap(this.state, this.product, compare, this.run);
    if (this.gap && this.gap.reach < this.axis.end) {
      this.axis = { ...this.axis, end: this.gap.reach < this.axis.start ? this.axis.start : this.gap.reach };
    }
    this.week = daysWindow(this.axis, new Date(), this.zone, 7);
  }

  /** The part of the axis on the scrubber: all of it, or Days 1–7 when zoomed. */
  private get window(): Span {
    return (this.display.zoom && !this.narrow.matches && this.week) || this.axis;
  }

  /** The valid times a loop plays: the chosen range, or the shown model's, within the scrubber. */
  private loopSpan(): Span {
    const w = this.window;
    // "Next 7 days" is worked out afresh: the axis follows the model, so its days' steps do too
    const base = (this.loop === "week" ? this.week : this.loop) ?? this.coverageOf();
    const start = new Date(Math.max(base.start.getTime(), w.start.getTime()));
    const end = new Date(Math.min(base.end.getTime(), w.end.getTime()));
    return clip(this.axis, { start, end }) ?? w;
  }

  /**
   * Show another run of this model (null: the latest) at the same valid time,
   * like switching model: the hour changes, the forecast time doesn't.
   */
  private selectRun(run: string | null): void {
    const valid = this.valid;
    this.set({ run, fhr: hoursBetween(parseRunId(run ?? this.manifest.latest!), valid) });
  }

  /** Show the valid time `t`, whether or not the shown run reaches it. */
  private setValid(t: Date, fromPlay = false): void {
    this.set({ fhr: hoursBetween(parseRunId(this.run), t) }, fromPlay);
  }

  // ---------------------------------------------------------------- models

  /**
   * Why a product can't show the selected field (and a strict shading's, like
   * snowfall) in the focused region, or null if it can.
   */
  private hiddenReason(id: string, region = this.region, s: Pick<ViewState, "view" | "variable"> = this.state): string | null {
    if (this.failed.has(id)) return "data couldn't be loaded";
    const p = this.products.get(id)!;
    if (!requiredFields(s.view, s.variable).every((f) => f in p.manifest.fields)) return `no ${missingNoun(s.view, s.variable).short} output`;
    if (!gridCovers(p.cfg.grid, region.box)) return `doesn't cover ${region.label}`;
    return null;
  }

  /** Products that output the field and cover the region, in model-bar order. */
  private usable(region = this.region, s: Pick<ViewState, "view" | "variable"> = this.state): string[] {
    return config.products.map((p) => p.id).filter((id) => !this.hiddenReason(id, region, s));
  }

  /** Where a dropped model goes: the first usable one in its group, otherwise GFS (or the first usable). */
  private fallbackFor(id: string, usable: string[]): string | undefined {
    const group = productById(id)!.group;
    return usable.find((u) => productById(u)!.group === group)
      ?? (usable.includes(DEFAULT_PRODUCT) ? DEFAULT_PRODUCT : usable[0]);
  }

  /** If the current model can't show this field and region, switch to another and say why. */
  private ensureUsableProduct(): void {
    const id = this.state.product;
    const why = this.hiddenReason(id);
    if (!why) return;
    const next = this.fallbackFor(id, this.usable());
    if (!next) return;
    const name = this.cfg.name;
    const nextName = productById(next)!.name;
    const text = why.startsWith("no ")
      ? `${name} doesn't output ${missingNoun(this.state.view, this.state.variable).noun}, so this shows ${nextName}.`
      : `${name} ${why}, so this shows ${nextName}.`;
    this.switchProduct(next);
    this.notice = { text, clearOn: "any" };
  }

  /**
   * Models compare mode can put beside the current one. Both sides draw the
   * current shading, so a partner needs its field too: GFS on 500 mb
   * vorticity has no ECMWF ENS mean partner (heights only) until it shades heights.
   */
  private compareCandidates(): string[] {
    const v = this.view, s = this.state;
    const ov = new Set(s.overlays);
    const shaded = v.modes.map((m) => v.fields(m, s.variable, ov).primary);
    return this.usable().filter((id) => id !== s.product
      && shaded.every((f) => f in this.products.get(id)!.manifest.fields));
  }

  /** The model compare mode puts beside the current one: the chosen one if usable, else the first usable other. */
  private get compareId(): string | null {
    const others = this.compareCandidates();
    if (this.state.compare && others.includes(this.state.compare)) return this.state.compare;
    return others[0] ?? null;
  }

  // ---------------------------------------------------------------- controls

  private buildStaticControls(): void {
    // Fields sidebar, grouped
    const list = $("field-list");
    list.replaceChildren();
    for (const group of ["Surface", "Upper air"] as const) {
      const head = document.createElement("div");
      head.className = "fields-group";
      head.textContent = group;
      list.appendChild(head);
      for (const it of FIELD_ITEMS.filter((i) => i.group === group)) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "field-item";
        b.dataset.item = it.id;
        b.title = `${it.label} (${FIELD_ITEMS.indexOf(it) + 1})`;
        b.innerHTML = `<span class="fi-name">${it.label}</span><span class="fi-sub">${it.sub}</span>`;
        list.appendChild(b);
      }
    }

    // Model bar: every configured product, in fixed order; filtering only hides chips
    const bar = $("modelbar");
    bar.replaceChildren(
      ...config.groups.map((g) => {
        const group = document.createElement("div");
        group.className = "mgroup";
        group.dataset.group = g;
        const label = document.createElement("span");
        label.className = "mgroup-label";
        label.textContent = g;
        group.appendChild(label);
        for (const p of config.products.filter((x) => x.group === g)) {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "mchip";
          b.setAttribute("role", "radio");
          b.dataset.value = p.id;
          const latest = this.products.get(p.id)?.manifest.latest;
          b.innerHTML = `<span class="mchip-name">${p.name}</span>${latest ? `<span class="mchip-run"></span>` : ""}`;
          group.appendChild(b);
        }
        return group;
      }),
    );
    const note = document.createElement("span");
    note.className = "mnote";
    note.id = "model-note";
    bar.appendChild(note);
    this.refreshRunAges();
    // A page left open keeps its manifests, so its chips go late as time passes
    window.setInterval(() => this.refreshRunAges(), 60_000);

    const option = (r: RegionConfig, label = r.label) => {
      const o = document.createElement("option");
      o.value = r.id;
      o.textContent = label;
      return o;
    };
    const states = document.createElement("optgroup");
    states.label = "States";
    states.append(...config.regions.filter((r) => r.state).map((r) => option(r)));
    $("region").replaceChildren(
      // Indent Mainland US's regions (option text collapses ordinary spaces)
      ...config.regions.filter((r) => !r.state).map((r) => option(r, regionDepth(r) > 1 ? `\u00a0\u00a0\u00a0${r.label}` : r.label)),
      states,
    );

    segmented($("cmpview"), [
      { value: "side", label: "Side by side" },
      { value: "diff", label: "Difference" },
    ]);

    fillSelect($("zone"), ZONES.map((z) => ({ value: z.id, label: z.id === "UTC" ? "UTC (Z)" : `${z.label} (${z.id})` })));
    segmented($("speed-unit"), [{ value: "kt", label: "kt" }, { value: "mph", label: "mph" }]);
    segmented($("temp-unit"), [{ value: "F", label: "°F" }, { value: "C", label: "°C" }]);
    fillSelect($("fps"), FPS_OPTIONS.map((n) => ({ value: String(n), label: `${n} fps` })));
    segmented($("loop-preset"), [{ value: "all", label: "All" }, { value: "week", label: "Next 7 days" }]);

    $("iso").replaceChildren(
      ...config.isotachOptions.map((v) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "chip";
        b.textContent = String(v);
        b.dataset.value = String(v);
        b.setAttribute("aria-pressed", "false");
        return b;
      }),
    );
  }

  /** Each chip's run label ("12Z", or "Sun 12Z" from another day) and whether its next run is late. */
  private refreshRunAges(): void {
    const now = new Date();
    for (const b of $("modelbar").querySelectorAll<HTMLButtonElement>(".mchip")) {
      const p = this.products.get(b.dataset.value!);
      const latest = p?.manifest.latest;
      if (!p || !latest) continue;
      const r = chipRun(latest, p.cfg, now, this.zone);
      b.querySelector(".mchip-run")!.textContent = r.label;
      b.classList.toggle("late", r.late);
      b.title = r.title;
    }
  }

  /** Controls that depend on the product: its runs, lags and hours. */
  private buildProductControls(): void {
    $<HTMLSelectElement>("run").replaceChildren(
      ...this.manifest.runs.map((r, i) => {
        const o = document.createElement("option");
        o.value = r.id;
        o.textContent = `${fmtTime(parseRunId(r.id))}${i === 0 ? "  (latest)" : ""}${r.complete ? "" : "  (partial)"}`;
        return o;
      }),
    );
    segmented($("lag"), this.cfg.lags.map((l) => ({ value: String(l), label: `${l} h` })));
    const g = this.manifest.generated_at;
    $("updated").textContent = `${this.cfg.name} updated ${fmtStamp(new Date(g)).slice(11, 16)}Z`;
    $("updated").title = `${this.cfg.name} data updated ${fmtStamp(new Date(g))}`;
  }

  /**
   * The scrubber: its range (the axis, or Days 1–7), day ticks at midnight in
   * the viewer's zone, the shown run's coverage, and the loop's handles.
   */
  /** Is everything the view draws at `fhr` (of the run shown) decoded, so showing it needs no download? */
  private loadedAt(fhr: number): boolean {
    const plan = this.plan(pairFor(parseRunId(this.run), fhr, this.state.lag));
    if (!plan.covered) return false;
    for (const [src, ids] of [[plan.cur, plan.needsCur], [plan.older, plan.needsOld], [plan.side ? plan.bSource : null, plan.needsB]] as const) {
      if (!src) continue;
      for (const field of ids) {
        for (const h of hoursFor(src, field, plan)) if (!src.product.frames.has(src.run, field, h)) return false;
      }
    }
    return true;
  }

  /** Shade the scrubber's loaded hours, so a pause while scrubbing shows why. */
  private syncLoaded(): void {
    const w = this.window, step = this.axis.step, init = parseRunId(this.run);
    const span = Math.max(1, hoursBetween(w.start, w.end));
    const pct = (h: number) => Math.min(100, Math.max(0, (h / span) * 100)).toFixed(2);
    const stops: string[] = [];
    let from: number | null = null;
    for (let h = 0; h <= span + step; h += step) {
      const on = h <= span && this.loadedAt(hoursBetween(init, addHours(w.start, h)));
      if (on && from === null) from = h;
      if (!on && from !== null) {
        const a = pct(from - step / 2), b = pct(h - step / 2);
        stops.push(`transparent ${a}%, var(--loaded) ${a}%, var(--loaded) ${b}%, transparent ${b}%`);
        from = null;
      }
    }
    $("loaded").style.background = stops.length ? `linear-gradient(90deg, ${stops.join(", ")})` : "none";
  }

  private syncScrubber(): void {
    const axis = this.axis, w = this.window, zone = this.zone;
    const lo = hoursBetween(axis.start, w.start), hi = hoursBetween(axis.start, w.end);
    const slider = $<HTMLInputElement>("fhr");
    slider.min = String(lo);
    slider.max = String(hi);
    slider.step = String(axis.step);
    const valid = this.valid;
    slider.value = String(hoursBetween(axis.start, valid));
    slider.setAttribute("aria-valuetext", `${fmtValid(valid, zone)} (${this.covered ? fhrLabel(this.state.fhr) : `no ${this.cfg.name} frame`})`);
    const pct = (t: Date) => Math.min(100, Math.max(0, (hoursBetween(w.start, t) / Math.max(1, hi - lo)) * 100));

    // Label every day, or every other day once the range passes 10 days
    const every = hi - lo > 240 ? 2 : 1;
    $("ticks").replaceChildren(
      ...dayTicks(w, zone).filter((_, i) => i % every === 0).map((t) => {
        const span = document.createElement("span");
        span.textContent = fmtDay(t, zone);
        span.style.left = `${pct(t)}%`;
        return span;
      }),
    );

    this.syncLoaded();

    const c = this.coverageOf();
    const cov = $("coverage");
    cov.style.left = `${pct(c.start)}%`;
    cov.style.width = `${pct(c.end) - pct(c.start)}%`;
    $("slider-box").title = `${this.cfg.name} ${fmtTime(parseRunId(this.run))} run: ${fmtLocal(c.start, zone)} to ${fmtLocal(c.end, zone)}`;

    const loop = this.loopSpan();
    const band = $("loop-band");
    band.style.left = `${pct(loop.start)}%`;
    band.style.width = `${pct(loop.end) - pct(loop.start)}%`;
    for (const [id, t] of [["loop-start", loop.start], ["loop-end", loop.end]] as const) {
      const h = $(id);
      h.style.left = `${pct(t)}%`;
      // Hours along the axis, like the scrubber's own value
      h.setAttribute("aria-valuemin", String(lo));
      h.setAttribute("aria-valuemax", String(hi));
      h.setAttribute("aria-valuenow", String(hoursBetween(axis.start, t)));
      h.setAttribute("aria-valuetext", fmtValid(t, zone));
      h.title = `${id === "loop-start" ? "Loop starts" : "Loop ends"} ${fmtValid(t, zone)} (drag, or ← → Home End with the handle focused)`;
    }
    const preset = !this.loop ? "all" : this.loop === "week" ? "week" : "";
    setPressed($("loop-preset"), preset);
    $("zoom").setAttribute("aria-pressed", String(this.display.zoom));

    $<HTMLButtonElement>("prev").disabled = valid <= w.start;
    $<HTMLButtonElement>("next").disabled = valid >= w.end;
  }

  /** A link's valid time (`t`) becomes an hour of the run shown, clamped with a note. */
  private resolveLinkTime(): void {
    const s = this.state;
    if (s.valid) {
      const want = Math.round((parseRunId(s.valid).getTime() - parseRunId(this.run).getTime()) / 3600e3);
      const fhr = this.fitHour(want);
      if (fhr !== want && !this.notice) {
        this.notice = {
          text: `${this.cfg.name}'s ${fmtTime(parseRunId(this.run))} run doesn't cover ${fmtValid(parseRunId(s.valid), this.zone)}; showing ${fhrLabel(fhr)} instead.`,
          clearOn: "any",
        };
      }
      s.fhr = fhr;
    } else {
      s.fhr = this.fitHour(s.fhr);
    }
    s.valid = null;
    if (!this.cfg.lags.includes(s.lag)) s.lag = this.cfg.defaultLag;
  }

  /** The product's hour nearest `fhr`, inside its range. */
  private fitHour(fhr: number): number {
    const { min, max, step } = this.hours;
    return Math.min(max, Math.max(min, min + Math.round((fhr - min) / step) * step));
  }

  /**
   * Show another product at the same valid time: its latest run, at the hour
   * nearest the time on screen (clamped to its range, with a note).
   */
  private switchProduct(id: string): void {
    const next = this.products.get(id);
    if (!next || id === this.state.product) return;
    const valid = this.valid;
    this.product = next;
    this.a.setGrid(next.manifest.grid);
    this.applyFocus();
    this.a.map.resize();
    this.notice = null;
    this.state = { ...this.state, product: id, run: null };
    this.buildProductControls();
    // The valid time stays put, even where this model's run doesn't reach it
    this.state.fhr = hoursBetween(parseRunId(next.manifest.latest!), valid);
    if (!next.cfg.lags.includes(this.state.lag)) this.state.lag = next.cfg.defaultLag;
    this.applyShadingDefault();
  }

  /**
   * Variables a view offers as a Shading choice in Options, rather than as
   * separate sidebar items. A strict one (snowfall) is offered while any model
   * here has it: picking it switches away from a model without, as a field does.
   */
  private shadings(v = this.view) {
    if (!v.variables || FIELD_ITEMS.filter((i) => i.view === v.id).length !== 1) return [];
    return v.variables.filter((x) => x.field in this.manifest.fields
      || (x.strict && this.usable(this.region, { view: v.id, variable: x.id }).length > 0));
  }

  /**
   * Until the viewer picks a shading, each model opens on its own: ensemble
   * means on 500 mb heights (their vorticity is nearly flat), others on vorticity.
   */
  private applyShadingDefault(): void {
    const options = this.shadings();
    if (!options.length) return;
    const want = this.view.id === "h500" && this.cfg.group === "Ensemble mean" ? "hgt" : options[0].id;
    const ok = options.some((o) => o.id === this.state.variable);
    if (!this.shadingPicked || !ok) this.state.variable = options.some((o) => o.id === want) ? want : options[0].id;
  }

  private selectProduct(id: string): void {
    if (id === this.state.product) return;
    this.stopPlay();
    this.switchProduct(id);
    if (this.state.compare === id) this.state.compare = null;
    this.update();
  }

  /** Controls whose options depend on the view and mode (overlays, scale units, compare). */
  private buildViewControls(): void {
    const v = this.view;
    const s = this.state;
    const vm = this.viewMode;
    const others = this.compareCandidates();
    // Same order for every view, whichever mode it opens in
    const modes: { value: string; label: string }[] = (["fcst", "trend"] as const)
      .filter((m) => v.modes.includes(m))
      .map((m) => ({ value: m, label: m === "fcst" ? "Forecast" : "Trend" }));
    if (others.length) modes.push({ value: "compare", label: "Compare" });
    segmented($("mode"), modes);

    const shadings = this.shadings();
    $("shade-field").hidden = shadings.length < 2;
    if (shadings.length > 1) segmented($("shade"), shadings.map((x) => ({ value: x.id, label: x.label })));
    $("acc-field").hidden = !v.periods;
    if (v.periods) segmented($("acc"), PERIODS.map((x) => ({ value: x.id, label: x.label })));

    const cmp = s.mode === "compare";
    $("cmp-field").hidden = !cmp;
    if (cmp) {
      fillSelect($("cmp"), others.map((id) => ({ value: id, label: productById(id)!.name })));
      const bId = this.compareId;
      const bRuns = bId ? this.products.get(bId)!.manifest.runs : [];
      fillSelect($("crun"), [
        { value: "latest", label: "Newest that reaches this time" },
        { value: "same", label: `Same cycle as ${this.cfg.name} (${cycleLabel(this.run)})` },
        ...bRuns.map((r, i) => ({ value: r.id, label: `${fmtTime(parseRunId(r.id))}${i === 0 ? "  (latest)" : ""}` })),
      ]);
      const sameGrid = !!bId && productById(bId)!.grid === this.cfg.grid;
      for (const b of $("cmpview").querySelectorAll<HTMLButtonElement>("button")) {
        if (b.dataset.value === "diff") b.disabled = !sameGrid;
      }
      $("cmp-hint").textContent = sameGrid
        ? "Difference: this model minus the other, on the same grid."
        : "No difference map: the two models are on different grids.";
    }
    $("lag-field").hidden = s.mode !== "trend";
    $("lim-field").hidden = vm !== "trend";
    $("iso-field").hidden = v.id !== "jet";
    const q = v.trendQ(this.display.units);
    segmented($("lim"), [
      { value: "fixed", label: `±${trendLimits(v.trendKey?.(s.variable, s.period) ?? v.id, q).shown} ${q.unit}` },
      { value: "auto", label: "Auto" },
    ]);
    const bName = cmp && this.compareId ? productById(this.compareId)!.name : null;
    // Overlays no model on screen can draw (no 250 mb direction: no flow arrows or barbs) aren't offered
    const drawn = [this.manifest.fields];
    if (cmp && s.compareView === "side" && this.compareId) drawn.push(this.products.get(this.compareId)!.manifest.fields);
    const overlays = v.overlays.filter((o) => (!o.modes || o.modes.includes(vm))
      && drawn.some((fields) => overlayFields(v, vm, s.variable, o.id).every((f) => f in fields)));
    $("overlays-field").hidden = overlays.length === 0;
    $("overlays").replaceChildren(
      ...overlays.map((o) => {
        const label = document.createElement("label");
        label.className = "check";
        const input = document.createElement("input");
        input.type = "checkbox";
        input.value = o.id;
        input.checked = s.overlays.includes(o.id);
        // In a difference map the "older run" is the other model
        const text = bName ? o.label.replace(/^Older run's/, `${bName}'s`) : o.label;
        label.append(input, document.createTextNode(text));
        return label;
      }),
    );
    $("explain-view").innerHTML = this.explain();
  }

  /**
   * The models' own notes under the view's explanation: what a mean is made
   * of, and how each model on screen makes its snowfall.
   */
  private about(): string {
    const snow = strictVariable(this.state.view, this.state.variable)?.field === "snow";
    const other = this.state.mode === "compare" && this.compareId ? productById(this.compareId)! : null;
    const notes = [
      [this.cfg.name, this.cfg.about],
      ...(snow ? [[this.cfg.name, this.cfg.snowfall], [other?.name, other?.snowfall]] : []),
    ].filter(([name, n]) => name && n);
    return notes.map(([name, n]) => `<p class="note">${name}: ${n}</p>`).join("");
  }

  private explain(): string {
    const s = this.state, v = this.view;
    if (s.mode !== "compare") return v.explain(s.mode, s.variable, this.display.units, s.period) + this.about();
    const a = this.cfg.name, b = this.compareId ? productById(this.compareId)!.name : "the other model";
    const runs = s.compareRun === "latest"
      ? "each from its newest run that reaches it"
      : s.compareRun === "same" ? "both from the same cycle" : `${b} from its ${fmtTime(parseRunId(s.compareRun))} run`;
    if (s.compareView === "diff") {
      // Precipitation says what's subtracted: its period and, for snow, the ratio
      const noun = s.view === "precip" ? fieldName(s).toLowerCase() : this.item.diffNoun ?? missingNoun(s.view, s.variable).noun;
      const window = s.view === "precip" && s.period !== "6h" ? " Both are summed over the same hours, from the newer of the two runs." : "";
      return `<p><strong>Shading:</strong> ${a}'s ${noun} minus ${b}'s, both valid at the same time, ${runs}.${window}</p>
        ${s.view === "precip" // shaded brown to green, as its trend is
          ? `<p class="legend-row"><span class="sw green"></span> ${a} more <span class="sw brown"></span> ${b} more</p>`
          : `<p class="legend-row"><span class="sw red"></span> ${a} higher <span class="sw blue"></span> ${b} higher</p>`}` + this.about();
    }
    return `<p><strong>Side by side:</strong> ${a} (left) and ${b} (right) at the same valid time, ${runs}.</p>` +
      v.explain("fcst", s.variable, this.display.units, s.period) + this.about();
  }

  private bindEvents(): void {
    $("field-list").addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button");
      const it = b && FIELD_ITEMS.find((i) => i.id === b.dataset.item);
      if (it) {
        this.setField(it);
        closeSheets();
      }
    });
    $("modelbar").addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button");
      if (b) this.selectProduct(b.dataset.value!);
    });
    $<HTMLSelectElement>("region").addEventListener("change", (e) => this.setRegion((e.target as HTMLSelectElement).value));
    $("crumbs").addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button");
      if (b) this.setRegion(b.dataset.region!);
    });
    $<HTMLSelectElement>("run").addEventListener("change", (e) => {
      const v = (e.target as HTMLSelectElement).value;
      this.selectRun(v === this.manifest.latest ? null : v);
    });
    const radio = (id: string, apply: (value: string) => void) =>
      $(id).addEventListener("click", (e) => {
        const b = (e.target as HTMLElement).closest("button");
        if (b && !b.disabled) apply(b.dataset.value!);
      });
    radio("lag", (v) => this.set({ lag: Number(v) }));
    radio("shade", (v) => {
      this.shadingPicked = true;
      this.stopPlay();
      if (this.notice?.clearOn === "any") this.notice = null;
      this.state = { ...this.state, variable: v };
      this.ensureUsableProduct(); // Snow on a model without snowfall switches model, as a field would
      this.update();
    });
    radio("acc", (v) => this.set({ period: v as ViewState["period"] }));
    radio("lim", (v) => this.set({ limitMode: v as ViewState["limitMode"] }));
    radio("mode", (v) => this.set({ mode: v as ViewState["mode"] }));
    $<HTMLSelectElement>("cmp").addEventListener("change", (e) => {
      // A picked run belongs to the old model; "latest" and "same" carry over
      const keep = ["latest", "same"].includes(this.state.compareRun) ? this.state.compareRun : "latest";
      this.set({ compare: (e.target as HTMLSelectElement).value, compareRun: keep });
    });
    $<HTMLSelectElement>("crun").addEventListener("change", (e) => this.set({ compareRun: (e.target as HTMLSelectElement).value }));
    radio("cmpview", (v) => this.set({ compareView: v as ViewState["compareView"] }));
    $("iso").addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest("button");
      if (!b) return;
      const v = Number(b.dataset.value);
      const cur = new Set(this.state.isotachs);
      if (cur.has(v)) cur.delete(v);
      else cur.add(v);
      this.set({ isotachs: [...cur].sort((a, b) => a - b) });
    });
    $("overlays").addEventListener("change", (e) => {
      const input = e.target as HTMLInputElement;
      const cur = new Set(this.state.overlays);
      if (input.checked) cur.add(input.value);
      else cur.delete(input.value);
      this.set({ overlays: this.view.overlays.map((o) => o.id).filter((id) => cur.has(id)) });
    });
    $<HTMLInputElement>("fhr").addEventListener("input", (e) => {
      this.noteStep();
      this.setValid(addHours(this.axis.start, Number((e.target as HTMLInputElement).value)));
    });
    // Frames land in bursts: redraw the loaded marks at most five times a second
    let marks = 0;
    frameEvents.addEventListener("frame", () => {
      if (!marks) marks = window.setTimeout(() => ((marks = 0), this.syncLoaded()), 200);
    });
    $("prev").addEventListener("click", () => this.step(-1));
    $("next").addEventListener("click", () => this.step(1));
    $("play").addEventListener("click", () => this.togglePlay());
    this.bindLoopControls();

    $<HTMLSelectElement>("zone").addEventListener("change", (e) => {
      this.setDisplay({ zone: (e.target as HTMLSelectElement).value as Zone["id"] });
      this.refreshRunAges();
    });
    radio("speed-unit", (v) => this.setDisplay({ units: { ...this.display.units, speed: v as "kt" | "mph" } }));
    radio("temp-unit", (v) => this.setDisplay({ units: { ...this.display.units, temp: v as "F" | "C" } }));
    $<HTMLInputElement>("labels").addEventListener("change", (e) => {
      this.display = { ...this.display, labels: (e.target as HTMLInputElement).checked };
      savePrefs(this.display);
      for (const p of [this.a, this.b]) p.map.setLabels(this.display.labels);
    });

    $("present-open").addEventListener("click", () => this.present());
    $("open-fields").addEventListener("click", () => openSheet("fields"));
    $("open-options").addEventListener("click", () => openSheet("options"));
    $("backdrop").addEventListener("click", closeSheets);
    for (const b of document.querySelectorAll(".sheet-close")) b.addEventListener("click", closeSheets);

    document.addEventListener("keydown", (e) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === "Escape") {
        if (closeSheets()) return;
        const parent = this.region.parent;
        if (parent) this.setRegion(parent);
        return;
      }
      // Shift+←/→ steps a day, also from the scrubber (which would otherwise step 6 h)
      if (e.shiftKey && (e.key === "ArrowLeft" || e.key === "ArrowRight") && (e.target as HTMLElement).id === "fhr") {
        this.step(e.key === "ArrowLeft" ? -1 : 1, 24);
        e.preventDefault();
        return;
      }
      // Form controls (including the slider) handle their own arrow keys.
      if (["INPUT", "SELECT", "TEXTAREA"].includes((e.target as HTMLElement).tagName)) return;
      const n = Number(e.key);
      if (n >= 1 && n <= FIELD_ITEMS.length) this.setField(FIELD_ITEMS[n - 1]);
      else if (e.key === "ArrowLeft") this.step(-1, e.shiftKey ? 24 : undefined);
      else if (e.key === "ArrowRight") this.step(1, e.shiftKey ? 24 : undefined);
      else if (e.key === "Home") this.setValid(this.window.start);
      else if (e.key === "End") this.setValid(this.window.end);
      else if (e.key === " " && (e.target as HTMLElement).tagName !== "BUTTON") this.togglePlay();
      else if (e.key === "p" || e.key === "P") this.present();
      else return;
      e.preventDefault();
    });

    for (const p of [this.a, this.b]) {
      p.wrap.addEventListener("pointermove", (e) => this.hover(p, e));
      p.wrap.addEventListener("pointerdown", (e) => this.hover(p, e));
      p.wrap.addEventListener("pointerleave", () => {
        p.pointer = null;
        p.tooltip.hidden = true;
        p.map.highlight(null);
        p.wrap.classList.remove("can-focus");
      });
      p.wrap.addEventListener("click", (e) => {
        const target = this.regionUnder(p, e);
        if (target) this.setRegion(target);
      });
    }
  }

  /** Pick a sidebar item: keep the model if it outputs the field, otherwise fall back with a note. */
  private setField(it: FieldItem): void {
    const s = this.state;
    // An item without a variable (500 mb) keeps the view's shading choice
    if (it.view === s.view && (it.variable === s.variable || !it.variable)) return;
    this.prefs.set(s.view, { mode: s.mode, variable: s.variable, overlays: s.overlays });
    const prefs = it.view === s.view ? { mode: s.mode, overlays: s.overlays } : { ...(this.prefs.get(it.view) ?? viewDefaults(it.view)) };
    // Compare mode carries across fields
    const mode = s.mode === "compare" ? "compare" : prefs.mode === "compare" ? viewById(it.view).defaultMode : prefs.mode;
    this.notice = null;
    const variable = it.variable || ("variable" in prefs ? prefs.variable : s.variable);
    this.state = { ...s, view: it.view, variable, overlays: prefs.overlays, mode };
    this.ensureUsableProduct();
    this.applyShadingDefault();
    this.update();
  }

  /** Focus a region: refit the map (frames are reused), and drop a model that doesn't cover it. */
  private setRegion(id: string): void {
    const r = regionById(id);
    if (!r || id === this.state.region) return;
    if (this.notice?.clearOn === "any") this.notice = null;
    const product = this.state.product;
    this.state = { ...this.state, region: id };
    this.ensureUsableProduct();
    this.applyFocus();
    // A new model, or an empty map whose banner says where the run ends: draw it all again
    if (this.state.product !== product || !this.covered) {
      this.update();
      return;
    }
    this.syncChrome();
    for (const p of [this.a, this.b]) {
      p.map.highlight(null);
      this.redraw(p);
    }
    showBanner(this.notice, true);
  }

  private applyFocus(): void {
    const box = this.region.parent ? this.region.box : null;
    this.a.map.setFocus(box);
    this.b.map.setFocus(box);
  }

  /** The region a click at this point would focus, if any. */
  private regionUnder(p: Panel, e: { clientX: number; clientY: number }): string | null {
    const box = p.wrap.getBoundingClientRect();
    const ll = p.map.invert(e.clientX - box.left, e.clientY - box.top);
    // Inside a US region (or a state), clicks zoom to a state
    const id = ll && (regionDepth(this.region) >= 2 ? stateAt(ll[0], ll[1]) : regionAt(ll[0], ll[1]));
    return id && id !== this.state.region ? id : null;
  }

  /**
   * Step the valid time by `hours` (one step, or a day with Shift), stopping
   * at the scrubber's ends. A time off the scrubber (a past run's, or before
   * a zoomed Day 1) steps onto it.
   */
  private step(dir: number, hours = this.axis.step): void {
    this.noteStep();
    const w = this.window;
    const t = addHours(this.valid, dir * hours).getTime();
    const to = new Date(Math.min(w.end.getTime(), Math.max(w.start.getTime(), t)));
    if (to.getTime() !== this.valid.getTime() && Math.sign(to.getTime() - this.valid.getTime()) === Math.sign(dir)) this.setValid(to);
  }

  /** A step by hand. Four within FAST_STEPS_MS mean a scrub: preload the whole run of this view, nearest first. */
  private noteStep(): void {
    const now = performance.now(), t = this.stepTimes;
    t.push(now);
    if (t.length > 4) t.shift();
    if (t.length === 4 && now - t[0] < FAST_STEPS_MS) this.wholeRun = this.viewKey();
  }

  private togglePlay(): void {
    if (this.playing) {
      this.stopPlay();
      return;
    }
    this.playing = true;
    $("play").setAttribute("aria-pressed", "true");
    const loop = this.loopSpan();
    if (this.valid < loop.start || this.valid > loop.end) this.setValid(loop.start, true);
    void this.runLoop(++this.playGen);
  }

  /**
   * A frame every 1/fps seconds, or as fast as frames draw when that's slower
   * (a slow frame delays the next rather than piling up); the last frame
   * holds a moment longer.
   */
  private async runLoop(gen: number): Promise<void> {
    try {
      let stepAt = performance.now();
      await this.lastRender;
      while (gen === this.playGen) {
        const loop = this.loopSpan();
        const hold = this.valid >= loop.end ? LOOP_HOLD_MS : 0;
        await sleep(stepAt + 1000 / this.display.fps + hold - performance.now());
        if (gen !== this.playGen) return;
        stepAt = performance.now();
        const next = addHours(this.valid, this.axis.step);
        this.setValid(next > loop.end || this.valid < loop.start ? loop.start : next, true);
        await this.lastRender;
      }
    } finally {
      // A frame that failed to draw ends the loop, not just silently stalls it
      if (gen === this.playGen) this.stopPlay();
    }
  }

  private stopPlay(): void {
    if (!this.playing) return;
    this.playing = false;
    this.playGen++;
    $("play").setAttribute("aria-pressed", "false");
    this.syncChrome(); // the URL waits for the loop to stop
  }

  /** Change a display preference (zone, units, zoom) and remember it. */
  private setDisplay(patch: Partial<DisplayPrefs>): void {
    this.display = { ...this.display, ...patch };
    savePrefs(this.display);
    this.update();
  }

  private bindLoopControls(): void {
    $<HTMLSelectElement>("fps").value = String(this.display.fps);
    $<HTMLSelectElement>("fps").addEventListener("change", (e) => {
      this.display = { ...this.display, fps: Number((e.target as HTMLSelectElement).value) };
      savePrefs(this.display);
    });
    $("loop-preset").addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest("button");
      if (!b) return;
      this.loop = b.dataset.value === "week" ? "week" : null;
      this.update();
    });
    $("zoom").addEventListener("click", () => {
      this.display = { ...this.display, zoom: !this.display.zoom };
      savePrefs(this.display);
      const w = this.window;
      if (this.valid < w.start || this.valid > w.end) this.setValid(this.valid < w.start ? w.start : w.end);
      else this.update();
    });
    $("preload").addEventListener("click", () => void this.preloadLoop());
    this.narrow.addEventListener("change", () => this.update());

    // Loop handles: drag along the scrubber, or arrow keys (Shift: a day) when focused
    for (const [id, edge] of [["loop-start", "start"], ["loop-end", "end"]] as const) {
      const h = $(id);
      h.addEventListener("pointerdown", (e) => {
        h.setPointerCapture(e.pointerId);
        h.focus();
        e.preventDefault();
      });
      h.addEventListener("pointermove", (e) => {
        if (h.hasPointerCapture(e.pointerId)) this.moveLoopEdge(edge, this.timeAtX(e.clientX));
      });
      h.addEventListener("keydown", (e) => {
        const dir = e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : 0;
        const to = e.key === "Home" ? this.window.start : e.key === "End" ? this.window.end : null;
        if (!dir && !to) return;
        e.preventDefault();
        e.stopPropagation();
        this.moveLoopEdge(edge, to ?? addHours(this.loopSpan()[edge], dir * (e.shiftKey ? 24 : this.axis.step)));
      });
    }
  }

  /** The axis position nearest a point on the scrubber (its track is inset 8 px each side). */
  private timeAtX(clientX: number): Date {
    const box = $("slider-box").getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - box.left - 8) / Math.max(1, box.width - 16)));
    const w = this.window;
    const h = frac * hoursBetween(w.start, w.end);
    const step = this.axis.step;
    return addHours(w.start, Math.round(h / step) * step);
  }

  private moveLoopEdge(edge: "start" | "end", t: Date): void {
    const w = this.window, step = this.axis.step;
    let { start, end } = this.loopSpan();
    const clamp = (x: Date, lo: Date, hi: Date) => new Date(Math.min(hi.getTime(), Math.max(lo.getTime(), x.getTime())));
    if (edge === "start") start = clamp(t, w.start, addHours(end, -step));
    else end = clamp(t, addHours(start, step), w.end);
    this.loop = { start, end };
    this.syncScrubber();
    this.syncPreload();
  }

  /** What "Preload loop" fetches, for each valid time in the loop: every field the view draws, from every run it draws. */
  private loopFrames(): { frames: FrameCache; run: string; field: string; fhr: number }[] {
    const out = new Map<string, { frames: FrameCache; run: string; field: string; fhr: number }>();
    const loop = this.loopSpan();
    const init = parseRunId(this.run);
    const { min, max } = this.hours;
    for (let t = loop.start; t <= loop.end; t = addHours(t, this.axis.step)) {
      const fhr = hoursBetween(init, t);
      if (fhr < min || fhr > max) continue;
      const plan = this.plan(pairFor(init, fhr, this.state.lag));
      for (const [src, ids] of [[plan.cur, plan.needsCur], [plan.older, plan.needsOld], [plan.side ? plan.bSource : null, plan.needsB]] as const) {
        if (!src) continue;
        for (const field of ids) {
          for (const fhr of hoursFor(src, field, plan)) {
            if (src.product.frames.missingReason(src.run, field, fhr)) continue;
            out.set(`${src.product.cfg.id}/${src.run}/${field}/${fhr}`, { frames: src.product.frames, run: src.run, field, fhr });
          }
        }
      }
    }
    return [...out.values()];
  }

  /** Identifies what a preload covers; a change in it resets the button. */
  private preloadSignature(): string {
    const loop = this.loopSpan();
    return [this.viewKey(), loop.start.getTime(), loop.end.getTime()].join("|");
  }

  /** The view without its time: everything a frame's data depends on but the valid time. */
  private viewKey(): string {
    const s = this.state;
    return [s.product, this.run, s.view, s.mode, s.variable, s.period, s.overlays, s.lag, this.compareId, s.compareView, s.compareRun].join("|");
  }

  private syncPreload(): void {
    if (this.preloadKey && this.preloadKey === this.preloadSignature()) return;
    this.preloadKey = "";
    this.preloadGen++;
    const b = $<HTMLButtonElement>("preload");
    b.textContent = "Preload loop";
    b.disabled = false;
    delete b.dataset.state;
  }

  /** Fetch the whole loop ahead, six frames at a time, with progress on the button. */
  private async preloadLoop(): Promise<void> {
    const gen = ++this.preloadGen;
    this.preloadKey = this.preloadSignature();
    const b = $<HTMLButtonElement>("preload");
    const jobs = this.loopFrames();
    let done = 0;
    const progress = () => (b.textContent = `Preloading ${done}/${jobs.length}`);
    b.disabled = true;
    b.dataset.state = "loading";
    progress();
    $("preload-status").textContent = `Preloading ${jobs.length} frames`;
    const queue = [...jobs];
    const worker = async () => {
      while (queue.length && gen === this.preloadGen) {
        const j = queue.shift()!;
        await j.frames.get(j.run, j.field, j.fhr).catch(() => {});
        done++;
        if (gen === this.preloadGen) progress();
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    if (gen !== this.preloadGen) return;
    b.textContent = `Loop preloaded (${jobs.length} frames)`;
    b.disabled = false;
    b.dataset.state = "done";
    $("preload-status").textContent = `Loop preloaded: ${jobs.length} frames`;
  }

  private set(patch: Partial<ViewState>, fromPlay = false): void {
    if (!fromPlay && !("fhr" in patch && Object.keys(patch).length === 1)) this.stopPlay();
    if (this.notice && (this.notice.clearOn === "any" || "run" in patch)) this.notice = null;
    this.state = { ...this.state, ...patch };
    this.update(fromPlay);
  }

  /** Model bar, sidebar, region controls and URL: everything but the maps. */
  private syncChrome(): void {
    const s = this.state;
    const item = this.item;
    for (const b of $("field-list").querySelectorAll<HTMLButtonElement>("button")) {
      b.setAttribute("aria-current", String(b.dataset.item === item.id));
    }
    $("open-fields").textContent = `Fields: ${item.label}`;

    // Model bar: only usable chips; groups with none collapse; a note says who's missing
    const hidden = new Map<string, string[]>();
    for (const group of $("modelbar").querySelectorAll<HTMLElement>(".mgroup")) {
      let any = false;
      for (const b of group.querySelectorAll<HTMLButtonElement>("button")) {
        const id = b.dataset.value!;
        const why = this.hiddenReason(id);
        b.hidden = !!why;
        any ||= !why;
        if (why) hidden.set(why, [...(hidden.get(why) ?? []), productById(id)!.name]);
      }
      group.hidden = !any;
    }
    setPressed($("modelbar"), s.product);
    $("model-note").textContent = hidden.size
      ? `Not shown: ${[...hidden].map(([why, names]) => `${names.join(", ")} (${why})`).join("; ")}`
      : "";

    $<HTMLSelectElement>("region").value = s.region;
    const path: RegionConfig[] = [];
    for (let r: RegionConfig | undefined = this.region; r; r = r.parent ? regionById(r.parent) : undefined) path.unshift(r);
    $("crumbs").replaceChildren(
      ...path.flatMap((r, i) => {
        const last = i === path.length - 1;
        const el = document.createElement(last ? "span" : "button");
        el.textContent = r.label;
        if (last) el.setAttribute("aria-current", "location");
        else {
          (el as HTMLButtonElement).type = "button";
          el.dataset.region = r.id;
        }
        return i ? [Object.assign(document.createElement("span"), { className: "sep", textContent: "›" }), el] : [el];
      }),
    );
    const touch = window.matchMedia("(pointer: coarse)").matches;
    const target = regionDepth(this.region) >= 2 ? "state" : "region";
    $("crumbs-hint").textContent = this.region.id === "hawaii" ? "" : `${touch ? "Tap" : "Click"} a ${target} to zoom${this.region.parent ? " · Esc to zoom out" : ""}`;

    // Links name the compared model, even when it's the default
    const url = serializeState(s.mode === "compare" ? { ...s, compare: this.compareId } : s, this.run);
    if (url !== location.search) history.replaceState(null, "", url);
    try {
      localStorage.setItem(LAST_VIEW_KEY, rememberable(url));
    } catch {
      // Storage blocked (private mode): the next bare visit gets the first-visit view
    }
    $("app").dataset.region = s.region;
  }

  /**
   * Sync controls and URL to state, then render. A loop frame changes only
   * the time, so it skips the chrome and Options (and the URL: Safari allows
   * 100 history writes in 30 s, which a loop at 4 fps passes).
   */
  private update(fromPlay = false): void {
    const s = this.state;
    this.computeAxis();
    // A total past a missing hour can't be drawn: step back to the last one that can, and say why
    if (this.gap && this.valid > this.axis.end) {
      s.fhr = hoursBetween(parseRunId(this.run), this.axis.end);
      this.notice = { text: `${this.gapText(this.gap)}, so totals stop at ${fmtValid(this.axis.end, this.zone)}.`, clearOn: "any" };
    }
    // A picked run the compared model no longer has (or a link's): back to its newest
    if (s.mode === "compare" && !["latest", "same"].includes(s.compareRun)) {
      const runs = this.compareId ? this.products.get(this.compareId)!.manifest.runs : [];
      if (!runs.some((r) => r.id === s.compareRun)) s.compareRun = "latest";
    }
    // A compare partner that can't show this field: pick another, or leave compare mode
    if (s.mode === "compare" && !this.compareId) {
      s.mode = this.view.defaultMode;
      this.notice = { text: `No other model outputs ${missingNoun(s.view, s.variable).noun} here, so there's nothing to compare.`, clearOn: "any" };
    }
    if (!fromPlay) {
      this.syncChrome();
      this.buildViewControls();
    }
    setPressed($("mode"), s.mode);
    setPressed($("shade"), s.variable);
    setPressed($("acc"), s.period);
    if (s.mode === "compare") {
      $<HTMLSelectElement>("cmp").value = this.compareId ?? "";
      $<HTMLSelectElement>("crun").value = s.compareRun;
    }
    setPressed($("cmpview"), s.compareView);
    $<HTMLSelectElement>("run").value = this.run;
    setPressed($("lag"), String(s.lag));
    setPressed($("lim"), s.limitMode);
    for (const b of $("iso").querySelectorAll<HTMLButtonElement>("button")) {
      b.setAttribute("aria-pressed", String(s.isotachs.includes(Number(b.dataset.value))));
    }
    $<HTMLSelectElement>("zone").value = this.display.zone;
    setPressed($("speed-unit"), this.display.units.speed);
    setPressed($("temp-unit"), this.display.units.temp);
    this.syncScrubber();
    this.syncPreload();
    const valid = this.valid, zone = this.zone;
    const sub = [
      zone.id === "UTC" ? "" : fmtZ(valid),
      this.covered ? fhrLabel(s.fhr) : `no ${this.cfg.name} frame`,
      dayLabel(new Date(), valid, zone),
    ].filter(Boolean).join(" · ");
    $("fhr-readout").innerHTML =
      `<strong>${fmtLocal(valid, zone)}</strong><span>${sub}<span class="ro-run"> · ${cycleLabel(this.run)} run</span></span>`;
    document.title = `${this.cfg.name} ${this.item.label} · Run to Run Wx`;

    const pair = this.pairAt(s.fhr);
    $("lag-hint").textContent = this.covered ? `${fmtTime(pair.olderInit)} at ${fhrLabel(pair.olderFhr)}` : "";
    this.lastRender = this.render(pair);
  }

  /**
   * The current and older runs at an hour of the run shown. On the shared
   * axis the hour can be one the run doesn't have, even before its init
   * (which `pairFor` refuses); render() then shows where the run starts or ends.
   */
  private pairAt(fhr: number): FramePair {
    const init = parseRunId(this.run);
    if (fhr >= 0) return pairFor(init, fhr, this.state.lag);
    const olderInit = addHours(init, -this.state.lag);
    return {
      valid: addHours(init, fhr), currentInit: init, currentFhr: fhr, olderInit, olderFhr: fhr + this.state.lag,
      currentRun: this.run, olderRun: runId(olderInit),
    };
  }

  // ---------------------------------------------------------------- render

  /** The sources and fields a frame draws: the current run, the older run or other model, and the right-hand map. */
  private plan(pair: FramePair): FramePlan {
    const compare = this.compareId ? this.products.get(this.compareId)! : null;
    return planFrame(this.state, this.product, compare, pair);
  }

  private async render(pair: FramePair): Promise<void> {
    const token = ++this.token;
    const view0 = this.viewKey();
    frameQueue.focus(pair.valid.getTime(), view0);
    const s = this.state;
    const view = this.view;
    const vm = this.viewMode;
    const plan = this.plan(pair);
    const { all, cur, covered, bProduct, bPick, bSource, older, side, needsCur, needsOld, needsB, acc } = plan;

    const spinner = $("spinner");
    const spinTimer = window.setTimeout(() => (spinner.hidden = false), 120);
    const load = (src: Source | null, ids: string[]) => (src ? loadFields(src, ids, plan) : Promise.resolve([]));
    const [curRes, oldRes, bRes] = await Promise.all([load(cur, needsCur), load(older, needsOld), load(bSource, needsB)]);
    window.clearTimeout(spinTimer);
    // A newer request is waiting. A scrub passing through still draws this
    // frame, if nothing newer is on screen and the view is the same.
    const latest = token === this.token;
    if (!latest && (token < this.drawn || view0 !== this.viewKey())) return;
    this.drawn = token;
    if (latest) spinner.hidden = true;

    const settle = (ids: string[], res: PromiseSettledResult<Bands>[]) =>
      Object.fromEntries(ids.map((f, i) => [f, res[i]?.status === "fulfilled" ? res[i].value : null]));
    const curBands = settle(needsCur, curRes);
    const oldBands = settle(needsOld, oldRes);
    const curFail = curRes[needsCur.indexOf(all.primary)];
    const oldFail = oldRes[needsOld.indexOf(all.primary)];

    const aName = this.cfg.name, bName = bProduct?.cfg.name ?? "";
    let frame: FrameState = vm === "trend" ? "delta" : "forecast";
    let banner: Notice | null = this.notice;
    if (!covered) {
      // Say where the run starts or ends, and offer to go there
      frame = "no-frame";
      const c = this.coverageOf();
      const before = pair.valid < c.start, edge = before ? c.start : c.end;
      banner = {
        text: `${aName}'s ${fmtTime(pair.currentInit)} run ${before ? "starts" : "ends"} at ${fmtValid(edge, this.zone)}.`,
        clearOn: "any",
        action: { label: before ? "Go to its first hour" : "Go to its last hour", onClick: () => this.setValid(edge) },
      };
    } else if (acc && acc.hours === 0) {
      // A total from this time on has nothing in it yet
      frame = "no-frame";
      const next = addHours(acc.start, acc.period === "total" ? 6 : 24);
      banner = {
        text: `The ${acc.period === "total" ? "total" : "24-h total"} starts at ${fmtValid(acc.start, this.zone)}${s.mode === "fcst" && !side ? `, where ${aName}'s run starts` : ", where the newest run shown starts"}.`,
        clearOn: "any",
        action: { label: acc.period === "total" ? "Go 6 h later" : "Go 24 h later", onClick: () => this.setValid(next) },
      };
    } else if (!curBands[all.primary]) {
      frame = "no-frame";
      banner = {
        text: `Frame unavailable: ${fmtTime(pair.currentInit)} ${fhrLabel(pair.currentFhr)} (${reason(curFail)}).`,
        clearOn: "any",
      };
    } else if (vm === "trend" && !oldBands[all.primary]) {
      frame = "no-comparison";
      banner = s.mode === "trend"
        ? {
          text: `Comparison unavailable: needs the ${fmtTime(pair.olderInit)} run at ${fhrLabel(pair.olderFhr)} (${reason(oldFail)}).`,
          clearOn: "any",
        }
        : {
          text: `Comparison unavailable: ${bName} has no frame valid ${fmtValid(pair.valid, this.zone)} (${older ? reason(oldFail) : bPick!.why}).`,
          clearOn: "any",
        };
    }
    const sides: Sides = s.mode === "compare"
      ? {
        cur: aName, old: bName,
        minus: `${aName} ${cycleLabel(pair.currentRun)} minus ${bName}${older ? ` ${cycleLabel(older.run)}` : ""}`,
      }
      : { cur: "Current", old: "Older", minus: `${fmtTime(pair.currentInit)} minus ${fmtTime(pair.olderInit)}` };
    const key = (src: Source | null) => (src ? `${src.product.cfg.id}:${src.run}/${src.fhr}` : "-");
    this.a.rendered = {
      view, mode: vm, cur: curBands, old: oldBands, sides, frame, pair,
      prefix: `${view.id}|${key(cur)}|${key(older)}|`, precipType: this.cfg.precipType, acc,
    };

    // The right-hand map in side-by-side mode
    let frameB: FrameState | null = null;
    if (side) {
      const bBands = settle(needsB, bRes);
      frameB = bBands[all.primary] ? "forecast" : "no-frame";
      const bPair = bSource ? pairFor(parseRunId(bSource.run), bSource.fhr, s.lag) : pair;
      this.b.rendered = {
        view, mode: "fcst", cur: bBands, old: {}, sides, frame: frameB, pair: bPair,
        prefix: `${view.id}|${key(bSource)}|-|`, precipType: bProduct!.cfg.precipType, acc,
      };
      if (frameB === "no-frame" && frame !== "no-frame") {
        const why = bSource ? reason(bRes[needsB.indexOf(all.primary)]) : bPick!.why;
        banner = { text: `${bName} has no frame valid ${fmtValid(pair.valid, this.zone)} (${why}).`, clearOn: "any" };
      }
      if (this.b.grid.id !== bProduct!.manifest.grid.id) this.b.setGrid(bProduct!.manifest.grid);
    }
    // Runs that started far apart make an unfair comparison: say so
    if (!banner && s.mode === "compare" && bSource) {
      const gap = Math.round((pair.currentInit.getTime() - parseRunId(bSource.run).getTime()) / 3600e3);
      if (Math.abs(gap) > 12) {
        const [older, newer] = gap > 0 ? [bName, aName] : [aName, bName];
        banner = {
          text: `${older}'s run is ${Math.abs(gap)} h older than ${newer}'s (${aName} ${fmtTime(pair.currentInit)}, ${bName} ${fmtTime(parseRunId(bSource.run))}).`,
          clearOn: "any",
        };
      }
    }
    this.layoutPanels(side, bSource);
    this.drawScene(this.a);
    if (side) this.drawScene(this.b);
    this.titles(pair, side ? bSource : null, older, bName, covered, acc);
    showBanner(banner, !covered || ((frame === "delta" || frame === "forecast") && frameB !== "no-frame"));
    for (const p of [this.a, this.b]) if (p.pointer) this.hover(p, p.pointer);
    this.preload(cur, needsCur, older, needsOld, side ? bSource : null, needsB);

    const appEl = $("app");
    appEl.dataset.state = "ready";
    appEl.dataset.frame = frame;
    appEl.dataset.view = view.id;
    appEl.dataset.product = this.cfg.id;
    appEl.dataset.mode = s.mode;
    if (s.mode === "compare" && bProduct) appEl.dataset.compare = bProduct.cfg.id;
    else delete appEl.dataset.compare;
    if (frameB) appEl.dataset.frameB = frameB;
    else delete appEl.dataset.frameB;
    window.__wxtrend!.renders++;
  }

  /** "ECMWF's 12Z run has no 6-hour snowfall for F018" */
  private gapText(g: TotalGap): string {
    const what = this.state.variable === "snow" ? "snowfall" : "precipitation";
    return `${g.product.cfg.name}'s ${fmtTime(parseRunId(g.run))} run has no 6-hour ${what} for ${fhrLabel(g.fhr)}`;
  }

  /** Show or hide the second map; the first keeps its size class in sync. */
  private layoutPanels(side: boolean, bSource: Source | null): void {
    const was = !$("panel-b").hidden;
    $("panel-b").hidden = !side;
    $("title-a").hidden = !side;
    $("maps").classList.toggle("side", side);
    if (was !== side) {
      this.a.map.resize();
      if (side) this.b.map.resize();
    }
    if (side && bSource) this.b.map.setFocus(this.region.parent ? this.region.box : null);
  }

  private titles(pair: FramePair, b: Source | null, older: Source | null, bName: string, covered: boolean, acc: Window | null): void {
    const s = this.state, v = this.view;
    const times = {
      model: this.cfg.name,
      init: fmtTime(pair.currentInit),
      older: fmtTime(pair.olderInit),
      valid: fmtValid(pair.valid, this.zone),
      fhr: fhrLabel(pair.currentFhr),
      untyped: !this.cfg.precipType,
      units: this.display.units,
      acc: acc && { period: acc.period, hours: acc.hours, from: fmtValid(acc.from, this.zone) },
    };
    $("acc-hint").textContent = [
      acc
        ? acc.period === "total"
          ? `From ${fmtValid(acc.start, this.zone)}, when the newest run shown starts.`
          : acc.hours > 0 && acc.hours < 24 ? `${acc.hours} h: the day reaches back before ${fmtValid(acc.start, this.zone)}, when the newest run shown starts.` : ""
        : "",
      this.gap ? `Totals stop at ${fmtValid(this.gap.reach, this.zone)}: ${this.gapText(this.gap)}.` : "",
    ].filter(Boolean).join(" ");
    // Precipitation names its period, and a total where it starts: "total snowfall (10:1) since …"
    const what = s.view === "precip"
      ? fieldName(s, acc?.hours).toLowerCase() + (acc?.period === "total" && acc.hours ? ` since ${fmtValid(acc.start, this.zone)}` : "")
      : this.item.label.toLowerCase();
    const run = (name: string, src: Source | null) =>
      src ? `${name} · init ${fmtTime(parseRunId(src.run))} · ${fhrLabel(src.fhr)}` : `${name} · no run reaches this time`;
    const side = s.mode === "compare" && s.compareView === "side";
    if (!covered && !side) {
      $("title").textContent = `${this.cfg.name} ${what} | valid ${times.valid} | not in the ${times.init} run`;
    } else if (s.mode !== "compare") {
      $("title").textContent = v.title(s.mode, s.variable, times);
    } else if (s.compareView === "diff") {
      $("title").textContent =
        `${this.cfg.name} minus ${bName}: ${what} | valid ${times.valid} | ` +
        `${this.cfg.name} ${times.init} ${times.fhr}${older ? `, ${bName} ${fmtTime(parseRunId(older.run))} ${fhrLabel(older.fhr)}` : ""}`;
    } else {
      $("title").textContent = `${this.cfg.name} vs ${bName}: ${what} | valid ${times.valid}`;
      $("title-a").textContent = covered
        ? run(this.cfg.name, { product: this.product, run: pair.currentRun, fhr: pair.currentFhr })
        : `${this.cfg.name} · its ${times.init} run doesn't reach this time`;
      $("title-b").textContent = run(bName, b);
    }
  }

  private redraw(p: Panel): void {
    if (p.rendered && !(p === this.b && $("panel-b").hidden)) this.drawScene(p);
  }

  private drawScene(p: Panel): void {
    const r = p.rendered!;
    const s = this.state;
    const inputs: ViewInputs = {
      grid: p.grid,
      focus: this.region.parent ? this.region.box : null,
      mode: r.mode,
      variable: s.variable,
      overlays: new Set(s.overlays),
      isotachs: s.isotachs,
      limitMode: s.limitMode,
      pair: r.pair,
      cur: r.cur,
      old: r.old,
      sides: r.sides,
      precipType: r.precipType,
      acc: r.acc,
      units: this.display.units,
      memo: <T,>(key: string, make: () => T): T => {
        const k = r.prefix + key;
        if (this.memo.has(k)) return this.memo.get(k) as T;
        const v = make();
        this.memo.set(k, v);
        if (this.memo.size > 300) this.memo.delete(this.memo.keys().next().value!);
        return v;
      },
    };
    const primary = p === this.a;
    if (r.frame === "no-frame") {
      p.scene = null;
      p.map.draw({ raster: null, layers: [] });
      if (primary) $("stats").innerHTML = "";
    } else {
      const scene = r.view.scene(inputs);
      p.scene = scene;
      p.map.draw(scene);
    }
    this.renderLegend();
    this.renderStats();
    if (primary) {
      window.__wxtrend!.last = {
        product: this.cfg.id, view: r.view.id, mode: s.mode, variable: s.variable, period: s.period, run: r.pair.currentRun, fhr: r.pair.currentFhr,
        lag: s.lag, frame: r.frame, region: s.region, layers: p.scene?.layers.map((l) => l.kind) ?? [],
        colorbar: p.scene?.colorbar.kind ?? null,
      };
    }
  }

  /**
   * The colorbar is the left map's, except that side by side with one model
   * that has precipitation type and one that doesn't, the legend shows the
   * types plus a grey row named for the model without.
   */
  private renderLegend(): void {
    // Side by side with the left map empty, the right map's colorbar
    const a = this.a.scene ?? ($("panel-b").hidden ? null : this.b.scene);
    if (!a) {
      $("colorbar").replaceChildren();
      $("cb-caption").textContent = "";
      return;
    }
    let spec = a.colorbar;
    const b = $("panel-b").hidden ? null : this.b.scene;
    if (b && spec.kind === "precip" && b.colorbar.kind === "precip" && !!spec.untyped !== !!b.colorbar.untyped) {
      const name = spec.untyped ? this.cfg.name : productById(this.compareId)!.name;
      spec = { kind: "precip", untypedModel: name };
    }
    renderColorbar($("colorbar"), spec);
    $("cb-caption").textContent = a.caption;
  }

  /** Stats for the map, or for each map side by side. */
  private renderStats(): void {
    const side = !$("panel-b").hidden;
    const block = (title: string | null, scene: Scene | null) =>
      (title ? `<div class="stats-head">${title}</div>` : "") + (scene?.stats.map(statHtml).join("") ?? "");
    $("stats").innerHTML = side
      ? block(this.cfg.name, this.a.scene) + block(this.compareId ? productById(this.compareId)!.name : "", this.b.scene)
      : block(null, this.a.scene);
  }

  /** Warm the cache for neighbouring hours of every source so stepping is instant. */
  /**
   * Warm the frames around this one: four steps each way, or after a fast
   * scrub the whole run (as many steps as the cache holds). Nearest first in
   * the queue; touched farthest first, so the nearest stay newest in the cache.
   */
  private preload(cur: Source, curIds: string[], older: Source | null, oldIds: string[], b: Source | null, bIds: string[]): void {
    const { step, min, max } = this.hours;
    const perStep = curIds.length + (older ? oldIds.length : 0) + (b ? bIds.length : 0);
    const whole = this.wholeRun === this.viewKey();
    const reach = whole ? Math.floor((FRAME_CAPACITY * 0.6) / Math.max(1, perStep)) : 8;
    const steps: number[] = [];
    for (let d = -Math.ceil((cur.fhr - min) / step); cur.fhr + d * step <= max; d++) {
      if (d !== 0 && (whole || Math.abs(d) <= 4)) steps.push(d);
    }
    steps.sort((x, y) => Math.abs(x) - Math.abs(y) || y - x);
    for (const d of steps.slice(0, reach).reverse()) {
      for (const id of curIds) cur.product.frames.preload(cur.run, id, cur.fhr + d * step);
      for (const [src, ids] of [[older, oldIds], [b, bIds]] as const) {
        if (src) for (const id of ids) src.product.frames.preload(src.run, id, src.fhr + d * step);
      }
    }
  }

  // ---------------------------------------------------------------- hover

  private hover(p: Panel, e: { clientX: number; clientY: number }): void {
    p.pointer = { clientX: e.clientX, clientY: e.clientY };
    const target = this.regionUnder(p, e);
    p.map.highlight(target);
    p.wrap.classList.toggle("can-focus", !!target);
    const tip = p.tooltip;
    const box = p.wrap.getBoundingClientRect();
    const x = e.clientX - box.left, y = e.clientY - box.top;
    const at = p.scene ? p.map.sampleAt(x, y) : null;
    if (!at || !p.scene) {
      tip.hidden = true;
      return;
    }
    const g = p.grid;
    const gi = at.k % g.nx, gj = Math.floor(at.k / g.nx);
    const rows: Row[] = p.scene.readout(at.k);
    tip.innerHTML =
      `<div class="tt-head">${fmtLatLon(at.lat, at.lon, 2)}</div>` +
      rows.map((r) => `<div><span>${r.label}</span><b class="${r.cls ?? ""}">${r.value}</b></div>`).join("") +
      `<div class="tt-foot">grid point ${fmtLatLon(g.lat0 + gj * g.dlat, g.lon0 + gi * g.dlon, 2)}</div>`;
    tip.hidden = false;
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    const left = x + 16 + tw > box.width ? x - 16 - tw : x + 16;
    const top = y + 16 + th > box.height ? y - 16 - th : y + 16;
    tip.style.transform = `translate(${Math.max(0, left)}px, ${Math.max(0, top)}px)`;
  }
}

// ------------------------------------------------------------------ helpers

/** Four steps by hand within this many ms (five or more a second) are a scrub, not stepping through. */
const FAST_STEPS_MS = 600;

/** How long a loop holds its last frame before starting over. */
const LOOP_HOLD_MS = 1500;

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, Math.max(0, ms)));

function statHtml(r: Row): string {
  return `<div><span>${r.label}</span><b class="${r.cls ?? ""}">${r.value}</b>${r.sub ? `<em>${r.sub}</em>` : ""}</div>`;
}

function showBanner(notice: Notice | null, info: boolean): void {
  const b = $("banner");
  b.hidden = !notice;
  b.classList.toggle("info", !!notice && info);
  if (!notice) {
    b.replaceChildren();
    return;
  }
  const text = document.createElement("span");
  text.textContent = notice.text;
  b.replaceChildren(text);
  if (notice.action) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = notice.action.label;
    btn.addEventListener("click", notice.action.onClick);
    b.appendChild(btn);
  }
}

function reason(r: PromiseSettledResult<unknown> | undefined): string {
  if (!r || r.status === "fulfilled") return "not loaded";
  const e = r.reason;
  if (e instanceof FrameUnavailable) return e.message;
  return errText(e);
}

function segmented(host: HTMLElement, options: { value: string; label: string }[]): void {
  const same = host.children.length === options.length &&
    options.every((o, i) => (host.children[i] as HTMLElement).dataset.value === o.value && host.children[i].textContent === o.label);
  if (same) return; // keep focus on a control that didn't change
  host.replaceChildren(
    ...options.map((o) => {
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "radio");
      b.dataset.value = o.value;
      b.textContent = o.label;
      return b;
    }),
  );
}

/** Replace a select's options, unless they're unchanged (keeps focus and the open list). */
function fillSelect(host: HTMLElement, options: { value: string; label: string }[]): void {
  const sel = host as HTMLSelectElement;
  const same = sel.options.length === options.length &&
    options.every((o, i) => sel.options[i].value === o.value && sel.options[i].text === o.label);
  if (same) return;
  sel.replaceChildren(...options.map((o) => new Option(o.label, o.value)));
}

function setPressed(host: HTMLElement, value: string): void {
  for (const b of host.querySelectorAll<HTMLButtonElement>("button")) {
    const on = b.dataset.value === value;
    b.setAttribute("aria-checked", String(on));
    b.tabIndex = on ? 0 : -1;
  }
}

/**
 * On phones the timeline and the sheet buttons are pinned to the bottom; keep
 * the page's end (the footer) clear of them at whatever height they wrap to.
 */
function reservePinnedSpace(): void {
  const app = $("app");
  const pinned = [document.querySelector<HTMLElement>(".timeline"), document.querySelector<HTMLElement>(".dock")]
    .filter((e): e is HTMLElement => !!e);
  const measure = () => {
    const tops = pinned.filter((e) => getComputedStyle(e).position === "fixed").map((e) => e.getBoundingClientRect().top);
    const h = tops.length ? window.innerHeight - Math.min(...tops) : 0;
    app.style.setProperty("--pinned-h", `${Math.ceil(h)}px`);
  };
  const ro = new ResizeObserver(measure);
  for (const e of pinned) ro.observe(e);
  window.addEventListener("resize", measure);
  measure();
}

// Phone layout: Fields and Options are bottom sheets
function openSheet(id: "fields" | "options"): void {
  closeSheets();
  $(id).classList.add("open");
  $("backdrop").hidden = false;
}

/** Close any open sheet; true if one was open. */
function closeSheets(): boolean {
  const open = document.querySelectorAll(".sheet.open");
  for (const s of open) s.classList.remove("open");
  $("backdrop").hidden = true;
  return open.length > 0;
}

const LAST_VIEW_KEY = "rtr:last-view";

/**
 * A bare runtorunwx.com opens the visitor's last view, or the 500 mb forecast
 * over Mainland US the first time. Links with parameters open as they say.
 */
function startingSearch(): string {
  if (location.search && location.search !== "?") return location.search;
  return storedView();
}

function storedView(): string {
  try {
    return localStorage.getItem(LAST_VIEW_KEY) || FIRST_VISIT;
  } catch {
    return FIRST_VISIT;
  }
}

async function main(): Promise<void> {
  // A presentation link opens the layout over the visitor's last view
  const present = parsePresent(location.search);
  const search = present ? storedView() : startingSearch();
  const state = parseState(search);
  let notice: Notice | null = null;
  try {
    // Every manifest up front: the model bar shows only models that output the field
    const results = await Promise.allSettled(config.products.map(loadProduct));
    const products = new Map<string, Product>();
    const failed = new Map<string, string>();
    results.forEach((r, i) => {
      const id = config.products[i].id;
      if (r.status === "fulfilled") products.set(id, r.value);
      else failed.set(id, errText(r.reason));
    });
    if (!products.has(state.product)) {
      // A product that hasn't published yet shouldn't take the site down
      const fallback = products.has(DEFAULT_PRODUCT) ? DEFAULT_PRODUCT : [...products.keys()][0];
      if (!fallback || state.product === DEFAULT_PRODUCT) throw new Error(failed.get(state.product) ?? "no data");
      const name = productById(state.product)!.name;
      notice = { text: `${name} data couldn't be loaded (${failed.get(state.product)}); showing ${productById(fallback)!.name}.`, clearOn: "any" };
      state.product = fallback;
      state.run = null;
    }
    const app = new App(state, products, failed, notice, new URLSearchParams(search).has("var"));
    if (present) app.present(present);
  } catch (err) {
    const app = $("app");
    app.dataset.state = "error";
    $("title").textContent = "Could not load data";
    const b = $("banner");
    b.hidden = false;
    const msg = errText(err);
    b.textContent = msg === "no processed runs yet" ? "No processed runs yet. Run the pipeline (make data) and reload." : msg;
  }
}

void main();
