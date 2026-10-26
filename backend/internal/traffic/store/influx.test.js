import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import influxStore from "./influx.js";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

const cfg = { url: "http://influx:8086/", org: "homelab", bucket: "npm", token: "t" };

const capture = () => {
	const calls = [];
	globalThis.fetch = async (url, options) => {
		calls.push({ url: String(url), body: options.body, headers: options.headers });
		return { ok: true, text: async () => "", status: 204 };
	};
	return calls;
};

const batch = {
	buckets: [
		{
			bucket: 1792960200,
			host_type: "proxy",
			host_id: 3,
			requests: 5,
			s2xx: 3,
			s3xx: 0,
			s4xx: 2,
			s5xx: 0,
			bytes: 900,
		},
	],
	tops: [
		{ bucket: 1792958400, host_type: "proxy", host_id: 3, kind: "status", item: "200", hits: 3 },
		{ bucket: 1792958400, host_type: "proxy", host_id: 3, kind: "status", item: "404", hits: 2 },
		{ bucket: 1792958400, host_type: "proxy", host_id: 3, kind: "ip", item: "1.2.3.4", hits: 5 },
	],
};

test("writes per-code points as their own measurement, and never IPs or paths", async () => {
	const calls = capture();
	const store = influxStore(cfg, () => "app.example.com, www.example.com");
	await store.write(batch, { backfill: true });
	assert.equal(calls.length, 1);
	assert.match(calls[0].url, /^http:\/\/influx:8086\/api\/v2\/write\?org=homelab&bucket=npm&precision=ns$/);
	const lines = calls[0].body.split("\n");
	assert.equal(lines.length, 3);
	assert.equal(
		lines[0],
		"npm_traffic,host_type=proxy,host_id=3,host=app.example.com\\,\\ www.example.com requests=5i,s2xx=3i,s3xx=0i,s4xx=2i,s5xx=0i,bytes=900i 1792960200000000000",
	);
	assert.match(
		lines[1],
		/^npm_traffic_status,host_type=proxy,host_id=3,host=.+,code=200 hits=3i 1792958400000000000$/,
	);
	assert.match(lines[2], /,code=404 hits=2i 1792958400000000000$/);
	assert.ok(!calls[0].body.includes("1.2.3.4"));
});

test("live points get distinct timestamps so they add up instead of overwriting", async () => {
	const calls = capture();
	const store = influxStore(cfg);
	await store.write(batch);
	await store.write(batch);
	const stamps = calls.flatMap((c) => c.body.split("\n").map((l) => l.split(" ").pop()));
	assert.equal(new Set(stamps).size, stamps.length);
});

test("reads per-code windows from the status measurement", async () => {
	const queries = [];
	globalThis.fetch = async (_url, options) => {
		queries.push(options.body);
		const body = String(options.body);
		let csv = "";
		if (body.includes("npm_traffic_status")) {
			csv =
				",result,table,_time,_value,code\n,_result,0,2026-10-25T20:00:00Z,7,404\n,_result,0,2026-10-25T21:00:00Z,3,404\n,_result,1,2026-10-25T21:00:00Z,40,200\n";
		}
		return { ok: true, text: async () => csv, status: 200 };
	};
	const store = influxStore(cfg);
	const result = await store.query({
		from: 1792950000,
		to: 1793000000,
		step: 300,
		hosts: [{ host_type: "proxy", host_id: 3 }],
		statuses: true,
	});
	assert.deepEqual(
		result.statuses.map((s) => [s.code, s.total, s.series.length]),
		[
			[200, 40, 1],
			[404, 10, 2],
		],
	);
	const statusQuery = queries.find((q) => String(q).includes("npm_traffic_status"));
	assert.match(statusQuery, /aggregateWindow\(every: 3600s/);
	assert.match(statusQuery, /r\.host_id == "3"/);
	const off = await store.query({ from: 1792950000, to: 1793000000, step: 300, hosts: null });
	assert.deepEqual(off.statuses, []);
});

test("timestamps keep their exact nanosecond offsets", async () => {
	const calls = capture();
	const store = influxStore(cfg);
	await store.write({ buckets: batch.buckets, tops: [] });
	await store.write({ buckets: batch.buckets, tops: [] });
	const [first, second] = calls.map((c) => BigInt(c.body.split(" ").pop()));
	assert.ok(first % 1000000000n !== 0n || second % 1000000000n !== 0n);
	assert.equal(second - first, 1n);
});
