import { Field, Form, Formik } from "formik";
import { type ReactNode, useState } from "react";
import { Alert } from "react-bootstrap";
import { Button, Loading } from "src/components";
import { useSetSetting, useSetting } from "src/hooks";
import { T } from "src/locale";
import { showObjectSuccess } from "src/notifications";
import { useQueryClient } from "@tanstack/react-query";

export default function TrafficStats() {
	const { data, isLoading, error } = useSetting("traffic-stats");
	const { mutate: setSetting } = useSetSetting();
	const queryClient = useQueryClient();
	const [errorMsg, setErrorMsg] = useState<ReactNode | null>(null);
	const [isSubmitting, setIsSubmitting] = useState(false);

	const onSubmit = async (values: any, { setSubmitting }: any) => {
		if (isSubmitting) return;
		setIsSubmitting(true);
		setErrorMsg(null);

		const payload = {
			id: "traffic-stats",
			value: values.enabled ? "enabled" : "disabled",
			meta: {
				retention_days: Number(values.retention_days),
				range_hours: Number(values.range_hours),
				influx: {
					url: values.influx_url.trim(),
					org: values.influx_org.trim(),
					bucket: values.influx_bucket.trim(),
					token: values.influx_token,
				},
			},
		};

		setSetting(payload, {
			onError: (err: any) => setErrorMsg(<T id={err.message} />),
			onSuccess: () => {
				queryClient.invalidateQueries({ queryKey: ["traffic-report"] });
				showObjectSuccess("setting", "saved");
			},
			onSettled: () => {
				setIsSubmitting(false);
				setSubmitting(false);
			},
		});
	};

	if (!isLoading && error) {
		return (
			<div className="card-body">
				<div className="mb-3">
					<Alert variant="danger" show>
						{error.message}
					</Alert>
				</div>
			</div>
		);
	}

	if (isLoading) {
		return (
			<div className="card-body">
				<div className="mb-3">
					<Loading noLogo />
				</div>
			</div>
		);
	}

	const meta = data?.meta || {};
	const influx = meta.influx || {};

	return (
		<Formik
			initialValues={
				{
					enabled: data?.value === "enabled",
					retention_days: meta.retention_days ?? 30,
					range_hours: meta.range_hours ?? 24,
					influx_url: influx.url || "",
					influx_org: influx.org || "",
					influx_bucket: influx.bucket || "",
					influx_token: influx.token || "",
				} as any
			}
			onSubmit={onSubmit}
		>
			{({ values }) => {
				const useInflux = !!(
					values.influx_url &&
					values.influx_org &&
					values.influx_bucket &&
					values.influx_token
				);
				return (
					<Form>
						<div className="card-body">
							<Alert variant="danger" show={!!errorMsg} onClose={() => setErrorMsg(null)} dismissible>
								{errorMsg}
							</Alert>
							<Field name="enabled">
								{({ field }: any) => (
									<div className="mb-3">
										<label className="form-check form-switch">
											<input
												id="traffic-enabled"
												className="form-check-input"
												type="checkbox"
												{...field}
												checked={!!field.value}
											/>
											<span className="form-check-label">
												<T id="settings.traffic-stats.enable" />
											</span>
										</label>
										<div className="form-hint">
											<T id="settings.traffic-stats.enable.hint" />
										</div>
									</div>
								)}
							</Field>
							{values.enabled && (
								<>
									<div className="row mb-3">
										<div className="col-md-6">
											<label className="form-label" htmlFor="retention_days">
												<T id="settings.traffic-stats.retention" />
											</label>
											<Field
												id="retention_days"
												name="retention_days"
												type="number"
												min={1}
												max={3650}
												className="form-control"
											/>
										</div>
										<div className="col-md-6">
											<label className="form-label" htmlFor="range_hours">
												<T id="settings.traffic-stats.range" />
											</label>
											<Field
												id="range_hours"
												name="range_hours"
												type="number"
												min={1}
												className="form-control"
											/>
										</div>
									</div>
									<h4 className="mt-4">
										<T id="settings.traffic-stats.influx" />
									</h4>
									<p className="text-secondary">
										<T id="settings.traffic-stats.influx.hint" />
									</p>
									<div className="row mb-3">
										<div className="col-md-6 mb-3">
											<label className="form-label" htmlFor="influx_url">
												URL
											</label>
											<Field
												id="influx_url"
												name="influx_url"
												type="text"
												placeholder="http://influxdb:8086"
												autoComplete="off"
												className="form-control"
											/>
										</div>
										<div className="col-md-6 mb-3">
											<label className="form-label" htmlFor="influx_org">
												Organization
											</label>
											<Field
												id="influx_org"
												name="influx_org"
												type="text"
												autoComplete="off"
												className="form-control"
											/>
										</div>
										<div className="col-md-6 mb-3">
											<label className="form-label" htmlFor="influx_bucket">
												Bucket
											</label>
											<Field
												id="influx_bucket"
												name="influx_bucket"
												type="text"
												autoComplete="off"
												className="form-control"
											/>
										</div>
										<div className="col-md-6 mb-3">
											<label className="form-label" htmlFor="influx_token">
												Token
											</label>
											<Field
												id="influx_token"
												name="influx_token"
												type="password"
												autoComplete="new-password"
												className="form-control"
											/>
										</div>
									</div>
									<Alert variant={useInflux ? "info" : "secondary"} show>
										<T
											id={
												useInflux
													? "settings.traffic-stats.using-influx"
													: "settings.traffic-stats.using-local"
											}
										/>
									</Alert>
								</>
							)}
						</div>
						<div className="card-footer bg-transparent mt-auto">
							<div className="btn-list justify-content-end">
								<Button
									type="submit"
									actionType="primary"
									className="ms-auto bg-teal"
									isLoading={isSubmitting}
									disabled={isSubmitting}
								>
									<T id="save" />
								</Button>
							</div>
						</div>
					</Form>
				);
			}}
		</Formik>
	);
}
