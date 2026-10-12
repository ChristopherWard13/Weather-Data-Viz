import "./styles.css";
import {
  config, DEFAULT_PRODUCT, gridCovers, productById, regionById,
  type ProductConfig, type RegionConfig,
} from "./config";
import { loadManifest, productBase } from "./manifest";
import { FrameCache, FrameUnavailable } from "./frames";
import { pairFor, type FramePair } from "./alignment";
import { MapView } from "./mapview";
import { regionAt } from "./basemap";
import { renderColorbar } from "./colorbar";
import { parseState, serializeState, viewDefaults, type ViewPrefs, type ViewState } from "./state";
import { addHours, fhrLabel, fmtShort, fmtStamp, fmtTime, parseRunId } from "./time";
import { fmtLatLon } from "./views/util";
import { FIELD_ITEMS, fieldItem, viewById, type FieldItem } from "./views";
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
    };
  }
}

interface Notice {
  text: string;
  /** "run": stays until the run changes; "any": cleared by the next change. */
  clearOn: "run" | "any";
  action?: { label: string; onClick: () => void };
}

/** A product with its manifest and frame cache, loaded once per page. */
interface Product {
  cfg: ProductConfig;
  manifest: Manifest;
  frames: FrameCache;
}

/** A run and hour of some product: where a map's frames come from. */
interface Source {
  product: Product;
  run: string;
  fhr: number;
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
    this.grid = grid;
    this.map = new MapView(this.wrap, this.canvas, grid);
  }
}

function productUrl(id: string): string {
  return productBase(import.meta.env.VITE_DATA_BASE, id, document.baseURI);
}

