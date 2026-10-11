import { describe, expect, it } from "vitest";
import { productBase } from "../src/manifest";

describe("productBase", () => {
  const page = "https://christopherward13.github.io/Weather-Data-Viz/";

  it("defaults to ./data/<product>/ next to the page", () => {
    expect(productBase(undefined, "gfs", page)).toBe("https://christopherward13.github.io/Weather-Data-Viz/data/gfs/");
    expect(productBase("", "gfs", "http://localhost:5173/")).toBe("http://localhost:5173/data/gfs/");
  });

  it("puts the product under an absolute data base, with or without a trailing slash", () => {
    for (const base of ["https://pub-x.r2.dev/", "https://pub-x.r2.dev"]) {
      expect(productBase(base, "nam-conus", page)).toBe("https://pub-x.r2.dev/nam-conus/");
    }
  });

  it("resolves the manifest and frames inside the product directory", () => {
    const base = productBase("https://data.example/", "gfs", page);
    expect(new URL("manifest.json", base).toString()).toBe("https://data.example/gfs/manifest.json");
    expect(new URL("runs/2026100900/t2m/f006.bin.gz", base).toString()).toBe(
      "https://data.example/gfs/runs/2026100900/t2m/f006.bin.gz",
    );
  });
});
