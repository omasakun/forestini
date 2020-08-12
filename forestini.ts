import * as BS from "browser-sync";
import { spawn } from "child_process";
import * as chokidar from "chokidar";
import { Console } from "console";
import { promises as fsPromises, statSync } from "fs";
import * as ncpBase from "ncp";
import { tmpdir } from "os";
import { join, normalize, relative, sep } from "path";
import { performance } from "perf_hooks";
import { cwd } from "process";
import * as rimrafSource from "rimraf";
import { Writable } from "stream";
const { mkdir, mkdtemp, readdir, readFile, stat } = fsPromises;

// #region core

export class Forestini {
	private frozen = false
	private running = false
	private taskNodes: InternalTaskNode[] = []
	readonly tmpRoot: string;
	readonly watchDebounce: number;
	constructor(opts: { tmpRoot?: string, debounce?: number } = {}) {
		this.tmpRoot = opts.tmpRoot ?? join(tmpdir(), "forestini");
		this.watchDebounce = opts.debounce ?? 100;
	}

	task(deps: TaskNode[], task: Task): TaskNode {
		this.assertNotFrozen();

		if (!this.isRegisteredTaskNodes(deps)) {
			throw new Error("Illegal dependencies");
		}
		if (this.isRegisteredTask(task)) {
			throw new Error("Same task cannot be used more than once");
		}

		const node = new InternalTaskNode(this, task, deps);
		this.taskNodes.push(node);
		return node;
	}
	freeze(): this {
		this.assertNotFrozen();

		//   verify that taskNodes are topologically sorted
		// & verify that taskNodes have no circular dependencies
		if (!this.taskNodes.every((o, i) => o.deps.every(oo => this.node2index(oo) < i))) {
			throw new Error("BUG"); // this will never happen unless there's a bug
		}

		this.frozen = true;
		return this;
	}
	dotGraph(): string {
		this.assertFrozen();

		const escape = name => name.replace(/"/g, '\\"'); // TODO: better escaping
		// According to graphviz.org, layout engines may apply additional escape sequences.

		const lines = [
			"strict digraph {",
			...this.taskNodes.map((o, i) => `\tnode_${i}[label="${escape(o.task.displayName)}"];`),
			...this.taskNodes.flatMap((o, i) =>
				o.deps.map(o => `\tnode_${this.node2index(o)} -> node_${i};`)),
			"}"
		];
		return lines.join("\n");
	}
	async clearDest(): Promise<void> {
		this.assertFrozen();
		this.assertNotRunning();
		this.running = true;

		await Promise.all(this.taskNodes.map(o => o.task.clearDest?.()));

		this.running = false;
	}
	async build(): Promise<void> {
		this.assertFrozen();
		this.assertNotRunning();
		this.running = true;

		console.log(`\u001b[m\u001b[35m\u001b[7m START \u001b[m ${date()}`);
		const disposable = await this.prepareTaskNodes();
		await this.runTaskNodes(taskNodeReporter);
		await disposable.dispose();
		console.log(`\u001b[m\u001b[35m\u001b[7m DONE  \u001b[m ${date()}`);
		// this.taskNodes.forEach(o => console.log(o.task.name + ": " + o.state));

		this.running = false;
	}
	async watch(): Promise<void> {
		this.assertFrozen();
		this.assertNotRunning();
		this.running = true;

		const disposable = await this.prepareTaskNodes();

		let isBuilding = false;
		let updatedNodes: InternalTaskNode[] = [];
		let rebuild = debounce(async () => {
			if (isBuilding) return; // execution continues from (1) below
			isBuilding = true;
			if (updatedNodes.length !== 0) { // if it's not the first run
				// console.clear();
				process.stdout.write('\u001bc');
			}
			console.log(`\u001b[m\u001b[35m\u001b[7m START \u001b[m ${date()}`);
			this.makeDependentsWaiting(updatedNodes);
			updatedNodes = [];

			await this.runTaskNodes(taskNodeReporter);
			console.log(`\u001b[m\u001b[35m\u001b[7m DONE  \u001b[m ${date()}`);
			// this.taskNodes.forEach(o => console.log(o.task.name + ": " + o.state));

			isBuilding = false;
			if (updatedNodes.length !== 0) await rebuild(); // (1)
		}, this.watchDebounce);

		await this.beginWatching(taskNode => {
			updatedNodes.push(taskNode);
			rebuild();
		});

		["exit", "SIGINT", "SIGTERM"].forEach(type => {
			process.on(type, () => {
				// console.log(type);
				disposable.dispose();
				if (type !== "exit") process.exit(1);
			});
		});

		rebuild();

		// this.running = false; // watch task is continuing
	}

	private async prepareTaskNodes() {
		this.assertFrozen();

		await mkdir(this.tmpRoot, { recursive: true });
		const rootDir = await mkdtemp(normalize(this.tmpRoot) + sep);

		const promises: Promise<void>[] = [];
		const taskCount = this.taskNodes.length;
		this.taskNodes.forEach((o, i) => {
			const { task } = o;
			const dir = o => join(rootDir, `${padZero(i, taskCount)}-${task.name}-${o}`);
			const inDirs = o.deps.map(o => o.outDir); // assumption: taskNodes are topologically sorted
			if (!isStrings(inDirs)) throw new Error("The task does not have output");

			o.state = "WAITING";
			o.inDirs = inDirs;
			o.outDir = task.hasOutput ? dir("out") : undefined;
			o.cacheDir = task.needsCache ? dir("cache") : undefined;

			if (o.outDir) promises.push(mkdir(o.outDir));
			if (o.cacheDir) promises.push(mkdir(o.cacheDir));
		});
		await Promise.all(promises);

		return {
			disposeAsync: () => rimraf(rootDir),
			dispose: () => rimrafSync(rootDir),
		};
	}
	private async runTaskNodes(reporter: TaskNodeReporter) {
		this.assertFrozen();

		const isFinished = this.taskNodes.every(o => o.state === "REJECTED" || o.state === "RESOLVED" || o.state === "NOCHANGE");
		if (isFinished) return;

		const promises: Promise<void>[] = [];
		this.taskNodes.forEach(o => {
			if (o.state !== "WAITING") return;
			if (o.deps.some(o => o.state === "REJECTED")) {
				o.state = "REJECTED";
				reporter(o, [], 0, "ERR_SKIPPED");
				return;
			}
			if (!o.task.volatile && o.deps.every(o => o.state === "NOCHANGE")) {
				o.state = "NOCHANGE";
				reporter(o, [], 0, "SKIPPED");
				return;
			}
			if (o.deps.every(o => o.state === "RESOLVED" || o.state === "NOCHANGE")) {
				o.state = "PENDING";
				const { inDirs, outDir, cacheDir } = o;
				const streams = new InterleavedStreams();
				const { stdout, stderr } = streams;
				const console = new Console({ stdout, stderr, colorMode: true });
				const args: TaskBuildArgs = { inDirs, outDir, cacheDir, console, stderr, stdout };
				const build = async () => {
					const startTime = performance.now();
					if (o.outDir && !o.task.persistentOutput) {
						await clearDir(o.outDir);
					}
					try {
						const result = await o.task.build(args);
						if (result.notChanged === true) {
							o.state = "NOCHANGE";
						} else {
							o.state = "RESOLVED";
						}
						reporter(o, streams.outputs, performance.now() - startTime, "OK");
					} catch (e) {
						o.state = "REJECTED";
						console.error(e); // console for this task (not global one)
						reporter(o, streams.outputs, performance.now() - startTime, "ERR");
					}
					await this.runTaskNodes(reporter); // note: since promises are asynchronous, stack overflow will not occur
				};
				promises.push(build());
			}
		});

		await Promise.all(promises);
	}
	private makeDependentsWaiting(o: InternalTaskNode[]) {
		this.assertFrozen();

		o.forEach(o => o.state = "WAITING");
		this.taskNodes.forEach(o => {
			if (o.deps.some(o => o.state === "WAITING")) {
				o.state = "WAITING";
			}
		});
	}
	private async beginWatching(cb: (o: InternalTaskNode) => void): Promise<void> {
		this.assertFrozen();

		await Promise.all(this.taskNodes.map(o => o.task.beginWatching?.(o, () => cb(o))));
	}

	// #region utility
	private assertFrozen() {
		if (!this.frozen) throw new Error("The Forestini is not frozen yet");
	}
	private assertNotFrozen() {
		if (this.frozen) throw new Error("The Forestini is already frozen");
	}
	private assertNotRunning() {
		if (this.running) throw new Error("The Forestini is already running");
	}
	private isRegisteredTask(task: Task): boolean {
		return this.taskNodes.some(o => o.task === task);
	}
	private isRegisteredTaskNodes(nodes: TaskNode[]): nodes is InternalTaskNode[] {
		return nodes.every(o => this.taskNodes.some(oo => oo === o));
	}
	private node2index(node: InternalTaskNode) {
		const i = this.taskNodes.findIndex(oo => node === oo);
		if (i < 0) throw new Error("BUG");
		return i;
	}
	// #endregion
	// #region syntax sugar
	src(...args: Parameters<typeof src>) {
		return this.task([], src(...args));
	}
	dest(deps: TaskNode[], ...args: Parameters<typeof dest>) {
		return this.task(deps, dest(...args));
	}
	exec(deps: TaskNode[], ...args: Parameters<typeof exec>) {
		return this.task(deps, exec(...args));
	}
	copy(deps: TaskNode[], ...args: Parameters<typeof copy>) {
		return this.task(deps, copy(...args));
	}
	cache(deps: TaskNode[], ...args: Parameters<typeof cache>) {
		return this.task(deps, cache(...args));
	}
	browserSync(deps: TaskNode[], ...args: Parameters<typeof browserSync>) {
		return this.task(deps, browserSync(...args));
	}
	// #endregion
}

type ExecResult = "OK" | "ERR" | "SKIPPED" | "ERR_SKIPPED";
type TaskNodeReporter = (node: InternalTaskNode, outputs: StreamOutputItem[], duration_ms: number, status: ExecResult) => void;
function taskNodeReporter(node: InternalTaskNode, outputs: StreamOutputItem[], duration_ms: number, status: ExecResult) {

	let color = "";
	if (status === "OK") color = "\u001b[32m";
	else if (status === "ERR_SKIPPED" || status === "SKIPPED") color = "\u001b[33m";
	else if (status === "ERR") color = "\u001b[31m";
	else { const o: never = status; }

	let header = `\u001b[m${color}\u001b[1m[ ${node.task.displayName} ]\u001b[m`;

	let out = outputs.filter(o => o.source === "out").join("");
	let err = outputs.filter(o => o.source === "err").join("");
	const statusText: string = execResultText(status);
	console.log(`${header} ${(duration_ms / 1000).toFixed(3)}s ${statusText}`);
	// if (err !== "") process.stderr.write(header+"\n");
	outputs.forEach(o => {
		if (o.source === "out") {
			process.stdout.write(o.text);
			return;
		}
		if (o.source === "err") {
			process.stderr.write(o.text);
			return;
		}
		throw new Error("BUG");
	});
	if (out !== "" && !out.endsWith("\n")) process.stdout.write("\n");
	if (err !== "" && !err.endsWith("\n")) process.stderr.write("\n");
}
function execResultText(result: ExecResult): string {
	if (result === "ERR") return "error";
	if (result === "ERR_SKIPPED") return "skipped (due to error)";
	if (result === "SKIPPED") return "skipped";
	if (result === "OK") return "done";
	const o: never = result;
	return result;
}

class InternalTaskNode implements TaskNode {
	state: TaskState = "WAITING"

