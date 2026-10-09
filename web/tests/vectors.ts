import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function loadVectors<T>(name: string): T[] {
  const url = new URL(`../../shared/test-vectors/${name}`, import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), "utf8")).cases as T[];
}
