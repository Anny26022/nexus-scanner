/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL: string;
  readonly VITE_USE_MOCK: string;
  /** Absolute origin of the scanner's published data; empty means this page's origin. */
  readonly VITE_SCANNER_DATA_ORIGIN?: string;
  /** Absolute origin of the scanner's AI Worker; empty means this page's origin. */
  readonly VITE_SCANNER_API_ORIGIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