async function loadProduct(cfg: ProductConfig): Promise<Product> {
  const manifest = await loadManifest(productUrl(cfg.id));
  if (!manifest.latest || manifest.runs.length === 0) throw new Error("no processed runs yet");
  return { cfg, manifest, frames: new FrameCache(manifest, productUrl(cfg.id)) };
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const cycleLabel = (run: string) => `${run.slice(8, 10)}Z`;

class App {
  private prefs = new Map<ViewId, ViewPrefs>();
  private memo = new Map<string, unknown>();
  private token = 0;
  private notice: Notice | null = null;
  private a: Panel;
  private b: Panel;
  private product: Product;
  private playing: number | null = null;

  constructor(
    private state: ViewState,
    private products: Map<string, Product>,
    private failed: Map<string, string>,
    notice: Notice | null,
  ) {
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
        action: { label: "Show latest", onClick: () => this.set({ run: null }) },
      };
    }
    this.a = new Panel($("map-wrap"), $("map") as HTMLCanvasElement, $("tooltip"), manifest.grid);
    this.b = new Panel($("map-wrap-b"), $("map-b") as HTMLCanvasElement, $("tooltip-b"), manifest.grid);
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
    this.applyFocus();
    this.bindEvents();
    for (const p of [this.a, this.b]) {
      new ResizeObserver(() => {
        if (p.map.resize()) this.redraw(p);
      }).observe(p.wrap);
    }
    this.a.map.resize();
    this.update();
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
    const s = this.state;
    if (s.mode === "compare") return s.compareView === "diff" ? "trend" : "fcst";
    return s.mode;
  }

  /** The product's displayed hours, from its manifest. */
  private hoursOf(p: Product): { min: number; max: number; step: number } {
    const h = p.manifest.display_hours;
    return { min: h[0], max: h[h.length - 1], step: p.cfg.fhr.step };
  }

  private get hours() {
    return this.hoursOf(this.product);
  }

  private get valid(): Date {
    return addHours(parseRunId(this.run), this.state.fhr);
  }

  // ---------------------------------------------------------------- models

  /** Why a product can't show the selected field in the focused region, or null if it can. */
  private hiddenReason(id: string, item = this.item, region = this.region): string | null {
    if (this.failed.has(id)) return "data couldn't be loaded";
    const p = this.products.get(id)!;
    if (!item.fields.every((f) => f in p.manifest.fields)) return `no ${item.short} output`;
    if (!gridCovers(p.cfg.grid, region.box)) return `doesn't cover ${region.label}`;
    return null;
  }

  /** Products that output the field and cover the region, in model-bar order. */
  private usable(item = this.item, region = this.region): string[] {
    return config.products.map((p) => p.id).filter((id) => !this.hiddenReason(id, item, region));
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
      ? `${name} doesn't output ${this.item.noun}, so this shows ${nextName}.`
      : `${name} ${why}, so this shows ${nextName}.`;
    this.switchProduct(next);
    this.notice = { text, clearOn: "any" };
  }

  /** The model compare mode puts beside the current one: the chosen one if usable, else the first usable other. */
  private get compareId(): string | null {
    const others = this.usable().filter((id) => id !== this.state.product);
    if (this.state.compare && others.includes(this.state.compare)) return this.state.compare;
    return others[0] ?? null;
  }

  /**
   * The run of `p` to show at a valid time: its newest run that starts at or
   * before it and reaches it, or null.
   */
  private sourceAt(p: Product, valid: Date): Source | null {
    const { min, max, step } = this.hoursOf(p);
    for (const r of p.manifest.runs) {
      const f = Math.round((valid.getTime() - parseRunId(r.id).getTime()) / 3600e3);
      if (f >= min && f <= max && (f - min) % step === 0) return { product: p, run: r.id, fhr: f };
    }
    return null;
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
          b.innerHTML = `<span class="mchip-name">${p.name}</span>${latest ? `<span class="mchip-run">${cycleLabel(latest)}</span>` : ""}`;
          if (latest) b.title = `${p.name}: latest run ${fmtTime(parseRunId(latest))}`;
          group.appendChild(b);
        }
        return group;
      }),
    );
    const note = document.createElement("span");
    note.className = "mnote";
    note.id = "model-note";
    bar.appendChild(note);

    $("region").replaceChildren(
      ...config.regions.map((r) => {
        const o = document.createElement("option");
        o.value = r.id;
        // Indent Mainland US's regions (option text collapses ordinary spaces)
        o.textContent = r.parent && regionById(r.parent)!.parent ? `\u00a0\u00a0\u00a0${r.label}` : r.label;
        return o;
      }),
    );

    segmented($("cmpview"), [
      { value: "side", label: "Side by side" },
      { value: "diff", label: "Difference" },
    ]);

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

    const { min, max, step } = this.hours;
    const slider = $<HTMLInputElement>("fhr");
    slider.min = String(min);
    slider.max = String(max);
    slider.step = String(step);
    const g = this.manifest.generated_at;
    $("updated").textContent = `${this.cfg.name} updated ${fmtStamp(new Date(g)).slice(11, 16)}Z`;
    $("updated").title = `${this.cfg.name} data updated ${fmtStamp(new Date(g))}`;
  }

  /** Day ticks under the scrubber, at 00Z valid times of the run shown. */
  private buildTicks(): void {
    const { min, max } = this.hours;
    const init = parseRunId(this.run);
    const ticks = $("ticks");
    ticks.replaceChildren();
    // Label every day, or every other day once the range passes 10 days
    const every = max - min > 240 ? 48 : 24;
    const first = min + ((24 - ((init.getUTCHours() + min) % 24)) % 24);
    for (let f = first; f <= max; f += every) {
      const t = addHours(init, f);
      const span = document.createElement("span");
      span.textContent = `${fmtShort(t).slice(0, 6)}`;
      span.style.left = `${((f - min) / (max - min)) * 100}%`;
      ticks.appendChild(span);
    }
  }

  /** A link's valid time (`t`) becomes an hour of the run shown, clamped with a note. */
  private resolveLinkTime(): void {
    const s = this.state;
    if (s.valid) {
      const want = Math.round((parseRunId(s.valid).getTime() - parseRunId(this.run).getTime()) / 3600e3);
      const fhr = this.fitHour(want);
      if (fhr !== want && !this.notice) {
        this.notice = {
          text: `${this.cfg.name}'s ${fmtTime(parseRunId(this.run))} run doesn't cover ${fmtTime(parseRunId(s.valid))}; showing ${fhrLabel(fhr)} instead.`,
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
    const latest = parseRunId(next.manifest.latest!);
    const want = Math.round((valid.getTime() - latest.getTime()) / 3600e3);
    const fhr = this.fitHour(want);
    if (fhr !== want) {
      this.notice = {
        text: `${next.cfg.name}'s ${fmtTime(latest)} run doesn't cover ${fmtTime(valid)}; showing ${fhrLabel(fhr)} instead.`,
        clearOn: "any",
      };
    }
    this.state.fhr = fhr;
    if (!next.cfg.lags.includes(this.state.lag)) this.state.lag = next.cfg.defaultLag;
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
    const others = this.usable().filter((id) => id !== s.product);
    // Same order for every view, whichever mode it opens in
    const modes: { value: string; label: string }[] = (["fcst", "trend"] as const)
      .filter((m) => v.modes.includes(m))
      .map((m) => ({ value: m, label: m === "fcst" ? "Forecast" : "Trend" }));
    if (others.length) modes.push({ value: "compare", label: "Compare" });
    segmented($("mode"), modes);

    const cmp = s.mode === "compare";
    $("cmp-field").hidden = !cmp;
    if (cmp) {
      segmented($("cmp"), others.map((id) => ({ value: id, label: productById(id)!.name })));
      const bId = this.compareId;
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
    const vc = config.views[v.id];
    segmented($("lim"), [
      { value: "fixed", label: `±${vc.trendLimit} ${v.trendUnit}` },
      { value: "auto", label: "Auto" },
    ]);
    const bName = cmp && this.compareId ? productById(this.compareId)!.name : null;
    const overlays = v.overlays.filter((o) => !o.modes || o.modes.includes(vm));
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

  private explain(): string {
    const s = this.state, v = this.view;
    if (s.mode !== "compare") return v.explain(s.mode, s.variable);
    const a = this.cfg.name, b = this.compareId ? productById(this.compareId)!.name : "the other model";
    if (s.compareView === "diff") {
      return `<p><strong>Shading:</strong> ${a}'s ${this.item.noun} minus ${b}'s, both valid at the same time, each from its latest run.</p>
        <p class="legend-row"><span class="sw red"></span> ${a} higher <span class="sw blue"></span> ${b} higher</p>`;
    }
    return `<p><strong>Side by side:</strong> ${a} (left) and ${b} (right), each its latest run at the same valid time.</p>` +
      v.explain("fcst", s.variable);
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
      this.set({ run: v === this.manifest.latest ? null : v });
    });
    const radio = (id: string, apply: (value: string) => void) =>
      $(id).addEventListener("click", (e) => {
        const b = (e.target as HTMLElement).closest("button");
        if (b && !b.disabled) apply(b.dataset.value!);
      });
    radio("lag", (v) => this.set({ lag: Number(v) }));
    radio("lim", (v) => this.set({ limitMode: v as ViewState["limitMode"] }));
    radio("mode", (v) => this.set({ mode: v as ViewState["mode"] }));
    radio("cmp", (v) => this.set({ compare: v }));
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
      this.set({ fhr: Number((e.target as HTMLInputElement).value) });
    });
    $("prev").addEventListener("click", () => this.step(-1));
    $("next").addEventListener("click", () => this.step(1));
    $("play").addEventListener("click", () => this.togglePlay());

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
      // Form controls (including the slider) handle their own arrow keys.
      if (["INPUT", "SELECT", "TEXTAREA"].includes((e.target as HTMLElement).tagName)) return;
      const n = Number(e.key);
      if (n >= 1 && n <= FIELD_ITEMS.length) this.setField(FIELD_ITEMS[n - 1]);
      else if (e.key === "ArrowLeft") this.step(-1);
      else if (e.key === "ArrowRight") this.step(1);
      else if (e.key === "Home") this.set({ fhr: this.hours.min });
      else if (e.key === "End") this.set({ fhr: this.hours.max });
      else if (e.key === " " && (e.target as HTMLElement).tagName !== "BUTTON") this.togglePlay();
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
    if (it.view === s.view && it.variable === s.variable) return;
    this.prefs.set(s.view, { mode: s.mode, variable: s.variable, overlays: s.overlays });
    const prefs = it.view === s.view ? { mode: s.mode, overlays: s.overlays } : { ...(this.prefs.get(it.view) ?? viewDefaults(it.view)) };
    // Compare mode carries across fields
    const mode = s.mode === "compare" ? "compare" : prefs.mode === "compare" ? viewById(it.view).defaultMode : prefs.mode;
    this.notice = null;
    this.state = { ...s, view: it.view, variable: it.variable, overlays: prefs.overlays, mode };
    this.ensureUsableProduct();
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
    if (this.state.product !== product) {
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
    const id = ll && regionAt(ll[0], ll[1]);
    return id && id !== this.state.region ? id : null;
  }

  private step(dir: number): void {
    const { min, max, step } = this.hours;
    const f = this.state.fhr + dir * step;
    if (f >= min && f <= max) this.set({ fhr: f });
  }

  private togglePlay(): void {
    if (this.playing !== null) {
      this.stopPlay();
      return;
    }
    $("play").setAttribute("aria-pressed", "true");
    this.playing = window.setInterval(() => {
      const { min, max, step } = this.hours;
      const f = this.state.fhr + step > max ? min : this.state.fhr + step;
      this.set({ fhr: f }, true);
    }, 700);
  }

  private stopPlay(): void {
    if (this.playing === null) return;
    window.clearInterval(this.playing);
    this.playing = null;
    $("play").setAttribute("aria-pressed", "false");
  }

  private set(patch: Partial<ViewState>, fromPlay = false): void {
    if (!fromPlay && !("fhr" in patch && Object.keys(patch).length === 1)) this.stopPlay();
    if (this.notice && (this.notice.clearOn === "any" || "run" in patch)) this.notice = null;
    this.state = { ...this.state, ...patch };
    this.update();
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
    $("crumbs-hint").textContent = this.region.id === "hawaii" ? "" : `${touch ? "Tap" : "Click"} a region to zoom${this.region.parent ? " · Esc to zoom out" : ""}`;

    // Links name the compared model, even when it's the default
    const url = serializeState(s.mode === "compare" ? { ...s, compare: this.compareId } : s, this.run);
    if (url !== location.search) history.replaceState(null, "", url);
    $("app").dataset.region = s.region;
  }

  /** Sync controls and URL to state, then render. */
  private update(): void {
    const s = this.state;
    // A compare partner that can't show this field: pick another, or leave compare mode
    if (s.mode === "compare" && !this.compareId) {
      s.mode = this.view.defaultMode;
      this.notice = { text: `No other model outputs ${this.item.noun} here, so there's nothing to compare.`, clearOn: "any" };
    }
    this.syncChrome();
    this.buildViewControls();
    this.buildTicks();
    setPressed($("mode"), s.mode);
    setPressed($("cmp"), this.compareId ?? "");
    setPressed($("cmpview"), s.compareView);
    $<HTMLSelectElement>("run").value = this.run;
    setPressed($("lag"), String(s.lag));
    setPressed($("lim"), s.limitMode);
    for (const b of $("iso").querySelectorAll<HTMLButtonElement>("button")) {
      b.setAttribute("aria-pressed", String(s.isotachs.includes(Number(b.dataset.value))));
    }
    const slider = $<HTMLInputElement>("fhr");
    slider.value = String(s.fhr);
    const valid = this.valid;
    slider.setAttribute("aria-valuetext", `${fmtShort(valid)} (${fhrLabel(s.fhr)})`);
    $<HTMLButtonElement>("prev").disabled = s.fhr <= this.hours.min;
    $<HTMLButtonElement>("next").disabled = s.fhr >= this.hours.max;
    $("fhr-readout").innerHTML = `<strong>${fmtShort(valid)}</strong><span>${fhrLabel(s.fhr)} · ${cycleLabel(this.run)} run</span>`;

    const pair = pairFor(parseRunId(this.run), s.fhr, s.lag);
    $("lag-hint").textContent = `${fmtTime(pair.olderInit)} at ${fhrLabel(pair.olderFhr)}`;
    document.title = `${this.cfg.name} ${this.item.label} · Run to Run Wx`;
    void this.render(pair);
  }

  // ---------------------------------------------------------------- render

  private async render(pair: FramePair): Promise<void> {
    const token = ++this.token;
    const s = this.state;
    const view = this.view;
    const vm = this.viewMode;
    const overlays = new Set(s.overlays);
    const all = view.fields(vm, s.variable, overlays);
    const cur: Source = { product: this.product, run: pair.currentRun, fhr: pair.currentFhr };
    const bProduct = s.mode === "compare" && this.compareId ? this.products.get(this.compareId)! : null;
    const bSource = bProduct && this.sourceAt(bProduct, pair.valid);
    // Where the comparison comes from: the older run (trend) or the other model (difference)
    const older: Source | null = s.mode === "trend"
      ? { product: this.product, run: pair.olderRun, fhr: pair.olderFhr }
      : vm === "trend" ? bSource : null;
    const side = s.mode === "compare" && vm === "fcst";
    const sideNeeds = side && bProduct ? view.fields("fcst", s.variable, overlays) : null;

    // Overlays from fields a product doesn't have (AIFS gust) are just left out
    const has = (p: Product) => (f: string) => f === all.primary || f in p.manifest.fields;
    const needsCur = all.current.filter(has(cur.product));
    const needsOld = older ? all.older.filter(has(older.product)) : [];
    const needsB = sideNeeds && bSource ? sideNeeds.current.filter(has(bSource.product)) : [];

    const spinner = $("spinner");
    const spinTimer = window.setTimeout(() => (spinner.hidden = false), 120);
    const load = (src: Source | null, ids: string[]) =>
      src ? Promise.allSettled(ids.map((f) => src.product.frames.get(src.run, f, src.fhr))) : Promise.resolve([]);
    const [curRes, oldRes, bRes] = await Promise.all([load(cur, needsCur), load(older, needsOld), load(bSource, needsB)]);
    window.clearTimeout(spinTimer);
    if (token !== this.token) return;
    spinner.hidden = true;

    const settle = (ids: string[], res: PromiseSettledResult<Bands>[]) =>
      Object.fromEntries(ids.map((f, i) => [f, res[i]?.status === "fulfilled" ? res[i].value : null]));
    const curBands = settle(needsCur, curRes);
    const oldBands = settle(needsOld, oldRes);
    const curFail = curRes[needsCur.indexOf(all.primary)];
    const oldFail = oldRes[needsOld.indexOf(all.primary)];

    const aName = this.cfg.name, bName = bProduct?.cfg.name ?? "";
    let frame: FrameState = vm === "trend" ? "delta" : "forecast";
    let banner: Notice | null = this.notice;
    if (!curBands[all.primary]) {
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
          text: `Comparison unavailable: ${bName} has no frame valid ${fmtTime(pair.valid)} (${older ? reason(oldFail) : "no run reaches it"}).`,
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
      prefix: `${view.id}|${key(cur)}|${key(older)}|`,
    };

    // The right-hand map in side-by-side mode
    let frameB: FrameState | null = null;
    if (side) {
      const bBands = settle(needsB, bRes);
      frameB = bBands[all.primary] ? "forecast" : "no-frame";
      const bPair = bSource ? pairFor(parseRunId(bSource.run), bSource.fhr, s.lag) : pair;
      this.b.rendered = {
        view, mode: "fcst", cur: bBands, old: {}, sides, frame: frameB, pair: bPair,
        prefix: `${view.id}|${key(bSource)}|-|`,
      };
      if (frameB === "no-frame" && frame !== "no-frame") {
        const why = bSource ? reason(bRes[needsB.indexOf(all.primary)]) : "no run reaches it";
        banner = { text: `${bName} has no frame valid ${fmtTime(pair.valid)} (${why}).`, clearOn: "any" };
      }
      if (this.b.grid.id !== bProduct!.manifest.grid.id) this.b.setGrid(bProduct!.manifest.grid);
    }
    this.layoutPanels(side, bSource);
    this.drawScene(this.a);
    if (side) this.drawScene(this.b);
    this.titles(pair, side ? bSource : null, older, bName);
    showBanner(banner, (frame === "delta" || frame === "forecast") && frameB !== "no-frame");
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

  private titles(pair: FramePair, b: Source | null, older: Source | null, bName: string): void {
    const s = this.state, v = this.view;
    const times = {
      model: this.cfg.name,
      init: fmtTime(pair.currentInit),
      older: fmtTime(pair.olderInit),
      valid: fmtTime(pair.valid),
      fhr: fhrLabel(pair.currentFhr),
    };
    const run = (name: string, src: Source | null) =>
      src ? `${name} · init ${fmtTime(parseRunId(src.run))} · ${fhrLabel(src.fhr)}` : `${name} · no run reaches this time`;
    if (s.mode !== "compare") {
      $("title").textContent = v.title(s.mode, s.variable, times);
    } else if (s.compareView === "diff") {
      $("title").textContent =
        `${this.cfg.name} minus ${bName}: ${this.item.label.toLowerCase()} | valid ${times.valid} | ` +
        `${this.cfg.name} ${times.init} ${times.fhr}${older ? `, ${bName} ${fmtTime(parseRunId(older.run))} ${fhrLabel(older.fhr)}` : ""}`;
    } else {
      $("title").textContent = `${this.cfg.name} vs ${bName}: ${this.item.label.toLowerCase()} | valid ${times.valid}`;
      $("title-a").textContent = run(this.cfg.name, { product: this.product, run: pair.currentRun, fhr: pair.currentFhr });
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
      if (primary) {
        $("colorbar").replaceChildren();
        $("cb-caption").textContent = "";
        $("stats").innerHTML = "";
      }
    } else {
      const scene = r.view.scene(inputs);
      p.scene = scene;
      p.map.draw(scene);
      if (primary) {
        renderColorbar($("colorbar"), scene.colorbar);
        $("cb-caption").textContent = scene.caption;
      }
    }
    this.renderStats();
    if (primary) {
      window.__wxtrend!.last = {
        product: this.cfg.id, view: r.view.id, mode: s.mode, variable: s.variable, run: r.pair.currentRun, fhr: r.pair.currentFhr,
        lag: s.lag, frame: r.frame, region: s.region, layers: p.scene?.layers.map((l) => l.kind) ?? [],
        colorbar: p.scene?.colorbar.kind ?? null,
      };
    }
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
  private preload(cur: Source, curIds: string[], older: Source | null, oldIds: string[], b: Source | null, bIds: string[]): void {
    const { step } = this.hours;
    for (const d of [1, -1, 2, -2]) {
      const f = cur.fhr + d * step;
      const { min, max } = this.hours;
      if (f < min || f > max) continue;
      for (const id of curIds) cur.product.frames.preload(cur.run, id, f);
      for (const src of [[older, oldIds], [b, bIds]] as const) {
        if (src[0]) for (const id of src[1]) src[0].product.frames.preload(src[0].run, id, src[0].fhr + d * step);
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

function setPressed(host: HTMLElement, value: string): void {
  for (const b of host.querySelectorAll<HTMLButtonElement>("button")) {
    const on = b.dataset.value === value;
    b.setAttribute("aria-checked", String(on));
    b.tabIndex = on ? 0 : -1;
  }
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

async function main(): Promise<void> {
  const state = parseState(location.search);
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
    new App(state, products, failed, notice);
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
