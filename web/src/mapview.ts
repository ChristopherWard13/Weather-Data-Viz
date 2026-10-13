import { geoGraticule, geoPath, type GeoProjection } from "d3-geo";
import { buildLookup, domainAspect, fitProjection, nearestGridPoint, type Lookup } from "./projection";
import { shadeFlat, shadePrecip, shadeScalar } from "./raster";
import { PRECIP_DRY, rgbaOf } from "./palettes";
import { clipToDomain, drawBasemap, drawDomainOutline, traceRegion } from "./basemap";
import { drawContours } from "./contours";
import { drawBarbs } from "./barbs";
import { drawLabels } from "./labels";
import type { Layer, Marker, RasterSpec } from "./views/types";
import type { Grid } from "./types";
import type { Box } from "./config";

export interface MapScene {
  raster: RasterSpec;
  layers: Layer[];
}

const DRY_RGBA = rgbaOf(PRECIP_DRY);

const OUTSIDE_FILL = "#e9ecf0";
const UNAVAILABLE_RGBA: [number, number, number, number] = [236, 237, 240, 255];

/**
 * The map canvas. Shading is computed at CSS-pixel resolution (the data are
 * ~25 km, so finer pixels add nothing) and scaled up; vector layers are drawn
 * at device resolution so lines and labels stay sharp.
 *
 * Focusing a region refits the projection to its box. The canvas keeps its
 * size and the frames are the same, so nothing is fetched again.
 *
 * Without a `wrap` the map is offscreen (a presentation slot, an export):
 * `setSize` gives its size in layout pixels and how many canvas pixels each
 * one gets. Lines, labels and spacing are set in layout pixels, so a smaller
 * layout size on the same canvas draws everything larger.
 */
export class MapView {
  private ctx: CanvasRenderingContext2D;
  private width = 0;
  private height = 0;
  private dpr = 1;
  private proj!: GeoProjection;
  private lookup!: Lookup;
  private raster = document.createElement("canvas");
  private rasterCtx = this.raster.getContext("2d")!;
  private image!: ImageData;
  private base = document.createElement("canvas");
  private aspect: number;
  private last: MapScene | null = null;
  private focus: Box | null = null;
  /** Transparent canvas over the map for the hovered region's outline. */
  private hoverLayer = document.createElement("canvas");
  private hovered: string | null = null;
  /** Cities and state abbreviations over the map. */
  private labels = true;

  constructor(private wrap: HTMLElement | null, private canvas: HTMLCanvasElement, private grid: Grid) {
    this.ctx = canvas.getContext("2d")!;
    this.aspect = domainAspect(grid);
    if (wrap) {
      this.hoverLayer.className = "hover-layer";
      this.hoverLayer.setAttribute("aria-hidden", "true");
      canvas.after(this.hoverLayer);
    }
  }

  /** Remove the canvases this view added (when a new grid replaces it). */
  dispose(): void {
    this.hoverLayer.remove();
  }

  /** Fit the projection to a region's box, or to the whole grid (null). */
  setFocus(box: Box | null): void {
    const same = box === this.focus || (!!box && !!this.focus && box.lat.join() === this.focus.lat.join() && box.lon.join() === this.focus.lon.join());
    this.focus = box;
    if (same || !this.width) return;
    this.refit();
    if (this.last) this.draw(this.last);
  }

  get labelsOn(): boolean {
    return this.labels;
  }

  /** Show or hide the cities and state abbreviations. */
  setLabels(on: boolean): void {
    if (on === this.labels) return;
    this.labels = on;
    if (this.last && this.width) this.draw(this.last);
  }

  /** Degrees of longitude the view is fit to: its region's box, or the whole grid. */
  private get span(): number {
    return this.focus ? this.focus.lon[1] - this.focus.lon[0] : this.grid.lon_max - this.grid.lon_min;
  }

  /** Canvas position (CSS pixels) of a lon/lat. */
  toScreen(lon: number, lat: number): [number, number] | null {
    return this.proj([lon, lat]);
  }

