import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import zlib from "node:zlib";
import db from "../../db.js";
import { global as logger } from "../../logger.js";
import Aggregator from "./aggregator.js";
import { parseFileName, parseLine } from "./parser.js";

const LOG_DIR = process.env.NPM_TRAFFIC_LOG_DIR || "/data/logs";
const POLL_MS = 10 * 1000;
const MAX_READ_PER_TICK = 16 * 1024 * 1024;

/**
 * Tails the per-host nginx access logs and feeds the parsed lines to a store.
 *
 * The first time a log file is seen, every existing line (including rotated
 * files) inside the retention window is imported. After that only new bytes
 * are read, tracked by a cursor (inode + byte position) kept in the database.
 */
class Ingest {
	/**
	 * @param {Object}   opts
	 * @param {Object}   opts.store          one of the traffic stores
	 * @param {Number}   opts.retentionDays  lines older than this are skipped
	 */
	constructor({ store, retentionDays }) {
		this.store = store;
		this.retentionDays = retentionDays;
		this.timer = null;
		this.busy = false;
		this.lastPrune = 0;
		this.lastError = null;
		this.lastRun = null;
	}

	start() {
		if (this.timer) {
			return;
		}
		this.timer = setInterval(() => this.tick(), POLL_MS);
		this.timer.unref?.();
		this.tick();
	}

	stop() {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	get #cutoff() {
		return Math.floor(Date.now() / 1000) - this.retentionDays * 86400;
	}

	async tick() {
		if (this.busy) {
			return;
		}
		this.busy = true;
		try {
			const files = (await fs.promises.readdir(LOG_DIR)).filter((f) => parseFileName(f));
			const cursors = new Map((await db()("traffic_stat_cursor").select()).map((c) => [c.file, c]));

			for (const file of files) {
				await this.#processFile(file, cursors.get(file));
			}

			// Forget cursors for log files that no longer exist (deleted hosts)
			const gone = [...cursors.keys()].filter((f) => !files.includes(f));
			if (gone.length) {
				await db()("traffic_stat_cursor").whereIn("file", gone).del();
			}

			if (Date.now() - this.lastPrune > 3600 * 1000) {
				this.lastPrune = Date.now();
				await this.store.prune(this.#cutoff);
			}
			this.lastError = null;
		} catch (err) {
			this.lastError = err.message;
			logger.error(`Traffic stats ingest failed: ${err.message}`);
		} finally {
			this.lastRun = Date.now();
			this.busy = false;
		}
	}

	async #saveCursor(file, inode, position) {
		await db()("traffic_stat_cursor")
			.insert({ file, inode: String(inode), position })
			.onConflict("file")
			.merge({ inode: String(inode), position });
	}

	async #processFile(file, cursor) {
		const full = path.join(LOG_DIR, file);
		const host = parseFileName(file);
		let stat;
		try {
			stat = await fs.promises.stat(full);
		} catch {
			return;
		}

		if (!cursor) {
			await this.#backfill(file, host, stat);
			return;
		}

		const agg = new Aggregator();
		let position = Number(cursor.position);
		const rotated = String(stat.ino) !== cursor.inode || stat.size < position;

		if (rotated) {
			// Whatever was written between our last read and the rotation is now in file.1
			const previous = `${full}.1`;
			try {
				const prevStat = await fs.promises.stat(previous);
				if (String(prevStat.ino) === cursor.inode && prevStat.size > position) {
					await this.#readRange(previous, position, prevStat.size, host, agg);
				}
			} catch {
				// not there, nothing to recover
			}
			position = 0;
		}

		const end = Math.min(stat.size, position + MAX_READ_PER_TICK);
		const consumed = end > position ? await this.#readRange(full, position, end, host, agg) : 0;

		if (agg.size) {
			await this.store.write(agg.drain());
		}
		if (rotated || consumed) {
			await this.#saveCursor(file, stat.ino, position + consumed);
		}
	}

	/**
	 * Reads whole lines in [start, end). Returns the bytes consumed, which stops
	 * short of `end` if the last line isn't finished yet.
	 */
	async #readRange(filePath, start, end, host, agg) {
		const handle = await fs.promises.open(filePath, "r");
		try {
			const length = end - start;
			const buf = Buffer.alloc(length);
			const { bytesRead } = await handle.read(buf, 0, length, start);
			const lastNewline = buf.lastIndexOf(0x0a, bytesRead - 1);
			if (lastNewline < 0) {
				return 0;
			}
			const cutoff = this.#cutoff;
			for (const line of buf.toString("utf8", 0, lastNewline).split("\n")) {
				const rec = parseLine(line);
				if (rec && rec.ts >= cutoff) {
					agg.add(host, rec);
				}
			}
			return lastNewline + 1;
		} finally {
			await handle.close();
		}
	}

	async #streamLines(filePath, options, onLine) {
		let input = fs.createReadStream(filePath, options);
		if (filePath.endsWith(".gz")) {
			input = input.pipe(zlib.createGunzip());
		}
		const rl = readline.createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
		for await (const line of rl) {
			onLine(line);
		}
	}

	/**
	 * Byte length of the file up to and including its last newline.
	 */
	async #completeLength(filePath, size) {
		const handle = await fs.promises.open(filePath, "r");
		try {
			let end = size;
			while (end > 0) {
				const len = Math.min(64 * 1024, end);
				const buf = Buffer.alloc(len);
				await handle.read(buf, 0, len, end - len);
				const idx = buf.lastIndexOf(0x0a);
				if (idx >= 0) {
					return end - len + idx + 1;
				}
				end -= len;
			}
			return 0;
		} finally {
			await handle.close();
		}
	}

	/**
	 * First sight of a host's log: import rotated files (oldest first), then the
	 * live file up to its current size, and park the cursor there.
	 */
	async #backfill(file, host, stat) {
		const full = path.join(LOG_DIR, file);
		const agg = new Aggregator();
		const cutoff = this.#cutoff;
		const onLine = (line) => {
			const rec = parseLine(line);
			if (rec && rec.ts >= cutoff) {
				agg.add(host, rec);
			}
		};

		const rotated = (await fs.promises.readdir(LOG_DIR))
			.filter((f) => f.startsWith(`${file}.`))
			.map((f) => ({ name: f, n: Number.parseInt(f.slice(file.length + 1), 10) }))
			.filter((f) => Number.isFinite(f.n))
			.sort((a, b) => b.n - a.n);

		for (const r of rotated) {
			try {
				await this.#streamLines(path.join(LOG_DIR, r.name), {}, onLine);
			} catch (err) {
				logger.warn(`Traffic stats: could not import ${r.name}: ${err.message}`);
			}
		}

		// Only count complete lines and remember exactly where we stopped
		const consumed = await this.#completeLength(full, stat.size);
		if (consumed > 0) {
			await this.#streamLines(full, { start: 0, end: consumed - 1 }, onLine);
		}

		if (agg.size) {
			await this.store.write(agg.drain(), { backfill: true });
		}
		await this.#saveCursor(file, stat.ino, consumed);
		logger.info(`Traffic stats: imported existing log ${file}`);
	}
}

export default Ingest;
