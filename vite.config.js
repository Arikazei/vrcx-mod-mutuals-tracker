import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// Baut den Mod als einzelnes ESM-Bundle. 'vue' bleibt external und wird zur
// Laufzeit ueber die Import-Map des Loaders auf dessen Vue-Kopie aufgeloest -
// so teilen sich Loader und alle Mods eine einzige Vue-Instanz.
export default defineConfig({
    plugins: [vue()],
    build: {
        outDir: 'dist',
        emptyOutDir: true,
        minify: false,
        target: 'chrome145',
        cssCodeSplit: false,
        lib: {
            entry: 'src/index.js',
            formats: ['es'],
            fileName: () => 'bundle.js'
        },
        rollupOptions: {
            external: ['vue'],
            output: {
                assetFileNames: 'style.css'
            }
        }
    }
});
