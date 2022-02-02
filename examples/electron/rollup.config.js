import resolve from 'rollup-plugin-node-resolve';
import sourcemaps from 'rollup-plugin-sourcemaps';
import commonjs from '@rollup/plugin-commonjs';

export default {
    input: './dist/webapp.js',
    output: {
        file: './dist/bundle.js',
        format: 'umd',
        sourcemap: true,
        name: 'webapp'
    },
    plugins: [
        resolve(),
        commonjs(),
        sourcemaps()
    ]
};