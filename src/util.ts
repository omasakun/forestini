import { createHook, executionAsyncId } from "async_hooks";
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
	targets.add(executionAsyncId());
	writeSync(1, `[exec ${executionAsyncId()}]\n`);
	let indent = 2;
	const hook = createHook({
		init(asyncId: number, type: string, triggerAsyncId: number) {
			if (!targets.has(triggerAsyncId)) return;
			targets.add(asyncId);
			if (debug) {
				writeSync(1, `${' '.repeat(indent)}${triggerAsyncId} -> ${asyncId} [exec ${executionAsyncId()}] ${type}\n`);
			}
		},
		before(asyncId: number) {
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
		after(asyncId: number) {
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
	const res = await fn();
	hook.disable();
	process.stdout.write = originalOutWrite;
	process.stderr.write = originalErrWrite;
	return { streams, res };
}

export type Placeholder<T> = () => T;
export class PropContext<T>{
	private getter: (name: string) => T = () => error("PropContext: not initialized");
	readonly placeholders = new Map<string, Placeholder<T>>();
	readonly placeholderSet = new WeakSet<Placeholder<T>>();
	getObject(): { [name: string]: T } {
		return new Proxy({}, {
			get: (_, name) => {
				if (typeof name !== "string") error("PropContext: prop not found");
				return this.getter(name);
			}
		});
	}
	getPlaceholderMaker(): { [name: string]: Placeholder<T> } {
		return new Proxy({}, {
			get: (_, name) => {
				if (typeof name !== "string") error("PropContext: prop not found");
				return this.getPlaceholder(name);
			}
		});
	}
	getPlaceholder(name: string): Placeholder<T> {
		const item = this.placeholders.get(name);
		if (item) return item;
		const newItem = () => this.getter(name);
		this.placeholders.set(name, newItem);
		this.placeholderSet.add(newItem);
		return newItem;
	}
	resolvePlaceholder(placeholder: Placeholder<T>): T {
		if (!this.placeholderSet.has(placeholder)) error("PropContext: prop not found");
		return placeholder();
	}
	setGetter(getter: (name: string) => T) {
		this.getter = getter;
	}
	clearGetter() {
		this.getter = () => error("PropContext: invalidated");
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