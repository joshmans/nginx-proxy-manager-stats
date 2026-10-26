import { BUCKET_SECONDS } from "../aggregator.js";

const FIELDS = ["requests", "s2xx", "s3xx", "s4xx", "s5xx", "bytes"];
const MEASUREMENT = "npm_traffic";
const STATUS_MEASUREMENT = "npm_traffic_status";
const HOUR = 3600;
const TIMEOUT_MS = 15000;

// Live points get a unique, non-zero nanosecond offset inside their bucket so that
// successive writes for the same host and bucket add up (InfluxDB overwrites points
// with an identical series and timestamp). Backfilled points use offset 0, so
// re-importing the logs overwrites itself instead of double counting.
let seq = Number(process.hrtime.bigint() % 900000000n) + 1;

const escapeTag = (v) => String(v).replace(/[,= ]/g, "\\$&");
const escapeFlux = (v) => String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
const num = (v) => Number(v) || 0;
// Nanosecond timestamps are far beyond what a JS number holds exactly, so build them as BigInts
const stamp = (bucket, offset) => (BigInt(bucket) * 1000000000n + BigInt(offset)).toString();

/**
 * Splits InfluxDB annotated CSV into row objects (one table per header block).
 */
const parseCsv = (text) => {
	const rows = [];
	let header = null;
	for (const line of text.split(/\r?\n/)) {
		if (!line) {
			header = null;
			continue;
		}
		if (line.startsWith("#")) {
			continue;
		}
		const cells = line.split(",");
		if (!header) {
			header = cells;
			continue;
		}
		const row = {};
		header.forEach((name, i) => {
			if (name) {
				row[name] = cells[i];
			}
		});
		rows.push(row);
	}
	return rows;
};

/**
 * Stores the traffic counters in InfluxDB 2.x, so they can be graphed in Grafana.
 *
 * @param {{url: String, org: String, bucket: String, token: String}} cfg
 * @param {(host_type: String, host_id: Number) => String} labelOf
 */
