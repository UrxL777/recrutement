import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Configuration du site : React pour les pages, Tailwind pour le style
export default defineConfig({
  plugins: [react(), tailwindcss()],
})
