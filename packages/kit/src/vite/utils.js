import fs from 'fs';
import path from 'path';
import { loadConfigFromFile, loadEnv, normalizePath } from 'vite';
import { get_runtime_directory } from '../core/utils.js';

/**
 * @param {import('vite').ResolvedConfig} config
 * @param {import('vite').ConfigEnv} config_env
 * @return {Promise<import('vite').UserConfig>}
 */
export async function get_vite_config(config, config_env) {
	const loaded = await loadConfigFromFile(
		config_env,
		config.configFile,
		undefined,
		config.logLevel
	);

	if (!loaded) {
		throw new Error('Could not load Vite config');
	}
	return { ...loaded.config, mode: config_env.mode };
}

/**
 * @param {...import('vite').UserConfig} configs
 * @returns {import('vite').UserConfig}
 */
export function merge_vite_configs(...configs) {
	return deep_merge(
		...configs.map((config) => ({
			...config,
			resolve: {
				...config.resolve,
				alias: normalize_alias(config.resolve?.alias || {})
			}
		}))
	);
}

/**
 * Takes zero or more objects and returns a new object that has all the values
 * deeply merged together. None of the original objects will be mutated at any
 * level, and the returned object will have no references to the original
 * objects at any depth. If there's a conflict the last one wins, except for
 * arrays which will be combined.
 * @param {...Object} objects
 * @returns {Record<string, any>} the merged object
 */
export function deep_merge(...objects) {
	const result = {};
	/** @type {string[]} */
	objects.forEach((o) => merge_into(result, o));
	return result;
}

/**
 * normalize kit.vite.resolve.alias as an array
 * @param {import('vite').AliasOptions} o
 * @returns {import('vite').Alias[]}
 */
function normalize_alias(o) {
	if (Array.isArray(o)) return o;
	return Object.entries(o).map(([find, replacement]) => ({ find, replacement }));
}

/**
 * Merges b into a, recursively, mutating a.
 * @param {Record<string, any>} a
 * @param {Record<string, any>} b
 */
function merge_into(a, b) {
	/**
	 * Checks for "plain old Javascript object", typically made as an object
	 * literal. Excludes Arrays and built-in types like Buffer.
	 * @param {any} x
	 */
	const is_plain_object = (x) => typeof x === 'object' && x.constructor === Object;

	for (const prop in b) {
		if (is_plain_object(b[prop])) {
			if (!is_plain_object(a[prop])) {
				a[prop] = {};
			}
			merge_into(a[prop], b[prop]);
		} else if (Array.isArray(b[prop])) {
			if (!Array.isArray(a[prop])) {
				a[prop] = [];
			}
			a[prop].push(...b[prop]);
		} else {
			a[prop] = b[prop];
		}
	}
}

/** @param {import('types').ValidatedKitConfig} config */
export function get_aliases(config) {
	/** @type {Record<string, string>} */
	const alias = {
		__GENERATED__: path.posix.join(config.outDir, 'generated'),

		$app: `${get_runtime_directory(config)}/app`,

		// For now, we handle `$lib` specially here rather than make it a default value for
		// `config.kit.alias` since it has special meaning for packaging, etc.
		$lib: config.files.lib
	};

	if (!process.env.BUNDLED) {
		alias['$env/static/public'] = path.posix.join(config.outDir, 'runtime/env/static/public.js');
		alias['$env/static/private'] = path.posix.join(config.outDir, 'runtime/env/static/private.js');
	}

	alias['$env'] = `${get_runtime_directory(config)}/env`;

	for (const [key, value] of Object.entries(config.alias)) {
		alias[key] = path.resolve(value);
	}

	return alias;
}

/**
 * Given an entry point like [cwd]/src/hooks, returns a filename like [cwd]/src/hooks.js or [cwd]/src/hooks/index.js
 * @param {string} entry
 * @returns {string|null}
 */
export function resolve_entry(entry) {
	if (fs.existsSync(entry)) {
		const stats = fs.statSync(entry);
		if (stats.isDirectory()) {
			return resolve_entry(path.join(entry, 'index'));
		}

		return entry;
	} else {
		const dir = path.dirname(entry);

		if (fs.existsSync(dir)) {
			const base = path.basename(entry);
			const files = fs.readdirSync(dir);

			const found = files.find((file) => file.replace(/\.[^.]+$/, '') === base);

			if (found) return path.join(dir, found);
		}
	}

	return null;
}

/**
 * @param {string} str
 * @param {number} times
 */
function repeat(str, times) {
	return new Array(times + 1).join(str);
}

/**
 * Create a formatted error for an illegal import.
 * @param {Array<{name: string, dynamic: boolean}>} stack
 * @param {string} out_dir The directory specified by config.kit.outDir
 */
