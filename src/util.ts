import { AsyncHook, createHook, executionAsyncId } from "async_hooks";
import { mkdirSync, promises as fsPromises, writeSync } from "fs";
import * as ncpBase from "ncp";
import { join, sep } from "path";
import * as rimrafBase from "rimraf";
import { Writable } from "stream";
const { mkdir, mkdtemp, readdir, readFile, stat } = fsPromises;

export class InterleavedStreams {
	private outputs: StreamOutputItem[] = [];
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
	isEmpty(): boolean {
		return this.outputs.every(o => o.text.length === 0);
	}
	isOutEmpty(): boolean {
		return this.outputs.every(o => o.source === "err" || o.text.length === 0);
	}
	isErrEmpty(): boolean {
		return this.outputs.every(o => o.source === "out" || o.text.length === 0);
	}
	output(): void {
		this.outputs.forEach(o => {
			if (o.source === "out") process.stdout.write(o.text);
			if (o.source === "err") process.stderr.write(o.text);
		})
	}
}

interface StreamOutputItem {
	source: "out" | "err"
	text: string
}

export async function captureOutputStreams<T>(fn: () => Promise<T>, debug = false): Promise<{ streams: InterleavedStreams, res: T }> {
	const streams = new InterleavedStreams();
	const originalOutWrite = process.stdout.write;
	const originalErrWrite = process.stderr.write;
	const targets = new Set<number>();

	let indent = 2;
	const hook = createHook({
		init: (asyncId: number, type: string, triggerAsyncId: number) => {
			if (!targets.has(triggerAsyncId)) return;
			targets.add(asyncId);
			if (debug) {
				writeSync(1, `${' '.repeat(indent)}${triggerAsyncId} -> ${asyncId} [exec ${executionAsyncId()}] ${type}\n`);
			}
		},
		before: (asyncId: number) => {
			if (!targets.has(asyncId)) return;
			if (debug) {
				writeSync(1, `${' '.repeat(indent)}${asyncId} {\n`);
				indent += 2;
			}
			//@ts-ignore
			process.stdout.write = streams.stdout.write.bind(streams.stdout);
			//@ts-ignore
			process.stderr.write = streams.stderr.write.bind(streams.stderr);
		},
		after: (asyncId: number) => {
			if (!targets.has(asyncId)) return;
			if (debug) {
				indent -= 2;
				writeSync(1, `${' '.repeat(indent)}} ${asyncId}\n`);
			}
			process.stdout.write = originalOutWrite;
			process.stderr.write = originalErrWrite;
		},
	});
	hook.enable();
	await Promise.resolve(); // request new executionAsyncId
	targets.add(executionAsyncId());
	if (debug) {
		writeSync(1, `[exec ${executionAsyncId()}]\n`);
	}
	const res = await fn();
	hook.disable();
	process.stdout.write = originalOutWrite;
	process.stderr.write = originalErrWrite;
	return { streams, res };
}

export function makeGetter<T>(getter: (name: string) => T): { [name: string]: T } {
	return new Proxy({}, {
		get: (_, name) => {
			if (typeof name !== "string") error("makeGetter: prop not found");
			return getter(name);
		}
	});
}

export type Placeholder<T> = () => T;
export class PropContext<T>{
	// private getter: (name: string) => T = () => error("PropContext: not initialized");
	private getters = new Map<number, (name: string) => T>();
	/** readable for debug purpose */
	readonly masterAsyncId = new Map<number, number>();
	private placeholders = new Map<string, Placeholder<T>>();
	private placeholderSet = new WeakSet<Placeholder<T>>();
	private hook: AsyncHook;
	constructor() {
		this.hook = createHook({
			init: (asyncId: number, type: string, triggerAsyncId: number) => {
				if (!this.masterAsyncId.has(triggerAsyncId)) return;
				if (this.masterAsyncId.has(asyncId)) bug();
				this.masterAsyncId.set(asyncId, this.masterAsyncId.get(triggerAsyncId)!);
			} // TODO: use AsyncLocalStorage
		});
	}
	getPlaceholder(name: string): Placeholder<T> {
		const item = this.placeholders.get(name);
		if (item) return item;
		const newItem = () => {
			const eid = executionAsyncId();
			if (!this.masterAsyncId.has(eid)) error("PropContext: out of context");
			const getter = this.getters.get(this.masterAsyncId.get(eid)!);
			if (!getter) bug();
			return getter(name);
		};
		this.placeholders.set(name, newItem);
		this.placeholderSet.add(newItem);
		return newItem;
	}
	async run<U>(getter: (name: string) => T, fn: () => Promise<U>): Promise<U> {
		this.hook.enable();
		await Promise.resolve(); // request new executionAsyncId
		const eid = executionAsyncId();
		if (this.getters.has(eid)) bug();
		if (this.masterAsyncId.has(eid)) bug();
		this.getters.set(eid, getter);
		this.masterAsyncId.set(eid, eid);
		const res = await fn();
		this.hook.disable();

		this.getters.delete(eid);
		this.masterAsyncId.delete(eid);
		const keysToRemove = Array.from(this.masterAsyncId.entries()).filter(o => o[1] === eid).map(o => o[0]);
		keysToRemove.forEach(id => this.masterAsyncId.delete(id));

		return res;
	}
	resolvePlaceholder(placeholder: Placeholder<T>): T {
		if (!this.placeholderSet.has(placeholder)) error("PropContext: prop not found");
		return placeholder();
	}
}

