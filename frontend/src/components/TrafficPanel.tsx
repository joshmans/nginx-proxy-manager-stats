import type { TrafficCounts, TrafficReport } from "src/api/backend";
import { T } from "src/locale";

export const RANGES = [
	{ hours: 1, label: "1h" },
	{ hours: 6, label: "6h" },
	{ hours: 24, label: "24h" },
	{ hours: 24 * 7, label: "7d" },
	{ hours: 24 * 30, label: "30d" },
];

const COLORS = {
	s2xx: "var(--tblr-green)",
	s3xx: "var(--tblr-blue)",
	s4xx: "var(--tblr-yellow)",
	s5xx: "var(--tblr-red)",
};

const formatBytes = (bytes: number) => {
	const units = ["B", "KB", "MB", "GB", "TB"];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
};

const formatTime = (ts: number, hours: number) => {
	const d = new Date(ts * 1000);
	return hours > 48 ? d.toLocaleDateString() : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

interface ChartProps {
	series: Array<TrafficCounts & { ts: number }>;
	from: number;
	to: number;
	step: number;
	hours: number;
}

// Stacked bars of requests per time slot, split by status class
const Chart = ({ series, from, to, step, hours }: ChartProps) => {
	const width = 900;
	const height = 180;
	const slots = Math.max(1, Math.ceil((to - from) / step));
	const byTs = new Map(series.map((p) => [p.ts, p]));
	const first = from - (from % step);
	const points = Array.from({ length: slots + 1 }, (_, i) => first + i * step);
	const max = Math.max(1, ...series.map((p) => p.requests));
	const barW = width / points.length;

	return (
		<svg viewBox={`0 0 ${width} ${height + 20}`} className="w-100" role="img" aria-label="Requests over time">
			<title>Requests over time</title>
			{points.map((ts, i) => {
				const p = byTs.get(ts);
				const x = i * barW;
				let y = height;
				return (
					<g key={ts}>
						<title>{`${formatTime(ts, hours)}: ${p?.requests ?? 0} requests`}</title>
						{p &&
							(["s2xx", "s3xx", "s4xx", "s5xx"] as const).map((k) => {
								const h = (p[k] / max) * height;
								y -= h;
								return h > 0 ? (
									<rect
										key={k}
										x={x + 0.5}
										y={y}
										width={Math.max(1, barW - 1)}
										height={h}
										fill={COLORS[k]}
									/>
								) : null;
							})}
					</g>
				);
			})}
			<line x1="0" y1={height} x2={width} y2={height} stroke="currentColor" opacity="0.2" />
			<text x="0" y={height + 15} fontSize="11" fill="currentColor" opacity="0.7">
				{formatTime(from, hours)}
			</text>
			<text x={width} y={height + 15} fontSize="11" fill="currentColor" opacity="0.7" textAnchor="end">
				{formatTime(to, hours)}
			</text>
			<text x="0" y="10" fontSize="11" fill="currentColor" opacity="0.7">
				{max}
			</text>
		</svg>
	);
};

const TopTable = ({ title, rows }: { title: React.ReactNode; rows: Array<{ label: string; value: number }> }) => (
	<div className="col-md-6 col-lg-3 mb-3">
		<h4 className="mb-2">{title}</h4>
		<table className="table table-sm table-vcenter card-table">
			<tbody>
				{rows.length === 0 && (
					<tr>
						<td className="text-secondary">
							<T id="traffic.no-data" />
						</td>
					</tr>
				)}
				{rows.map((r) => (
					<tr key={r.label}>
						<td className="text-truncate" style={{ maxWidth: 180 }} title={r.label}>
							{r.label}
						</td>
						<td className="text-end">{r.value}</td>
					</tr>
				))}
			</tbody>
		</table>
	</div>
);

const countryName = (code: string) => {
	if (code === "??") {
		return "Unknown";
	}
	try {
		return new Intl.DisplayNames([navigator.language], { type: "region" }).of(code) || code;
	} catch {
		return code;
	}
};

interface PanelProps {
	data: TrafficReport;
	// Set when the report is for a single host: the per-host lists are left out
	single?: boolean;
}

const TrafficPanel = ({ data, single }: PanelProps) => {
	if (!data.enabled || !data.range || !data.totals) {
		return null;
	}
	const { totals, range } = data;
	const errors = totals.s4xx + totals.s5xx;
	const errorRate = totals.requests ? ((errors / totals.requests) * 100).toFixed(1) : "0";

	return (
		<>
			{data.error && <div className="alert alert-warning">{data.error}</div>}
			<div className="row mb-3">
				<div className="col-6 col-md-3">
					<div className="text-secondary">
						<T id="traffic.requests" />
					</div>
					<div className="h2 mb-0">{totals.requests.toLocaleString()}</div>
				</div>
				<div className="col-6 col-md-3">
					<div className="text-secondary">
						<T id="traffic.bandwidth" />
					</div>
					<div className="h2 mb-0">{formatBytes(totals.bytes)}</div>
				</div>
				<div className="col-6 col-md-3">
					<div className="text-secondary">
						<T id="traffic.error-rate" />
					</div>
					<div className="h2 mb-0">{errorRate}%</div>
				</div>
				<div className="col-6 col-md-3">
					<div className="text-secondary">
						<T id="traffic.active-hosts" />
					</div>
					<div className="h2 mb-0">{data.hosts?.length ?? 0}</div>
				</div>
			</div>
			<Chart series={data.series ?? []} from={range.from} to={range.to} step={range.step} hours={range.hours} />
			<div className="d-flex gap-3 mt-2 mb-4 text-secondary small">
				{(["s2xx", "s3xx", "s4xx", "s5xx"] as const).map((k) => (
					<span key={k}>
						<span
							className="d-inline-block me-1 rounded"
							style={{ width: 10, height: 10, background: COLORS[k] }}
						/>
						{k.replace("s", "")}
					</span>
				))}
			</div>
			<div className="row">
				{!single && (
					<TopTable
						title={<T id="traffic.top-hosts" />}
						rows={(data.hosts ?? []).slice(0, 10).map((h) => ({ label: h.label, value: h.requests }))}
					/>
				)}
				<TopTable
					title={<T id="traffic.top-ips" />}
					rows={(data.top?.ip ?? []).map((r) => ({ label: r.item, value: r.hits }))}
				/>
				<TopTable
					title={<T id="traffic.top-paths" />}
					rows={(data.top?.path ?? []).map((r) => ({ label: r.item, value: r.hits }))}
				/>
				{data.geoip && (
					<TopTable
						title={<T id="traffic.top-countries" />}
						rows={(data.top?.country ?? []).map((r) => ({ label: countryName(r.item), value: r.hits }))}
					/>
				)}
				{!single && (
					<TopTable
						title={<T id="traffic.errors-by-host" />}
						rows={(data.hosts ?? [])
							.filter((h) => h.s4xx + h.s5xx > 0)
							.sort((a, b) => b.s4xx + b.s5xx - (a.s4xx + a.s5xx))
							.slice(0, 10)
							.map((h) => ({ label: h.label, value: h.s4xx + h.s5xx }))}
					/>
				)}
			</div>
			{data.geoip && (
				<div className="text-secondary small mt-3">
					<a href="https://db-ip.com" target="_blank" rel="noreferrer">
						IP Geolocation by DB-IP
					</a>
				</div>
			)}
		</>
	);
};

export { TrafficPanel };
