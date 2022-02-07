import resolve from 'rollup-plugin-node-resolve';
import sourcemaps from 'rollup-plugin-sourcemaps';

export default {
    input: './dist/esm/index.js',
    output: {
        file: './dist/super-rpc.umd.js',
        format: 'umd',
        sourcemap: true,
        name: 'superrpc'
    },
    plugins: [
        resolve(),
        sourcemaps()
    ]
};