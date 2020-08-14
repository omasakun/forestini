import * as BS from "browser-sync";
import { spawn } from "child_process";
import * as chokidar from "chokidar";
import * as glob from "glob";
import { tmpdir } from "os";
import { join, normalize, relative, resolve } from "path";
import { performance } from "perf_hooks";
import { cwd } from "process";
import { captureOutputStreams, clearConsole, clearDir, cp, date, debounce, error, filterUndefined, InterleavedStreams, invalid, isSameFS, isStringArray, mkdirp, mkdirpSync, mkdtempIn, never, oneAtATime, onExit, padZero, Placeholder, PropContext, rmSync, uniq } from "./util";

//#region Builder
export class Builder {
	private tasks: TaskInstance[] = []
	private frozen = false;
	constructor(private config?: Partial<Config>) { }
	task(deps: TaskNode[], task: Task): TaskNode {
		if (deps.some(o => o._builder !== this, this)) invalid();
		if (this.tasks.some(o => o.task === task)) invalid();
		const instance = new TaskInstance(task, deps.map(o => o._instance), this.tasks.length);
		const node = new TaskNode(this, instance);
		this.tasks.push(instance);
		return node;
	}
	freeze(): Runner {
		if (this.frozen) invalid();
		this.frozen = true;
		return new Runner(this.tasks, this.config);
	}

	src(...args: Parameters<typeof src>) {
		return this.task([], src(...args));
	}
	merge(deps: TaskNode[], ...args: Parameters<typeof merge>) {
		return this.task(deps, merge(...args));
	}
	asyncBuild(deps: TaskNode[], ...args: Parameters<typeof customBuild>) {
		return this.task(deps, customBuild(...args));
	}
}
class TaskNode {
	constructor(public _builder: Builder, public _instance: TaskInstance) { }
	then(task: Task): TaskNode {
		return this._builder.task([this], task);
	}
	if(condition: boolean, task: Task): TaskNode {
		if (condition) return this.then(task);
		else return this;
	}