  /** Outline a region under the pointer (null clears it). */
  highlight(region: string | null): void {
    if (region === this.hovered) return;
    this.hovered = region;
    this.drawHover();
  }

  /** Fit the canvas to its container; returns true if the size changed. */
  resize(): boolean {
    if (!this.wrap) return false;
    const width = Math.max(280, Math.floor(this.wrap.clientWidth));
    const maxH = Math.max(300, window.innerHeight - 250);
    const height = Math.min(Math.round(width / this.aspect), maxH);
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    if (!this.setSize(width, height, dpr)) return false;
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.hoverLayer.width = this.canvas.width;
    this.hoverLayer.height = this.canvas.height;
    this.hoverLayer.style.width = `${width}px`;
    this.hoverLayer.style.height = `${height}px`;
    this.drawHover();
    return true;
  }

  /**
   * Size the map: `width` × `height` layout pixels, `ratio` canvas pixels
   * each. Returns true if anything changed (and redraws the last scene).
   */
  setSize(width: number, height: number, ratio: number): boolean {
    if (!this.applySize(width, height, ratio)) return false;
    this.refit();
    if (this.last) this.draw(this.last);
    return true;
  }

  /**
   * An offscreen map's focus and size at once, refit only if either changed
   * and not drawn: the caller draws its scene next.
   */
  configure(focus: Box | null, width: number, height: number, ratio: number): void {
    const sameFocus = focus === this.focus || (!!focus && !!this.focus && focus.lat.join() === this.focus.lat.join() && focus.lon.join() === this.focus.lon.join());
    this.focus = focus;
    if (this.applySize(width, height, ratio) || !sameFocus) this.refit();
  }

  private applySize(width: number, height: number, ratio: number): boolean {
    width = Math.max(1, Math.round(width));
    height = Math.max(1, Math.round(height));
    if (width === this.width && height === this.height && ratio === this.dpr) return false;
    this.width = width;
    this.height = height;
    this.dpr = ratio;
    this.canvas.width = Math.round(width * ratio);
    this.canvas.height = Math.round(height * ratio);
    this.raster.width = width;
    this.raster.height = height;
    this.image = this.rasterCtx.createImageData(width, height);
    return true;
  }

  get gridId(): string {
    return this.grid.id;
  }

  /** The canvas the map draws on (for composing it into a frame). */
  get element(): HTMLCanvasElement {
    return this.canvas;
  }

  /** Projection, pixel lookup and static layers for the current size and focus. */
  private refit(): void {
    const { width, height } = this;
    this.proj = fitProjection(this.grid, width, height, 10, this.focus);
    this.lookup = buildLookup(this.proj, this.grid, width, height);
    this.drawBaseLayer();
    this.drawHover();
  }

