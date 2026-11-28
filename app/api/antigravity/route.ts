import { antigravityInstallationResponse } from "@/src/server";

/** Checks installation/version and discovers available account models via `agy acp`. */
export async function GET(request: Request) {
	return antigravityInstallationResponse(request);
}
