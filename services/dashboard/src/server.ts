import handler from "@tanstack/solid-start/server-entry";
import { RotationScheduleWorkflow } from "./workflows/rotation/schedule";

export default { fetch: handler.fetch };
export { RotationScheduleWorkflow };
