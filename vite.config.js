import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// L'entrée est index.html (UI legacy portée). Le plugin React est prêt pour
// la Phase 2 (refactorisation progressive en composants).
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, open: true },
});
