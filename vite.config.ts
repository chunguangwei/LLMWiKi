import path from "path"
import { readFileSync } from "fs"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

const host = process.env.TAURI_DEV_HOST

// Read version from package.json at config-load time so the Settings
// UI can show the running app version without duplicating the string.
const pkgJson = JSON.parse(readFileSync(path.resolve(__dirname, "package.json"), "utf-8"))

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],

  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },

  define: {
    __APP_VERSION__: JSON.stringify(pkgJson.version),
  },

  build: {
    // Production chunk split. The default rollup output bundled
    // everything into a single ~1.7 MB index-*.js, which delays the
    // first paint while the parser munches through libraries the
    // user might not need until they navigate into a specific view
    // (math rendering, graph view, editor). Pulling them into
    // separate chunks lets the main entry stay small and lazy
    // routes pull in their dependencies on demand.
    //
    // Heuristic: name chunks by their dominant package. Each bucket
    // corresponds to one user-visible feature so a chunk only loads
    // when the user uses the feature.
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (!id.includes("/node_modules/")) return undefined
          if (id.includes("/katex/") || id.includes("/rehype-katex/")) {
            return "vendor-katex"
          }
          if (id.includes("/mermaid/") || id.includes("/@mermaid-js/")) {
            return "vendor-mermaid"
          }
          if (id.includes("/cytoscape")) {
            return "vendor-cytoscape"
          }
          if (id.includes("/@milkdown/") || id.includes("/prosemirror-")) {
            return "vendor-editor"
          }
          if (
            id.includes("/react-markdown/") ||
            id.includes("/remark-") ||
            id.includes("/rehype-") ||
            id.includes("/unified/") ||
            id.includes("/mdast-") ||
            id.includes("/hast-") ||
            id.includes("/micromark")
          ) {
            return "vendor-markdown"
          }
          if (
            id.includes("/react/") ||
            id.includes("/react-dom/") ||
            id.includes("/scheduler/")
          ) {
            return "vendor-react"
          }
          // Catch-all vendor bundle for small libs — they stay
          // cacheable across releases as a group.
          return "vendor"
        },
      },
    },
    sourcemap: false,
    chunkSizeWarningLimit: 700,
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },

  test: {
    environment: "node",
    // Loads .env.test.local into process.env for real-LLM tests.
    // The loader itself is a no-op if the file is absent, so this is
    // safe to keep on for every test run.
    setupFiles: ["./src/test-helpers/load-test-env.ts"],
  },
}))
