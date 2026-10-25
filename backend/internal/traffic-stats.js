import errs from "../lib/error.js";
import { global as logger } from "../logger.js";
import deadHostModel from "../models/dead_host.js";
import proxyHostModel from "../models/proxy_host.js";
import redirectionHostModel from "../models/redirection_host.js";
import streamModel from "../models/stream.js";
import settingModel from "../models/setting.js";
import db from "../db.js";
import { BUCKET_SECONDS } from "./traffic/aggregator.js";
import GeoIp from "./traffic/geoip.js";
import Ingest from "./traffic/ingest.js";
import influxStore from "./traffic/store/influx.js";
import localStore from "./traffic/store/local.js";

const SETTING_ID = "traffic-stats";
const MASK = "********";
const MAX_POINTS = 300;
const HOST_MODELS = {
	proxy: proxyHostModel,
	redirection: redirectionHostModel,
	dead: deadHostModel,
	stream: streamModel,
};

export const DEFAULTS = {
	retention_days: 30,
	range_hours: 24,
	geoip: false,
	influx: { url: "", org: "", bucket: "", token: "" },
};

let ingest = null;
let geoip = null;
let activeStore = localStore;
let labels = new Map();

const influxConfigured = (cfg) => !!(cfg?.url && cfg.org && cfg.bucket && cfg.token);

/**
 * Fills in defaults and clamps values. A masked token means "keep the stored one".
 */
const normalizeMeta = (meta = {}, previous = {}) => {
	const influx = { ...DEFAULTS.influx, ...(meta.influx || {}) };
	for (const k of Object.keys(DEFAULTS.influx)) {
		influx[k] = String(influx[k] ?? "").trim();
	}
	if (influx.token === MASK) {
		influx.token = previous.influx?.token || "";
	}
	if (influx.url && !/^https?:\/\//i.test(influx.url)) {
		throw new errs.ValidationError("InfluxDB URL must start with http:// or https://");
	}
	const clamp = (v, min, max, def) => {
		const n = Number.parseInt(v, 10);
		return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
	};
	return {
		geoip: meta.geoip === true,
		retention_days: clamp(meta.retention_days, 1, 3650, DEFAULTS.retention_days),
		range_hours: clamp(meta.range_hours, 1, 24 * 3650, DEFAULTS.range_hours),
		influx,
	};
};

const maskMeta = (meta) => {
	const m = { ...DEFAULTS, ...(meta || {}) };
	m.influx = { ...DEFAULTS.influx, ...(m.influx || {}) };
	if (m.influx.token) {
		m.influx = { ...m.influx, token: MASK };
	}
	return m;
};

const refreshLabels = async () => {
	const next = new Map();
	for (const [type, model] of Object.entries(HOST_MODELS)) {
		const rows = await model.query().where("is_deleted", 0);
		for (const row of rows) {
			next.set(`${type}|${row.id}`, row);
		}
	}
	labels = next;
};

const labelOf = (type, id) => {
	const row = labels.get(`${type}|${id}`);
	if (type === "stream") {
		return row ? `Stream :${row.incoming_port}` : "";
	}
	return Array.isArray(row?.domain_names) && row.domain_names.length ? row.domain_names.join(", ") : "";
};

