import { useState } from "react";
import { RANGES, TrafficPanel } from "src/components/TrafficPanel";
import { useTrafficReport } from "src/hooks";
import { T } from "src/locale";

const TrafficCard = () => {
	const [hours, setHours] = useState<number | undefined>(undefined);
	const { data } = useTrafficReport(hours);

	if (!data?.enabled || !data.range) {
		return null;
	}
	const active = hours ?? data.range.hours;

	return (
		<div className="col-12 mb-4">
			<div className="card">
				<div className="card-header">
					<h3 className="card-title">
						<T id="traffic.title" />
					</h3>
					<div className="card-actions">
						<div className="btn-group">
							{RANGES.map((r) => (
								<button
									key={r.hours}
									type="button"
									className={`btn btn-sm ${active === r.hours ? "btn-primary" : "btn-outline-secondary"}`}
									onClick={() => setHours(r.hours)}
								>
									{r.label}
								</button>
							))}
						</div>
					</div>
				</div>
				<div className="card-body">
					<TrafficPanel data={data} />
				</div>
			</div>
		</div>
	);
};

export default TrafficCard;