function format_illegal_import_chain(stack, out_dir) {
	const app = path.join(out_dir, 'runtime/env');

	stack = stack.map((file) => {
		if (file.name.startsWith(app)) return { ...file, name: file.name.replace(app, '$env') };
		return { ...file, name: path.relative(process.cwd(), file.name) };
	});

	const pyramid = stack
		.map(
			(file, i) =>
				`${repeat(' ', i * 2)}- ${file.name} ${
					file.dynamic ? '(imported by parent dynamically)' : ''
				}`
		)
		.join('\n');

	return `Cannot import ${stack.at(-1)?.name} into client-side code:\n${pyramid}`;
}

/**
 * Load environment variables from process.env and .env files
 * @param {string} mode
 * @param {string} prefix
 */
export function get_env(mode, prefix) {
	const entries = Object.entries(loadEnv(mode, process.cwd(), ''));

	return {
		public: Object.fromEntries(entries.filter(([k]) => k.startsWith(prefix))),
		private: Object.fromEntries(entries.filter(([k]) => !k.startsWith(prefix)))
	};
}

/**
 * @param {(id: string) => import('rollup').ModuleInfo | null} node_getter
 * @param {import('rollup').ModuleInfo} node
 * @param {Set<string>} illegal_imports Illegal module IDs -- be sure to call vite.normalizePath!
 * @param {string} out_dir The directory specified by config.kit.outDir
 */
export function prevent_illegal_rollup_imports(node_getter, node, illegal_imports, out_dir) {
	const chain = find_illegal_rollup_imports(node_getter, node, false, illegal_imports);
	if (chain) throw new Error(format_illegal_import_chain(chain, out_dir));
}

/**
 * @param {(id: string) => import('rollup').ModuleInfo | null} node_getter
 * @param {import('rollup').ModuleInfo} node
 * @param {boolean} dynamic
 * @param {Set<string>} illegal_imports Illegal module IDs -- be sure to call vite.normalizePath!
 * @param {Set<string>} seen
 * @returns {Array<import('types').ImportNode> | null}
 */
const find_illegal_rollup_imports = (
	node_getter,
	node,
	dynamic,
	illegal_imports,
	seen = new Set()
) => {
	const name = normalizePath(node.id);
	if (seen.has(name)) return null;
	seen.add(name);

	if (illegal_imports.has(name)) {
		return [{ name, dynamic }];
	}

	for (const id of node.importedIds) {
		const child = node_getter(id);
		const chain =
			child && find_illegal_rollup_imports(node_getter, child, false, illegal_imports, seen);
		if (chain) return [{ name, dynamic }, ...chain];
	}

	for (const id of node.dynamicallyImportedIds) {
		const child = node_getter(id);
		const chain =
			child && find_illegal_rollup_imports(node_getter, child, true, illegal_imports, seen);
		if (chain) return [{ name, dynamic }, ...chain];
	}

	seen.delete(name);
	return null;
};

/**
 * Vite does some weird things with import trees in dev
 * for example, a Tailwind app.css will appear to import
 * every file in the project. This isn't a problem for
 * Rollup during build.
 * @param {Iterable<string>} config_module_types
 */
const get_module_types = (config_module_types) => {
	return new Set([
		'.ts',
		'.js',
		'.svelte',
		'.mts',
		'.mjs',
		'.cts',
		'.cjs',
		'.svelte.md',
		'.svx',
		'.md',
		...config_module_types
	]);
};

/**
 * Throw an error if a private module is imported from a client-side node.
 * @param {import('vite').ModuleNode} node
 * @param {Set<string>} illegal_imports Illegal module IDs -- be sure to call vite.normalizePath!
 * @param {Iterable<string>} module_types File extensions to analyze in addition to the defaults: `.ts`, `.js`, etc.
 * @param {string} out_dir The directory specified by config.kit.outDir
 */
export function prevent_illegal_vite_imports(node, illegal_imports, module_types, out_dir) {
	const chain = find_illegal_vite_imports(node, illegal_imports, get_module_types(module_types));
	if (chain) throw new Error(format_illegal_import_chain(chain, out_dir));
}

/**
 * @param {import('vite').ModuleNode} node
 * @param {Set<string>} illegal_imports Illegal module IDs -- be sure to call vite.normalizePath!
 * @param {Set<string>} module_types File extensions to analyze: `.ts`, `.js`, etc.
 * @param {Set<string>} seen
 * @returns {Array<import('types').ImportNode> | null}
 */
function find_illegal_vite_imports(node, illegal_imports, module_types, seen = new Set()) {
	if (!node.id) return null; // TODO when does this happen?
	const name = normalizePath(node.id);

	if (seen.has(name) || !module_types.has(path.extname(name))) return null;
	seen.add(name);

	if (name && illegal_imports.has(name)) {
		return [{ name, dynamic: false }];
	}

	for (const child of node.importedModules) {
		const chain = child && find_illegal_vite_imports(child, illegal_imports, module_types, seen);
		if (chain) return [{ name, dynamic: false }, ...chain];
	}

	seen.delete(name);
	return null;
}