	dest(...args: Parameters<typeof dest>) {
		return this.then(dest(...args));
	}
	cache(...args: Parameters<typeof cache>) {
		return this.then(cache(...args));
	}
	filterFiles(...args: Parameters<typeof filterFiles>) {
		return this.then(filterFiles(...args));
	}
	browserSync(...args: Parameters<typeof browserSync>) {
		return this.then(browserSync(...args));
	}
	asyncBuild(...args: Parameters<typeof customBuild>) {
		return this.then(customBuild(...args));
	}
}
//#endregion
//#region Runner
class Runner {
	private isRunning = false;
	config: Config
	/** @param tasks topologically sorted DAG */
	constructor(private tasks: TaskInstance[], config?: Partial<Config>) {
		this.config = { tmpDir: tmpdir(), watchDebounce: 100, ...config };
	}
	dotGraph(): string {
		// TODO: according to graphviz.org, layout engines may apply additional escape sequences.
		const name = (o: TaskInstance) => o.task.displayName.replace(/"/g, '\\"');
		const id = (o: TaskInstance) => "task" + padZero(o.i, this.tasks.length);
		return [
			"strict digraph {",
			...this.tasks.map(o => `\t${id(o)}[label="${name(o)}"];`),
			...this.tasks.flatMap(o1 => o1.deps.map(o2 => `\t${id(o2)} -> ${id(o1)};`)),
			"}"
		].join("\n");
	}
	async clear(): Promise<void> {
		await Promise.all(this.tasks.map(o => o.task.clear?.()));
	}
	async build(): Promise<void> {
		if (this.isRunning) error("The Forestini is already running");
		this.isRunning = true;

		console.log(`\u001b[m\u001b[35m\u001b[7m START \u001b[m ${date()}`);
		const { dispose, rootDir } = await this.prepareTaskNodes();
		const { cancel } = onExit(() => dispose());
		await this.runTaskNodes(rootDir);
		cancel();
		dispose();
		console.log(`\u001b[m\u001b[35m\u001b[7m DONE  \u001b[m ${date()}`);

		this.isRunning = false;
	}
	async watch(): Promise<void> {
		if (this.isRunning) error("The Forestini is already running");
		this.isRunning = true;

		const { dispose, rootDir } = await this.prepareTaskNodes();

		let isFirstRun = true;
		let rebuild = debounce(oneAtATime(async (updates: TaskInstance[]) => {
			if (isFirstRun) isFirstRun = false;
			else clearConsole();

			console.log(`\u001b[m\u001b[35m\u001b[7m START \u001b[m ${date()}`);
			this.makeDependentsWaiting(updates);
			await this.runTaskNodes(rootDir);
			console.log(`\u001b[m\u001b[35m\u001b[7m DONE  \u001b[m ${date()}`);
		}), this.config.watchDebounce);

		await this.beginWatching(task => rebuild([task]));
		onExit(() => dispose());
		rebuild([]);

		// this.running = false; // watch task is continuing
	}

	private async prepareTaskNodes() {
		const rootDir = await mkdtempIn(this.config.tmpDir);
		this.tasks.forEach(o => {
			o.state = "WAITING";
			o.outDir = undefined;
		});
		const dispose = () => rmSync(rootDir);
		return { dispose, rootDir };
	}
	private async runTaskNodes(rootDir: string) {
		if (this.tasks.every(o => o.isDone())) return;

		const promises: Promise<void>[] = [];
		this.tasks.forEach(o => {
			if (!o.isWaiting()) return;
			if (o.deps.some(o => o.isError())) {
				o.state = "REJECTED";
				taskReporter(o, "ERR_SKIPPED");
				return;
			}
			if (!o.task.volatile && o.deps.every(o => o.isNotChanged())) {
				o.state = "NOCHANGE";
				taskReporter(o, "SKIPPED");
				return;
			}
			if (o.deps.every(o => o.isDone())) {
				o.state = "PENDING";
				const inDirs = o.deps.map(o => o.outDir);
				const getDir = (name: string) => this.getDirForTask(rootDir, o, name);
				const args: BuildArgs = { inDirs, getDir };
				const build = async () => {
					o.outDir = undefined; // TODO: should it be preserved?
					const { streams, res } = await o.run(args);
					if (res.ok) {
						const { outDir, notChanged } = res.res;
						o.outDir = outDir;
						o.state = notChanged ? "NOCHANGE" : "RESOLVED";
						taskReporter(o, "OK", res.time, streams);
					} else {
						o.state = "REJECTED";
						taskReporter(o, "ERR", res.time, streams);
					}
					await this.runTaskNodes(rootDir); // note: since promises are asynchronous, stack overflow will not occur
				};
				promises.push(build());
			}
		});

		await Promise.all(promises);
	}
	private makeDependentsWaiting(o: TaskInstance[]) {
		o.forEach(o => o.state = "WAITING");
		this.tasks.forEach(o => {
			if (o.deps.some(o => o.isWaiting())) {
				o.state = "WAITING";
			}
		});
	}
	private beginWatching(cb: (o: TaskInstance) => void): Promise<void> {
		return Promise.all(this.tasks.map(o => o.task.watch?.(() => cb(o)))).then();
	}
	private getDirForTask(rootDir: string, task: TaskInstance, name: string): string {
		const basename = `${padZero(task.i, this.tasks.length)}-${task.task.name}-${name.toLowerCase()}`;
		const path = normalize(join(rootDir, basename));
		mkdirpSync(path);
		return path;
	}
}
interface Config {
	tmpDir: string
	watchDebounce: number
}
type TaskState = "WAITING" | "PENDING" | "RESOLVED" | "REJECTED" | "NOCHANGE"
class TaskInstance {
	state: TaskState = "WAITING"
	outDir?: string
	constructor(public task: Task, public deps: TaskInstance[], readonly i: number) { }
	isWaiting(): boolean { return this.state === "WAITING" }
	isRunning(): boolean { return this.state === "PENDING" }
	isError(): boolean { return this.state === "REJECTED" }
	isNotChanged(): boolean { return this.state === "NOCHANGE" }
	isDone(): boolean { return this.state === "RESOLVED" || this.state === "REJECTED" || this.state === "NOCHANGE" }
	isReady(): boolean { return this.deps.every(o => o.isDone()) || this.deps.some(o => o.isError()) }
	run(args: BuildArgs) {
		return captureOutputStreams<{ res: BuildResult, ok: true, time: number } | { ok: false, time: number }>(async () => {
			const start = performance.now();
			try {
				const res = await this.task.build(args);
				const time = performance.now() - start;
				return { res, ok: true, time };
			} catch (e) {
				console.error(e);
				const time = performance.now() - start;
				return { ok: false, time };
			}
		});
	}
}
type ExecResult = "OK" | "ERR" | "SKIPPED" | "ERR_SKIPPED";
function taskReporter(node: TaskInstance, execResult: ExecResult, duration_ms = 0, outputs?: InterleavedStreams) {
	const color = (() => {
		switch (execResult) {
			case "OK": return "\u001b[32m";
			case "ERR": return "\u001b[31m";
			case "SKIPPED": return "\u001b[33m";
			case "ERR_SKIPPED": return "\u001b[33m";
			default: never(execResult);
		}
	})();
	const status = (() => {
		switch (execResult) {
			case "OK": return "done";
			case "ERR": return "error";
			case "SKIPPED": return "skipped";
			case "ERR_SKIPPED": return "skipped (due to error)";
			default: never(execResult);
		}
	})();

	const header = `\u001b[m${color}\u001b[1m[ ${node.task.displayName} ]\u001b[m`;
	console.log(`${header} ${(duration_ms / 1000).toFixed(3)}s ${status}`);
	if (outputs) outputs.output();
}
//#endregion
//#region Task
interface Task {
	name: string
	displayName: string
	volatile: boolean
	clear?(): Promise<void>
	watch?(cb: () => void): Promise<void>
	build(args: BuildArgs): Promise<BuildResult>
}
interface BuildArgs {
	inDirs: (string | undefined)[]
	getDir(name: string): string
	// raw: {
	// stdout: typeof process.stdout
	// stderr: typeof process.stderr
	// }
}
interface BuildResult {
	outDir?: string
	notChanged: boolean
}
function task(opts: Partial<Task> & Pick<Task, "name" | "build">): Task {
	return { displayName: opts.name, volatile: false, ...opts };
}
interface EasyTask {
	displayName?: string
	volatile?: boolean
	clear?(): Promise<void>
	watch?(cb: () => void): Promise<void>
	build(args: EasyBuildArgs): Promise<EasyBuildResult>
}
interface OptionalDisplayName {
	displayName?: string
}
function easyTask(name: string, config: EasyTask, opts?: OptionalDisplayName): Task {
	const build = easyBuild(config.build);
	return { name, displayName: opts?.displayName ?? name, volatile: false, ...config, build };
}
interface EasyBuildArgs {
	getInDirs(): (string | undefined)[]
	getValidInDirs(): string[]
	getOutDir(): string
	getCacheDir(name?: string): string
	/** inDirs: `i0`, `i1`, `i2`, ... / outDir: `o` / cacheDir: name with the prefix `c` */
	dir: { [name: string]: string }
	// raw: BuildArgs["raw"] & { console: Console }
}
interface EasyBuildResult {
	notChanged?: boolean
}
const buildDirContext = new PropContext<string>();
export const buildDirPlaceholders = buildDirContext.getPlaceholderMaker();
function easyBuild(fn: (args: EasyBuildArgs) => Promise<EasyBuildResult>): Task["build"] {
	return async ({ inDirs, getDir }) => {
		let hasOutDir = false;
		let hasGetInDirsCalled = false;
		let usedInDirs: number[] = [];
		// const raw: EasyBuildArgs["raw"] = { console: new Console(stdout, stderr), stdout, stderr };
		const getInDirs = () => { hasGetInDirsCalled = true; return inDirs };
		const getValidInDirs = () => filterUndefined(getInDirs());
		const getOutDir = () => { hasOutDir = true; return getDir("out") };
		const getCacheDir = (name?: string) => getDir(name ? `cache-${name}` : "cache");
		buildDirContext.setGetter(name => {
			if (name === "o") return getOutDir();
			if (name.startsWith("i")) {
				const i = parseInt(name.substr(1), 10);
				if (isNaN(i)) invalid();
				const path = inDirs[i];
				if (typeof path !== "string") invalid();
				usedInDirs.push(i);
				return path;
			}
			if (name.startsWith("c")) {
				return getCacheDir(name.substr(1));
			}
			invalid();
		})
		const dir = buildDirContext.getObject();
		const result = await fn({ getInDirs, getValidInDirs, getOutDir, getCacheDir, dir });
		buildDirContext.clearGetter();
		if (!hasGetInDirsCalled && uniq(usedInDirs).length !== inDirs.filter(o => typeof o === "string").length) {
			console.warn("some inDirs were not used");
		}
		const outDir = hasOutDir ? getOutDir() : undefined;
		const notChanged = result.notChanged ?? false;
		return { outDir, notChanged };
	}
}
//#endregion
//#region Impl of Tasks
export function src(path: string, opts?: OptionalDisplayName) {
	return task({
		name: "src",
		displayName: opts?.displayName ?? `src (${relative(cwd(), path)})`,
		volatile: true,
		build: async () => ({ notChanged: false, outDir: normalize(path) }),
		watch: async cb => { chokidar.watch(normalize(path), { disableGlobbing: true, ignoreInitial: true }).on("all", () => cb()) },
	});
}
export function dest(path: string, opts?: OptionalDisplayName) {
	return easyTask("dest", {
		displayName: `dest (${relative(cwd(), path)})`,
		async clear() {
			await mkdirp(path);
			await clearDir(path);
		},
		async build({ getValidInDirs }) {
			await mkdirp(path);
			await clearDir(path);
			await Promise.all(getValidInDirs().map(o => cp(o!, path)));
			return {};
		},
	}, opts);
}
export function cache(opts?: OptionalDisplayName) {
	return easyTask("cache", {
		async build({ dir: { i0, o } }) {
			const notChanged = await isSameFS(i0, o); // TODO: what happens if inDirs[0] is modified while isSameFS is running?
			if (!notChanged) {
				await clearDir(o);
				await cp(i0, o);
			}
			return { notChanged };
		}
	}, opts);
}
export function merge(opts?: { pairs?: { from?: string, to?: string }[] } & OptionalDisplayName) {
	return easyTask("merge", {
		async build({ getInDirs, getOutDir }) {
			const inDirs = getInDirs(), o = getOutDir();
			const pairs = opts?.pairs;
			if (pairs && pairs.length !== inDirs.length) invalid();
			if (!isStringArray(inDirs)) invalid();
			await clearDir(o);
			if (!pairs) await Promise.all(inDirs.map(i => cp(i, o)));
			else await Promise.all(inDirs.map((inDir, i) => cp(join(inDir, pairs[i].from ?? ""), join(o, pairs[i].to ?? ""))));
			return {};
		}
	}, opts);
}
export function filterFiles(pattern: string, opts?: OptionalDisplayName) {
	return easyTask("filter", {
		async build({ dir: { i0, o } }) {
			await clearDir(o);
			const paths: string[] = await new Promise((res, rej) => glob(pattern, { cwd: i0, nodir: true, nomount: true }, (err, o) => err ? rej(err) : res(o)));
			await Promise.all(paths.map(i => cp(join(i0, i), join(o, i))));
			return {};
		}
	}, opts); // TODO: filter directories
}
export function browserSync(opts?: OptionalDisplayName & BS.Options) {
	let bs: BS.BrowserSyncInstance | undefined; // assumption: `watch` only be called once at most
	return easyTask("browserSync", {
		watch: async () => { bs = BS.create(); },
		async build({ dir: { i0 } }) {
			if (bs) {
				if (!bs.active) {
					await new Promise((res, rej) => bs!.init({ server: i0, ...opts }, err => err ? rej(err) : res()));
				}
				bs.reload();
			}
			return { notChanged: true };
		},
	}, opts);
}
//#endregion
//#region Impl of Highly Configurable Tasks (also related to `buildDirContext`)
/** placeholders will be resolved using `buildDirContext` */
export function path(literals: TemplateStringsArray, ...placeholders: (string | string[] | Placeholder<string>)[]): string {
	let paths: string[] = [];
	for (let i = 0; i < literals.length; i++) {
		paths.push(literals[i]);
		const ph = placeholders[i];
		if (typeof ph === "string") {
			paths.push(ph);
		} else if (typeof ph === "function") {
			paths.push(buildDirContext.resolvePlaceholder(ph));
		} else if (ph) {
			paths.push(...ph);
		}
	}
	return resolve(join(...paths));
}
/** @param build use `buildDirPlaceholder` to get directories */
export function customBuild(build: () => Promise<void>, opts?: Pick<ExecOption, "displayName" | "volatile">) {
	return easyTask("asyncBuild", { volatile: opts?.volatile, build: () => build().then(() => ({})) }, opts);
}
/** placeholders will be resolved using `buildDirContext` */
function cmdParser(literals: TemplateStringsArray, ...placeholders: (string | string[] | Placeholder<string>)[]): string[] {
	let parts: string[] = [];
	let wasPlaceholder = false, joinNext = false;
	for (let i = 0; i < literals.length; i++) {
		let l = literals[i], ls = l.trim().split(" ");
		if (l === l.trimLeft() && i !== 0) {
			if (!wasPlaceholder) invalid();
			const last = parts.length - 1;
			parts[last] = join(parts[last], ls[0]);
			ls.shift();
		}
		wasPlaceholder = false;
		joinNext = l === l.trimRight();
		parts.push(...ls);

		const ph = placeholders[i];
		if (typeof ph === "function") {
			if (joinNext) {
				const last = parts.length - 1;
				parts[last] = join(parts[last], buildDirContext.resolvePlaceholder(ph));
			} else {
				parts.push(buildDirContext.resolvePlaceholder(ph));
			}
			wasPlaceholder = true;
		} else {
			if (joinNext && typeof ph !== "undefined") invalid();
			if (typeof ph === "string") {
				parts.push(ph);
			} else if (ph) {
				parts.push(...ph);
			}
		}
	}
	return parts;
}
interface ExecOption extends OptionalDisplayName {
	volatile?: boolean
	persistentOutput?: boolean
	neverFails?: boolean
}
/** placeholders will be resolved using `buildDirContext` */
export function exec(opts: ExecOption = {}) {
	return (literals: TemplateStringsArray, ...placeholders: (string | string[] | Placeholder<string>)[]) =>
		easyTask("exec", {
			volatile: opts.volatile,
			async build(args) {
				const parts = cmdParser(literals, ...placeholders);
				if (opts.persistentOutput !== true) await clearDir(args.getOutDir());
				const cp = await spawn(parts[0], parts.slice(1), { windowsHide: true });
				cp.stdout.on("data", data => process.stdout.write(data));
				cp.stderr.on("data", data => process.stderr.write(data));
				try {
					await new Promise((res, rej) => cp.on("close", code => code === 0 ? res() : rej(`exit with code ${code}`)));
				} catch (e) {
					if (opts.neverFails === true) console.error(e);
					else throw e;
				}
				return {};
			}
		}, opts);
}
//#endregion