const internalTrafficStats = {
	SETTING_ID,
	normalizeMeta,
	maskMeta,

	/**
	 * Starts or stops the ingest worker to match the stored setting.
	 *
	 * @param   {Object|null} row           the setting row, or null to read it
	 * @param   {Object|null} previousRow   the setting row before an update
	 * @returns {Promise}
	 */
	apply: async (row = null, previousRow = null) => {
		const setting = row || (await settingModel.query().where({ id: SETTING_ID }).first());
		if (ingest) {
			ingest.stop();
			ingest = null;
		}
		geoip?.unload();
		geoip = null;
		if (setting?.value !== "enabled") {
			return;
		}

		const meta = normalizeMeta(setting.meta);
		await refreshLabels();
		const useInflux = influxConfigured(meta.influx);
		activeStore = useInflux ? influxStore(meta.influx, labelOf) : localStore;

		// A different storage backend starts empty: re-import the logs into it
		const prevMeta = previousRow ? normalizeMeta(previousRow.meta) : null;
		const prevInflux = prevMeta ? influxConfigured(prevMeta.influx) : useInflux;
		const changed =
			prevMeta && (prevInflux !== useInflux || (useInflux && prevMeta.influx.url !== meta.influx.url));
		if (changed) {
			await db()("traffic_stat_cursor").del();
			if (!useInflux) {
				await localStore.clear();
			}
		}

		geoip = meta.geoip ? new GeoIp() : null;
		ingest = new Ingest({ store: activeStore, retentionDays: meta.retention_days, geoip });
		logger.info(`Traffic stats enabled (storage: ${activeStore.type}, retention: ${meta.retention_days} days)`);
		ingest.start();
	},

	/**
	 * Reports on traffic over the last `hours` hours.
	 *
	 * @param   {Access} access
	 * @param   {Object} data
	 * @param   {Number} [data.hours]
	 * @param   {String} [data.host_type]  with host_id, only report on this host
	 * @param   {Number} [data.host_id]
	 * @returns {Promise}
	 */
	getReport: async (access, data = {}) => {
		const access_data = await access.can("reports:traffic", 1);
		const setting = await settingModel.query().where({ id: SETTING_ID }).first();
		if (setting?.value !== "enabled") {
			return { enabled: false };
		}
		const meta = normalizeMeta(setting.meta);
		const hours = Math.min(
			meta.retention_days * 24,
			Math.max(1, Number.parseInt(data.hours, 10) || meta.range_hours),
		);

		await refreshLabels();
		let hosts = null;
		if (access_data.permission_visibility !== "all") {
			const userId = access.token.getUserId(1);
			hosts = [];
			for (const [key, row] of labels) {
				if (row.owner_user_id === userId) {
					const [host_type, id] = key.split("|");
					hosts.push({ host_type, host_id: Number(id) });
				}
			}
		}

		if (data.host_type) {
			const host = { host_type: String(data.host_type), host_id: Number.parseInt(data.host_id, 10) };
			if (!(host.host_type in HOST_MODELS) || !Number.isFinite(host.host_id)) {
				throw new errs.ValidationError("Invalid host");
			}
			// a user who can't see this host gets an empty report rather than another host's numbers
			const allowed = !hosts || hosts.some((h) => h.host_type === host.host_type && h.host_id === host.host_id);
			hosts = allowed ? [host] : [];
		}

		const to = Math.floor(Date.now() / 1000);
		const from = to - hours * 3600;
		const step = Math.max(BUCKET_SECONDS, Math.ceil((to - from) / MAX_POINTS / BUCKET_SECONDS) * BUCKET_SECONDS);

		let result;
		try {
			result = await activeStore.query({ from, to, step, hosts });
		} catch (err) {
			logger.error(`Traffic stats query failed: ${err.message}`);
			throw new errs.ValidationError(`Could not read traffic stats: ${err.message}`);
		}

		const totals = { requests: 0, s2xx: 0, s3xx: 0, s4xx: 0, s5xx: 0, bytes: 0 };
		for (const row of result.hosts) {
			for (const k of Object.keys(totals)) {
				totals[k] += row[k];
			}
			row.label = labelOf(row.host_type, row.host_id) || `Deleted host #${row.host_id}`;
		}
		result.hosts.sort((a, b) => b.requests - a.requests);

		return {
			enabled: true,
			storage: activeStore.type,
			error: ingest?.lastError || geoip?.error || null,
			geoip: !!geoip?.reader,
			range: { from, to, step, hours },
			totals,
			series: result.series,
			hosts: result.hosts,
			top: result.top,
		};
	},
};

export default internalTrafficStats;
