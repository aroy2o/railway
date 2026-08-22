/// <reference types="vite/client" />

/**
 * Types for this app's own VITE_* variables, merged into Vite's built-in
 * ImportMetaEnv so `import.meta.env.VITE_API_BASE_URL` is checked rather than
 * being an untyped `any`. Keep in sync with the frontend block of .env.example.
 */
interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string
  readonly VITE_PROTOTYPE_BANNER?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
