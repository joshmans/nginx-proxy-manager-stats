import { useQuery } from "@tanstack/react-query";
import { getTrafficReport, type TrafficReport } from "src/api/backend";

const useTrafficReport = (hours?: number, options = {}) => {
	return useQuery<TrafficReport, Error>({
		queryKey: ["traffic-report", hours ?? "default"],
		queryFn: () => getTrafficReport(hours),
		refetchOnWindowFocus: false,
		retry: 2,
		refetchInterval: 30 * 1000, // 30 seconds
		staleTime: 29 * 1000,
		...options,
	});
};

export { useTrafficReport };
