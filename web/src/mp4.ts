// MP4 encoding for presentation exports: H.264 from WebCodecs, muxed by
// Mediabunny. Imported only when someone exports, so the site never loads it.
import { BufferTarget, CanvasSource, Mp4OutputFormat, Output, QUALITY_HIGH } from "mediabunny";

export interface Mp4Writer {
  /** Encode the canvas as it is now, for `frames` output frames. */
  add(frames: number): Promise<void>;
  /** Finish the file. */
  finish(): Promise<Blob>;
  cancel(): Promise<void>;
}

/** An MP4 at a constant `fps` from whatever `canvas` shows when `add` is called. */
export async function mp4Writer(canvas: HTMLCanvasElement, fps: number): Promise<Mp4Writer> {
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target: new BufferTarget() });
  const source = new CanvasSource(canvas, { codec: "avc", quality: QUALITY_HIGH });
  output.addVideoTrack(source, { frameRate: fps });
  await output.start();
  let n = 0;
  return {
    async add(frames) {
      for (let i = 0; i < frames; i++, n++) await source.add(n / fps, 1 / fps);
    },
    async finish() {
      await output.finalize();
      return new Blob([output.target.buffer!], { type: "video/mp4" });
    },
    async cancel() {
      await output.cancel();
    },
  };
}
