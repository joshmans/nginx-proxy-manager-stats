import db from "../../../db.js";

const CHUNK = 200;
const TOP_KEEP = 25;

const num = (v) => Number(v) || 0;

/**
 * Keeps the traffic counters in NPM's own database.
 */
const localStore = {
	type: "local",

	async ping() {
		await db()("traffic_stat").count("* as c").first();
	},

	/**
	 * @param {{buckets: Object[], tops: Object[]}} batch
	 * @param {{backfill: Boolean}} _opts
	 */
	async write(batch, _opts = {}) {
		const knex = db();
		await knex.transaction(async (trx) => {
			for (let i = 0; i < batch.buckets.length; i += CHUNK) {
				for (const row of batch.buckets.slice(i, i + CHUNK)) {
					await trx("traffic_stat")
						.insert(row)
						.onConflict(["bucket", "host_type", "host_id"])
						.merge({
							requests: trx.raw("?? + ?", ["traffic_stat.requests", row.requests]),
							s2xx: trx.raw("?? + ?", ["traffic_stat.s2xx", row.s2xx]),
							s3xx: trx.raw("?? + ?", ["traffic_stat.s3xx", row.s3xx]),
							s4xx: trx.raw("?? + ?", ["traffic_stat.s4xx", row.s4xx]),
							s5xx: trx.raw("?? + ?", ["traffic_stat.s5xx", row.s5xx]),
							bytes: trx.raw("?? + ?", ["traffic_stat.bytes", row.bytes]),
						});
				}
			}
			for (const row of batch.tops) {
				await trx("traffic_stat_top")
					.insert(row)
					.onConflict(["bucket", "host_type", "host_id", "kind", "item"])
					.merge({ hits: trx.raw("?? + ?", ["traffic_stat_top.hits", row.hits]) });
			}
		});
	},

	async prune(cutoff) {
		await db()("traffic_stat").where("bucket", "<", cutoff).del();
		await db()("traffic_stat_top").where("bucket", "<", cutoff).del();
		await localStore.trimTops();
	},

	/**
	 * Hours that are over only need their busiest items, so cut each older
	 * hour/host/kind group down to TOP_KEEP rows.
	 */
	async trimTops() {
		const knex = db();
		const before = Math.floor(Date.now() / 1000) - 2 * 3600;
		const groups = await knex("traffic_stat_top")
			.select("bucket", "host_type", "host_id", "kind")
			.count("* as c")
			.where("bucket", "<", before)
			.groupBy("bucket", "host_type", "host_id", "kind")
			.having(knex.raw("count(*)"), ">", TOP_KEEP);
		for (const g of groups) {
			const extra = await knex("traffic_stat_top")
				.select("item")
				.where({ bucket: g.bucket, host_type: g.host_type, host_id: g.host_id, kind: g.kind })
				.orderBy("hits", "desc")
				.offset(TOP_KEEP)
				.limit(1000000);
			for (let i = 0; i < extra.length; i += CHUNK) {
				await knex("traffic_stat_top")
					.where({ bucket: g.bucket, host_type: g.host_type, host_id: g.host_id, kind: g.kind })
					.whereIn(
						"item",
						extra.slice(i, i + CHUNK).map((e) => e.item),
					)
					.del();
			}
		}
	},

	async clear() {
		await db()("traffic_stat").del();
		await db()("traffic_stat_top").del();
	},

	/**
	 * @param {{from: Number, to: Number, step: Number, hosts: Array|null}} q  hosts: allowed {host_type, host_id}, null for all
	 */
	async query({ from, to, step, hosts, statuses: wantStatuses = false }) {
		const knex = db();
		if (hosts && hosts.length === 0) {
			return { series: [], hosts: [], statuses: [], top: { ip: [], path: [], country: [] } };
		}

		const scope = (builder) => {
			builder.where("bucket", ">=", from).andWhere("bucket", "<", to);
			if (hosts) {
				builder.andWhere((w) => {
					for (const type of [...new Set(hosts.map((h) => h.host_type))]) {
						w.orWhere((t) =>
							t.where("host_type", type).whereIn(
								"host_id",
								hosts.filter((h) => h.host_type === type).map((h) => h.host_id),
							),
						);
					}
				});
			}
		};
		const sums = [
			knex.raw("SUM(requests) as requests"),
			knex.raw("SUM(s2xx) as s2xx"),
			knex.raw("SUM(s3xx) as s3xx"),
			knex.raw("SUM(s4xx) as s4xx"),
			knex.raw("SUM(s5xx) as s5xx"),
			knex.raw("SUM(bytes) as bytes"),
		];
		const s = Math.max(1, Math.floor(step));
		const tsExpr = `bucket - (bucket % ${s})`;

		const seriesRows = await knex("traffic_stat")
			.select(knex.raw(`${tsExpr} as ts`), ...sums)
			.modify(scope)
			.groupByRaw(tsExpr)
			.orderBy("ts");
		const hostRows = await knex("traffic_stat")
			.select("host_type", "host_id", ...sums)
			.modify(scope)
			.groupBy("host_type", "host_id");

		const top = {};
		for (const kind of ["ip", "path", "country"]) {
			const rows = await knex("traffic_stat_top")
				.select("item", knex.raw("SUM(hits) as hits"))
				.where("kind", kind)
				.modify(scope)
				.groupBy("item")
				.orderBy("hits", "desc")
				.limit(10);
			top[kind] = rows.map((r) => ({ item: r.item, hits: num(r.hits) }));
		}

		// Exact status codes are only kept (hourly) when the extra is switched on
		const statuses = [];
		if (wantStatuses) {
			const rows = await knex("traffic_stat_top")
				.select("item", knex.raw(`${tsExpr} as ts`), knex.raw("SUM(hits) as hits"))
				.where("kind", "status")
				.modify(scope)
				.groupByRaw(`item, ${tsExpr}`)
				.orderBy("ts");
			const byCode = new Map();
			for (const r of rows) {
				const entry = byCode.get(r.item) || { code: Number(r.item), total: 0, series: [] };
				entry.total += num(r.hits);
				entry.series.push({ ts: num(r.ts), requests: num(r.hits) });
				byCode.set(r.item, entry);
			}
			statuses.push(...[...byCode.values()].sort((a, b) => b.total - a.total));
		}

		const norm = (r) => ({
			requests: num(r.requests),
			s2xx: num(r.s2xx),
			s3xx: num(r.s3xx),
			s4xx: num(r.s4xx),
			s5xx: num(r.s5xx),
			bytes: num(r.bytes),
		});
		return {
			series: seriesRows.map((r) => ({ ts: num(r.ts), ...norm(r) })),
			hosts: hostRows.map((r) => ({ host_type: r.host_type, host_id: r.host_id, ...norm(r) })),
			statuses,
			top,
		};
	},
};

export default localStore;
