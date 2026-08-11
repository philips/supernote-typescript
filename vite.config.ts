/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['tests/**/*.test.ts'],
		environment: 'node',
		// Vitest's own default (pool: 'forks', one worker per CPU core) peaked
		// at ~1.1GB RSS across 4 worker processes measured on a 4-core/7.6GB
		// host running this suite -- each worker is a full separate Node
		// process re-loading every dependency (image-js, sql.js's WASM
		// build, pdf-lib, fontkit) from scratch. That's fine with room to
		// spare here, but has been reported to OOM on more memory-constrained
		// hosts. Switching to the 'threads' pool (workers share the engine
		// instead of each being a full separate process) and capping at 2
		// workers cut measured peak RSS to ~770MB (-32%) with no wall-time
		// cost on this same host (workers beyond 2 mostly added contention,
		// not real parallelism, once 4 processes were competing for 4 cores
		// alongside everything else already running on it) -- see issue
		// investigation for the full before/after numbers. Override with
		// `--pool=forks --maxWorkers=N` on a host where memory isn't the
		// constraint and more parallelism is worth it.
		pool: 'threads',
		maxWorkers: 2,
	},
});
