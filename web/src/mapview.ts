import { geoGraticule, geoPath, type GeoProjection } from "d3-geo";
import { buildLookup, domainAspect, fitProjection, type Lookup } from "./projection";
import { shadeDelta, shadeFlat } from "./raster";
import { buildLut } from "./colormap";
import { clipToDomain, drawBasemap, drawDomainOutline } from "./basemap";
import { drawIsotachs, type IsoLine } from "./isotachs";
import type { Grid } from "./types";

export interface Scene {
  delta: Int16Array | null;
  limit: number;
  isotachs: IsoLine[];
}

const OUTSIDE_FILL = "#e9ecf0";
const UNAVAILABLE_RGBA: [number, number, number, number] = [236, 237, 240, 255];

/**
 * The map canvas. Shading is computed at CSS-pixel resolution (the data are
 * ~25 km, so finer pixels add nothing) and scaled up; vector layers are drawn
 * at device resolution so lines and labels stay sharp.
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
  private lut = buildLut();
  private aspect: number;
  private last: Scene | null = null;

  constructor(private wrap: HTMLElement, private canvas: HTMLCanvasElement, private grid: Grid) {
    this.ctx = canvas.getContext("2d")!;
    this.aspect = domainAspect(grid);
  }

  /** Fit the canvas to its container; returns true if the size changed. */
  resize(): boolean {
    const width = Math.max(280, Math.floor(this.wrap.clientWidth));
    const maxH = Math.max(300, window.innerHeight - 250);
    const height = Math.min(Math.round(width / this.aspect), maxH);
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    if (width === this.width && height === this.height && dpr === this.dpr) return false;
    this.width = width;
    this.height = height;
    this.dpr = dpr;

    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;

    this.proj = fitProjection(this.grid, width, height, 10);
    this.lookup = buildLookup(this.proj, this.grid, width, height);
    this.raster.width = width;
    this.raster.height = height;
    this.image = this.rasterCtx.createImageData(width, height);
    this.drawBaseLayer();
    if (this.last) this.draw(this.last);
    return true;
  }

  invert(x: number, y: number): [number, number] | null {
    return this.proj.invert!([x, y]);
  }

  inDomain(x: number, y: number): boolean {
    const px = Math.floor(x), py = Math.floor(y);
    if (px < 0 || py < 0 || px >= this.width || py >= this.height) return false;
    return this.lookup.index[py * this.width + px] >= 0;
  }

  draw(scene: Scene): void {
    this.last = scene;
    const { ctx, width, height, dpr } = this;

    if (scene.delta) {
      shadeDelta(this.image.data, this.lookup, scene.delta, this.grid.nx, scene.limit, this.lut);
    } else {
      shadeFlat(this.image.data, this.lookup, UNAVAILABLE_RGBA);
    }
    this.rasterCtx.putImageData(this.image, 0, 0);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = OUTSIDE_FILL;
    ctx.fillRect(0, 0, width, height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(this.raster, 0, 0, width, height);

    if (!scene.delta) this.hatchDomain();

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.base, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    if (scene.isotachs.length) {
      ctx.save();
      clipToDomain(ctx, this.proj, this.grid);
      drawIsotachs(ctx, this.proj, scene.isotachs, width, height);
      ctx.restore();
    }
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
    const grat = geoGraticule()
      .extent([[g.lon_min, g.lat_min], [g.lon_max + 1e-6, g.lat_max + 1e-6]])
      .step([10, 10])
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