export function filterUndefined<T>(items: (T | undefined)[]): T[] {
	// @ts-ignore
	return items.filter(o => typeof o !== "undefined");
}

export function clearConsole(): void {
	// console.clear();
	process.stdout.write('\u001bc');
}

export function padZero(num: number, max: number): string {
	const digits = max.toFixed(0).length;
	return num.toFixed(0).padStart(digits, "0");
}

export function isStringArray(arr: any): arr is string[] {
	return Array.isArray(arr) && arr.every(o => typeof o === "string");
}

export function uniq<T>(arr: T[]): T[] {
	return arr.filter((o, i) => arr.findIndex(oo => oo === o) === i);
}

export function date(): string {
	return new Date().toISOString();
}

const onExitFn: (() => void)[] = [];
setupExitHandler();
function setupExitHandler() {
	["exit", "SIGINT", "SIGTERM"].forEach(type => {
		process.on(type, () => {
			if (type === "exit") onExitFn.forEach(fn => fn());
			else process.exit(1);
		});
	});
}
export function onExit(fn: () => void): { cancel: () => void } {
	onExitFn.push(fn);
	const cancel = () => onExitFn.splice(onExitFn.findIndex(o => o === fn), 1);
	return { cancel };
}

export function debounce<T>(fn: (items: T[]) => void, delay: number): (items: T[]) => void {
	let timeout: NodeJS.Timeout;
	let items: T[] = [];
	return newItems => {
		items.push(...newItems);
		clearTimeout(timeout);
		timeout = setTimeout(() => {
			const args = items;
			items = [];
			fn(args);
		}, delay);
	}
}

export function oneAtATime<T>(fn: (items: T[]) => Promise<void>): (item: T[]) => void {
	let isRunning = false
	let shouldRerun = false;
	let stack: T[] = [];
	let runner = async () => {
		if (isRunning) {
			shouldRerun = true;
			return; // execution continues from (1) below
		}
		isRunning = true;
		let items = stack;
		stack = [];
		await fn(items);
		isRunning = false;
		if (shouldRerun) {
			shouldRerun = false;
			await runner(); // (1)
		}
	}
	return newItems => {
		stack.push(...newItems);
		runner();
	}
}

export function every(promises: Promise<boolean>[]): Promise<boolean> {
	let remaining = promises.length;
	if (remaining === 0) return Promise.resolve(true);
	return new Promise(res => {
		promises.forEach(o => o.then(result => {
			remaining--;
			if (!result) res(false);
			else if (remaining === 0) res(true);
		}));
	});
}

export function rm(path: string): Promise<void> {
	return new Promise<void>((resolve, rejected) => {
		rimrafBase(path, { disableGlob: true }, err => {
			if (err) rejected(err);
			else resolve();
		})
	})
}

export function rmSync(path: string): void {
	rimrafBase.sync(path, { disableGlob: true });
}

export function cp(src: string, dest: string): Promise<void> {
	return new Promise((res, rej) =>
		ncpBase.ncp(src, dest, { dereference: true, clobber: false }, err => {
			if (err) rej(err);
			else res();
		})
	);
}

export function mkdirp(dir: string): Promise<void> {
	return mkdir(dir, { recursive: true }).then();
}

export function mkdirpSync(dir: string): void {
	mkdirSync(dir, { recursive: true });
}

export async function mkdtempIn(dir: string): Promise<string> {
	await mkdirp(dir);
	const tmpDir = await mkdtemp(dir + sep);
	return tmpDir;
}

export async function clearDir(dir: string): Promise<void> {
	try {
		const files = await readdir(dir);
		await Promise.all(files.map(file => rm(join(dir, file))));
	} catch (e) {
		if (e.code === "ENOENT") return;
		throw e; // TODO: better error handling
	}
}

export async function isSameFS(entry1: string, entry2: string): Promise<boolean> {
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
			const [sorted1, sorted2] = [files1.sort(), files2.sort()];
			if (!sorted1.every((o1, i) => o1 === sorted2[i])) return false;
			const checkers = sorted1.map((o1, i) => isSameFS(join(entry1, o1), join(entry2, sorted2[i])));
			return await every(checkers);

		} else {
			return false;
		}
	} catch (e) {
		console.error("isSameFS", { entry1, entry2 }, e);
		throw e; // TODO: better error handling
	}
}

export function error(message: string): never {
	throw new Error(message);
}

export function invalid(): never {
	throw new Error("invalid");
}

export function bug(): never {
	throw new Error("BUG");
}

export function never(a: never): never {
	throw new Error("BUG (never)");
}