	inDirs: string[] = []
	outDir?: string
	cacheDir?: string

	constructor(
		private fo: Forestini,
		readonly task: Task,
		readonly deps: readonly InternalTaskNode[],
	) { /* do nothing */ }

	// #region syntax sugar
	then(task: Task) {
		return this.fo.task([this], task);
	}
	dest(...args: Parameters<typeof dest>) {
		return this.fo.task([this], dest(...args));
	}
	exec(...args: Parameters<typeof exec>) {
		return this.fo.task([this], exec(...args));
	}
	copy(...args: Parameters<typeof copy>) {
		return this.fo.task([this], copy(...args));
	}
	cache(...args: Parameters<typeof cache>) {
		return this.fo.task([this], cache(...args));
	}
	browserSync(...args: Parameters<typeof browserSync>) {
		return this.fo.task([this], browserSync(...args));
	}
	// #endregion
}
type TaskState = "WAITING" | "PENDING" | "RESOLVED" | "REJECTED" | "NOCHANGE"
export interface TaskNode {
	then(task: Task): TaskNode
	dest(...args: Parameters<typeof dest>): TaskNode
	exec(...args: Parameters<typeof exec>): TaskNode
	copy(...args: Parameters<typeof copy>): TaskNode
	cache(...args: Parameters<typeof cache>): TaskNode
	browserSync(...args: Parameters<typeof browserSync>): TaskNode
}
export interface TaskArgs {
	inDirs: string[]
	outDir?: string
	cacheDir?: string
}
export interface TaskBuildArgs extends TaskArgs {
	console: Console
	stdout: Writable
	stderr: Writable
}

export interface BuildResult {
	notChanged?: boolean
}
export interface Task {
	readonly name: string
	readonly displayName: string
	readonly needsCache: boolean
	readonly hasOutput: boolean
	readonly persistentOutput: boolean
	readonly volatile: boolean
	// readonly hasSideEffect: boolean // TODO: skip tasks with no side effects
	beginWatching?(args: TaskArgs, cb: () => void): Promise<void>
	build(args: TaskBuildArgs): Promise<BuildResult>
	clearDest?(): Promise<void>
}
interface TaskTemplate {
	name: string
	displayName: string
	needsCache?: boolean
	hasOutput?: boolean
	persistentOutput?: boolean
	volatile?: boolean
	beginWatching?(args: TaskArgs, cb: () => void): Promise<void>
	build?(args: TaskBuildArgs): Promise<BuildResult>
	clearDest?(): Promise<void>
}
function task(template: TaskTemplate): Task {
	const { name, displayName, needsCache, hasOutput, persistentOutput, volatile, beginWatching, build, clearDest } = template;
	return {
		name,
		displayName,
		needsCache: needsCache ?? false,
		hasOutput: hasOutput ?? true,
		persistentOutput: persistentOutput ?? false,
		volatile: volatile ?? false,
		build: build ?? (() => Promise.resolve({})),
		beginWatching,
		clearDest,
	};
}

// #endregion
// #region task

export function src(path: string, name = `src (${relative(cwd(), path)})`): Task {
	return task({
		name: "src",
		displayName: name,
		volatile: true,
		async beginWatching(args, cb) {
			chokidar.watch(path, {
				disableGlobbing: true,
				ignoreInitial: true,
			}).on("all", () => cb());
		},
		async build({ inDirs, outDir }) {
			if (inDirs.length !== 0) throw new Error("invalid");
			if (!outDir) throw new Error("BUG");
			await ncp(path, outDir, {
				clobber: false,
				dereference: true,
			}); // TODO: symlink?
			return {};
		},
	});
}

export function dest(path: string, name = `dest (${relative(cwd(), path)})`): Task {
	return task({
		name: "dest",
		displayName: name,
		hasOutput: false,
		async clearDest() {
			await clearDir(path);
		},
		async build({ inDirs, console }) {
			// if (inDirs.length === 0) throw new Error("invalid");
			await mkdir(path, { recursive: true });
			await clearDir(path);
			await Promise.all(
				inDirs.map(inDir => ncp(inDir, path, {
					clobber: false,
					dereference: true,
				}))
			);
			return {};
		},
	});
}

export function exec(cmd: ExecCommand, opts: { name?: string, needsCache?: boolean, hasOutput?: boolean, persistentOutput?: boolean, volatile?: boolean, verify?: (args: TaskArgs) => boolean } = {}): Task {
	let command: (args: TaskArgs) => string[];
	if (typeof cmd === "string") {
		command = ({ inDirs, outDir, cacheDir }: TaskArgs) => {
			let command = cmd.split(" ");
			if (inDirs.length > 1) throw new Error("BUG");
			if (inDirs.length !== 0) {
				command = command.map(o => o !== "[in]" ? o : inDirs[0]);
			}
			if (cacheDir) {
				command = command.map(o => o !== "[cache]" ? o : cacheDir);
			}
			if (outDir) {
				command = command.map(o => o !== "[out]" ? o : outDir);
			}
			return command;
		};
	} else {
		command = ({ inDirs, outDir, cacheDir }: TaskArgs) => {
			return cmd({
				i: inDirs[0], is: inDirs, inDirs,
				o: outDir, outDir,
				c: cacheDir, cacheDir,
			});
		};
	}
	// TODO: better detection
	const argsBase: TaskArgs = { inDirs: ["foo"], cacheDir: "foo", outDir: "foo" };
	const argsIn: TaskArgs = { inDirs: ["bar"], cacheDir: "foo", outDir: "foo" };
	const argsCache: TaskArgs = { inDirs: ["foo"], cacheDir: "bar", outDir: "foo" };
	const argsOut: TaskArgs = { inDirs: ["foo"], cacheDir: "foo", outDir: "bar" };
	return task({
		name: "exec",
		displayName: opts.name ?? `exec (${command(argsBase)[0]})`,
		hasOutput: opts.hasOutput ?? command(argsBase).join() !== command(argsOut).join(),
		needsCache: opts.needsCache ?? command(argsBase).join() !== command(argsCache).join(),
		persistentOutput: opts.persistentOutput ?? false,
		volatile: opts.volatile ?? false,
		async build(args) {
			if (opts.verify) {
				if (!opts.verify(args)) throw new Error("invalid");
			}
			const cmd = command(args);
			if (cmd.length < 1) throw new Error("invalid");
			// args.console.log(cmd);

			const cp = await spawn(cmd[0], cmd.slice(1), {
				windowsHide: true,
				shell: false,
				// cwd: args.outDir,
			});
			cp.stdout.on("data", data => args.stdout.write(data));
			cp.stderr.on("data", data => args.stderr.write(data));

			return new Promise((resolve, reject) => {
				cp.on("close", (code) => {
					if (code !== 0) reject(`exited with code ${code}`);
					else resolve({});
				});
			});
		},
	});
}
type ExecCommand = string | ((args: {
	i?: string, is: string[], inDirs: string[],
	o?: string, outDir?: string,
	c?: string, cacheDir?: string,
}) => string[]);

export function copy(opts: { name?: string, map?: ({ from?: string, to?: string, filter?: RegExp | ((filename: string) => boolean) } | undefined)[] } = {}): Task {
	return task({
		name: "copy",
		displayName: opts.name ?? "copy",
		async build({ inDirs, outDir }) {
			// if (inDirs.length === 0) throw new Error("invalid");
			if (!outDir) throw new Error("BUG");
			const map = opts.map;
			if (map && map.length !== inDirs.length) throw new Error("invalid");

			await Promise.all(
				inDirs.map((inDir, i) => {
					let inDirPath = inDir;
					let outDirPath = outDir;

					const from = map?.[i]?.from;
					const to = map?.[i]?.to;
					const filter = map?.[i]?.filter;
					if (from) inDirPath = join(inDirPath, from);
					if (to) outDirPath = join(outDirPath, to);
					return ncp(inDirPath, outDirPath, {
						clobber: false,
						dereference: true,
						filter: filter === undefined ? undefined : path => {
							if (statSync(path).isDirectory()) {
								return true;
							} else {
								if (typeof filter === "function") {
									return filter(path);
								} else {
									return filter.test(path);
								}
							}
						},
					});
				})
			);
			return {};
		},
	});
}

export function cache(name?: string): Task {
	return task({
		name: "cache",
		displayName: name ?? "cache",
		persistentOutput: true,
		async build({ inDirs, outDir }) {
			if (inDirs.length !== 1) throw new Error("invalid");
			if (!outDir) throw new Error("BUG");
			const notChanged = await isSameFS(inDirs[0], outDir); // TODO: what happens if inDirs[0] is modified while isSameFS is running?
			if (!notChanged) {
				await clearDir(outDir);
				await ncp(inDirs[0], outDir, { clobber: false });
			}
			return { notChanged };
		},
	});
}

export function browserSync(opts: { name?: string, config?: BS.Options } = {}): Task {
	let bs: BS.BrowserSyncInstance | undefined;
	let path: string | undefined;
	return task({
		name: "browserSync",
		displayName: opts.name ?? "browserSync",
		hasOutput: false,
		beginWatching({ inDirs }, cb) {
			if (inDirs.length !== 1) throw new Error("invalid");
			path = inDirs[0];
			bs = BS.create();
			return new Promise((res, rej) =>
				bs!.init({
					server: inDirs[0],
					...opts.config,
				}, err => {
					if (err) rej(err);
					else res();
				})
			);
		},
		async build({ inDirs }) {
			if (!bs) return {};
			if (inDirs[0] !== path) throw new Error("BUG");
			bs.reload();
			return {};
		},
	});
}

// TODO: ファイルツリー内のファイル数に応じてタスクグラフを動的に追加するとかは、複数のエントリーポイントがあるJSファイルをコンパイルするときにエントリーポイントをわざわざ列挙する手間が省けたりするから有用かも。各部分タスクの入力ファイルツリーと出力ファイルツリーをキャッシュする独自の機構を備えていて、タスクの実行時に内部でForestiniインスタンスを作ってそれにビルドさせる感じのタスクで、ファイルツリーを受け取ってビルドタスクチェーンの配列を返す関数(F)を受け取るタスクを作るのが、今の設計を維持したままで実現する簡単な方法。問題点があるとするなら、dotGraphが全体像を表示できなくなることくらいかな？まぁ、動的に追加される部分があるグラフを表示するいい方法が思いつかないからこれでもいい気はする。まぁ、(F)のドメインを制限すれば行けるだろうけど不自由になる

// #endregion
// #region utility

class InterleavedStreams {
	outputs: StreamOutputItem[] = [];
	readonly stdout: Writable;
	readonly stderr: Writable;
	constructor() {
		const self = this;
		const streamFactory = (source: "out" | "err") => new Writable({
			write(chunk: string | Buffer, encoding, cb) {
				const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
				self.outputs.push({ source, text });
				cb();
			},
			decodeStrings: false,
			defaultEncoding: "utf8",
			objectMode: false,
		});
		this.stdout = streamFactory("out");
		this.stderr = streamFactory("err");
	}
}

interface StreamOutputItem {
	source: "out" | "err"
	text: string
}

export interface Disposable {
	dispose(): void
}

export function disposable(dispose: () => void): Disposable {
	return { dispose };
}

function padZero(num: number, max: number) {
	const digits = max.toFixed(0).length;
	return num.toFixed(0).padStart(digits, "0");
}

function isStrings(arr: any): arr is string[] {
	return Array.isArray(arr) && arr.every(o => typeof o === "string");
}

function date() {
	return new Date().toISOString();
}

function debounce(fn: () => void, delay: number) {
	let timeout: NodeJS.Timeout;
	return () => {
		clearTimeout(timeout);
		timeout = setTimeout(() => {
			fn();
		}, delay);
	}
}

function rimraf(path: string, options: rimrafSource.Options = { disableGlob: true }) {
	return new Promise<void>((resolve, rejected) => {
		rimrafSource(path, options, err => {
			if (err) rejected(err);
			else resolve();
		})
	})
}

function rimrafSync(path: string, options: rimrafSource.Options = { disableGlob: true }) {
	rimrafSource.sync(path, options);
}

function ncp(src: string, dest: string, opts: ncpBase.Options = {}) {
	return new Promise((res, rej) =>
		ncpBase.ncp(src, dest, opts, err => {
			if (err) rej(err);
			else res();
		})
	);
}

async function clearDir(dir: string) {
	// console.error("clear: ", dir);
	try {
		const files = await readdir(dir);
		await Promise.all(files.map(file => rimraf(join(dir, file), { disableGlob: true })));
	} catch (e) {
		if (e.code === "ENOENT") return; // TODO: better error handling
	}
	// await rimraf(dir, { disableGlob: true });
	// await mkdir(dir);
	// TODO: `rm -rf dir/*` != `rm -r dir && mkdir dir`
}

async function isSameFS(entry1: string, entry2: string): Promise<boolean> {
	try {
		const [stat1, stat2] = await Promise.all([stat(entry1), stat(entry2)]);
		if (!stat1.isDirectory() && !stat1.isFile()) throw new Error("unexpected..."); // TODO: implement
		if (!stat2.isDirectory() && !stat2.isFile()) throw new Error("unexpected...");
		if (stat1.isFile() && stat2.isFile()) {
			const [file1, file2] = await Promise.all([readFile(entry1), readFile(entry2)]);
			return file1.equals(file2);
		} else if (stat1.isDirectory() && stat2.isDirectory()) {
			const [files1, files2] = await Promise.all([readdir(entry1), readdir(entry2)]);
			if (files1.length !== files2.length) return false;
			if (files1.length === 0) return true;
			const [sorted1, sorted2] = [files1.sort(), files2.sort()];
			if (sorted1.some((o1, i) => o1 !== sorted2[i])) return false;
			const checkers = sorted1.map((o1, i) => isSameFS(join(entry1, o1), join(entry2, sorted2[i])));
			let remaining = checkers.length;
			return await new Promise(res => {
				checkers.forEach(o => o.then(result => {
					remaining--;
					if (!result) res(false);
					else if (remaining === 0) res(true);
				}));
			});
		} else {
			return false;
		}
	} catch (e) {
		console.error("isSameFS", { entry1, entry2 }, e);
		throw e; // TODO: better error handling
	}
}

export function cmd(literals: TemplateStringsArray, ...placeholders: (string | string[])[]) {
	let result: string[] = [];

	for (let i = 0; i < literals.length; i++) {
		const o = literals[i].split(" ");
		if (o[0] === "") o.shift();
		if (o[o.length - 1] === "") o.pop();
		if (o.some(o => o === "")) throw new Error("invalid");
		result.push(...o);

		const ph = placeholders[i];
		if (typeof ph === "string") {
			result.push(ph);
		} else if (ph) {
			result.push(...ph);
		}
	}

	return result;
}

// #endregion