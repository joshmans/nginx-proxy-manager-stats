import * as api from "./base";
import type { TrafficReport } from "./models";

export async function getTrafficReport(hours?: number): Promise<TrafficReport> {
	return await api.get({
		url: "/reports/traffic",
		params: hours ? { hours } : undefined,
	});
}