  private drawHover(): void {
    if (!this.wrap) return;
    const ctx = this.hoverLayer.getContext("2d")!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.hoverLayer.width, this.hoverLayer.height);
    if (!this.hovered || !this.proj) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.save();
    traceRegion(ctx, this.proj, this.hovered);
    ctx.fillStyle = "rgba(255, 255, 255, 0.16)";
    ctx.fill("evenodd");
    ctx.lineJoin = "round";
    ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.strokeStyle = "#0f172a";
    ctx.lineWidth = 1.8;
    ctx.stroke();
    ctx.restore();
  }

  invert(x: number, y: number): [number, number] | null {
    return this.proj.invert!([x, y]);
  }

  inDomain(x: number, y: number): boolean {
    const px = Math.floor(x), py = Math.floor(y);
    if (px < 0 || py < 0 || px >= this.width || py >= this.height) return false;
    return this.lookup.index[py * this.width + px] >= 0;
  }

  /** Nearest grid point under a canvas pixel, or null outside the domain. */
  sampleAt(x: number, y: number): { k: number; lon: number; lat: number } | null {
    if (!this.inDomain(x, y)) return null;
    const ll = this.invert(x, y);
    const gp = ll && nearestGridPoint(this.grid, ll[0], ll[1]);
    return gp ? { k: gp.j * this.grid.nx + gp.i, lon: ll[0], lat: ll[1] } : null;
  }

  draw(scene: MapScene): void {
    this.last = scene;
    const { ctx, width, height, dpr } = this;
    const r = scene.raster;
    if (r?.kind === "scalar") shadeScalar(this.image.data, this.lookup, r.values, this.grid.nx, r.lut);
    else if (r?.kind === "precip") shadePrecip(this.image.data, this.lookup, r.qpf, r.ptype, this.grid.nx, DRY_RGBA);
    else shadeFlat(this.image.data, this.lookup, UNAVAILABLE_RGBA);
    this.rasterCtx.putImageData(this.image, 0, 0);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = OUTSIDE_FILL;
    ctx.fillRect(0, 0, width, height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(this.raster, 0, 0, width, height);

    if (!r) this.hatchDomain();

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.base, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.save();
    clipToDomain(ctx, this.proj, this.grid);
    for (const layer of scene.layers) {
      if (layer.kind === "contours") {
        drawContours(ctx, this.proj, layer.lines, layer.style, width, height, layer.arrows);
      } else if (layer.kind === "barbs") {
        drawBarbs(ctx, this.proj, (x, y) => this.sampleAt(x, y), layer.field, width, height, layer.spacing, layer.color);
      } else {
        this.drawMarkers(layer.items);
      }
    }
    // A phone-width map gets slightly smaller labels, so a few more fit
    if (this.labels) drawLabels(ctx, this.proj, width, height, this.span, width < 520 ? 0.85 : 1);
    ctx.restore();
  }

  private drawMarkers(items: Marker[]): void {
    const { ctx } = this;
    const big = Math.max(13, Math.min(20, this.width / 50));
    const small = Math.max(8.5, big * 0.52);
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    for (const m of items) {
      const p = this.proj([m.lon, m.lat]);
      if (!p) continue;
      const color = m.kind === "H" ? "#1d4ed8" : "#b91c1c";
      ctx.font = `800 ${big}px ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif`;
      ctx.lineWidth = 4;
      ctx.strokeStyle = "rgba(255,255,255,0.92)";
      ctx.strokeText(m.kind, p[0], p[1] - big * 0.2);
      ctx.fillStyle = color;
      ctx.fillText(m.kind, p[0], p[1] - big * 0.2);
      ctx.font = `700 ${small}px ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif`;
      ctx.lineWidth = 3;
      const label = m.value.toFixed(0);
      ctx.strokeText(label, p[0], p[1] + big * 0.55);
      ctx.fillText(label, p[0], p[1] + big * 0.55);
    }
    ctx.restore();
  }

  /** Static layers (graticule, coastlines, borders, outline), cached per size. */
  private drawBaseLayer(): void {
    const { width, height, dpr } = this;
    this.base.width = Math.round(width * dpr);
    this.base.height = Math.round(height * dpr);
    const ctx = this.base.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const g = this.grid;

    // Map context outside the domain, faded.
    ctx.save();
    ctx.globalAlpha = 0.4;
    drawBasemap(ctx, this.proj);
    ctx.restore();

    ctx.save();
    clipToDomain(ctx, this.proj, g);
    ctx.clearRect(0, 0, width, height);
    const step = this.focus ? 5 : 10;
    const grat = geoGraticule()
      .extent([[g.lon_min, g.lat_min], [g.lon_max + 1e-6, g.lat_max + 1e-6]])
      .step([step, step])
      .precision(1);
    ctx.beginPath();
    geoPath(this.proj, ctx)(grat());
    ctx.strokeStyle = "rgba(0, 0, 0, 0.13)";
    ctx.lineWidth = 0.6;
    ctx.setLineDash([3, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
    drawBasemap(ctx, this.proj);
    ctx.restore();
    drawDomainOutline(ctx, this.proj, g);
  }

  private hatchDomain(): void {
    const { ctx, width, height } = this;
    ctx.save();
    clipToDomain(ctx, this.proj, this.grid);
    ctx.strokeStyle = "rgba(100, 110, 125, 0.18)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = -height; x < width; x += 10) {
      ctx.moveTo(x, height);
      ctx.lineTo(x + height, 0);
    }
    ctx.stroke();
    ctx.restore();
  }
}