const influxStore = (cfg, labelOf = () => "") => {
	const base = cfg.url.replace(/\/+$/, "");
	const headers = { Authorization: `Token ${cfg.token}` };

	const call = async (path, options = {}) => {
		const res = await fetch(`${base}${path}`, {
			...options,
			headers: { ...headers, ...(options.headers || {}) },
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		if (!res.ok) {
			const body = (await res.text()).slice(0, 200);
			throw new Error(`InfluxDB responded ${res.status}: ${body}`);
		}
		return res;
	};

	const flux = async (query) => {
		const res = await call(`/api/v2/query?org=${encodeURIComponent(cfg.org)}`, {
			method: "POST",
			headers: { "Content-Type": "application/vnd.flux", Accept: "application/csv" },
			body: query,
		});
		return parseCsv(await res.text());
	};

	const scopeFilter = (hosts) => {
		if (!hosts) {
			return "";
		}
		const parts = hosts.map(
			(h) => `(r.host_type == "${escapeFlux(h.host_type)}" and r.host_id == "${Number(h.host_id)}")`,
		);
		return `|> filter(fn: (r) => ${parts.join(" or ")})`;
	};

	return {
		type: "influxdb",

		async ping() {
			await call("/health");
			await flux(`from(bucket: "${escapeFlux(cfg.bucket)}") |> range(start: -1m) |> limit(n: 1)`);
		},

		async write(batch, opts = {}) {
			const hostTags = (b) =>
				`host_type=${escapeTag(b.host_type)},host_id=${b.host_id},host=${escapeTag(labelOf(b.host_type, b.host_id) || `host-${b.host_id}`)}`;
			const nextOffset = () => (opts.backfill ? 0 : seq++ % 1000000000);
			const lines = batch.buckets.map((b) => {
				const fields = FIELDS.map((f) => `${f}=${b[f]}i`).join(",");
				return `${MEASUREMENT},${hostTags(b)} ${fields} ${stamp(b.bucket, nextOffset())}`;
			});
			// Exact status codes (only present when that extra is on): one small series per host and code
			for (const t of batch.tops) {
				if (t.kind === "status") {
					lines.push(
						`${STATUS_MEASUREMENT},${hostTags(t)},code=${escapeTag(t.item)} hits=${t.hits}i ${stamp(t.bucket, nextOffset())}`,
					);
				}
			}
			for (let i = 0; i < lines.length; i += 5000) {
				await call(
					`/api/v2/write?org=${encodeURIComponent(cfg.org)}&bucket=${encodeURIComponent(cfg.bucket)}&precision=ns`,
					{
						method: "POST",
						headers: { "Content-Type": "text/plain; charset=utf-8" },
						body: lines.slice(i, i + 5000).join("\n"),
					},
				);
			}
		},

		// Retention is enforced by the InfluxDB bucket itself.
		async prune() {},
		async clear() {},

		async query({ from, to, step, hosts, statuses: wantStatuses = false }) {
			if (hosts && hosts.length === 0) {
				return { series: [], hosts: [], statuses: [], top: { ip: [], path: [], country: [] } };
			}
			const common = `from(bucket: "${escapeFlux(cfg.bucket)}")
				|> range(start: ${from}, stop: ${to})
				|> filter(fn: (r) => r._measurement == "${MEASUREMENT}")
				${scopeFilter(hosts)}`;

			const win = Math.max(BUCKET_SECONDS, step);
			const seriesRows = await flux(`${common}
				|> group(columns: ["_field"])
				|> aggregateWindow(every: ${win}s, fn: sum, createEmpty: false)`);
			const byTs = new Map();
			for (const r of seriesRows) {
				// aggregateWindow stamps each window with its stop time
				const ts = Math.floor(Date.parse(r._time) / 1000) - win;
				const row = byTs.get(ts) || { ts, requests: 0, s2xx: 0, s3xx: 0, s4xx: 0, s5xx: 0, bytes: 0 };
				if (FIELDS.includes(r._field)) {
					row[r._field] = num(r._value);
				}
				byTs.set(ts, row);
			}

			const hostRows = await flux(`${common}
				|> group(columns: ["host_type", "host_id", "_field"])
				|> sum()`);
			const byHost = new Map();
			for (const r of hostRows) {
				const key = `${r.host_type}|${r.host_id}`;
				const row = byHost.get(key) || {
					host_type: r.host_type,
					host_id: Number(r.host_id),
					requests: 0,
					s2xx: 0,
					s3xx: 0,
					s4xx: 0,
					s5xx: 0,
					bytes: 0,
				};
				if (FIELDS.includes(r._field)) {
					row[r._field] = num(r._value);
				}
				byHost.set(key, row);
			}

			const statuses = [];
			if (wantStatuses) {
				// the code points are hourly, so windows are never narrower than that
				const statusWin = Math.max(HOUR, win);
				const statusRows = await flux(`from(bucket: "${escapeFlux(cfg.bucket)}")
					|> range(start: ${from}, stop: ${to})
					|> filter(fn: (r) => r._measurement == "${STATUS_MEASUREMENT}" and r._field == "hits")
					${scopeFilter(hosts)}
					|> group(columns: ["code"])
					|> aggregateWindow(every: ${statusWin}s, fn: sum, createEmpty: false)`);
				const byCode = new Map();
				for (const r of statusRows) {
					const entry = byCode.get(r.code) || { code: Number(r.code), total: 0, series: [] };
					const hits = num(r._value);
					entry.total += hits;
					entry.series.push({ ts: Math.floor(Date.parse(r._time) / 1000) - statusWin, requests: hits });
					byCode.set(r.code, entry);
				}
				statuses.push(...[...byCode.values()].sort((a, b) => b.total - a.total));
			}

			return {
				series: [...byTs.values()].sort((a, b) => a.ts - b.ts),
				hosts: [...byHost.values()],
				// Client IPs and paths are not exported: as InfluxDB tags they'd create unbounded series.
				statuses,
				top: { ip: [], path: [], country: [] },
			};
		},
	};
};

export default influxStore;
