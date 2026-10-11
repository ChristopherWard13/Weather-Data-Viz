/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Where the data lives: one directory per product (`<base><product>/manifest.json`).
   * Production sets it in .env.production (R2); unset, it is ./data/ next to the
   * page, which the dev and preview servers serve from the repo's data/.
   */
  readonly VITE_DATA_BASE?: string;
}
