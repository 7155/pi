import { errorResponse, parseRuntimeRequest, type RuntimeRequest, successResponse } from "./protocol.ts";

export interface RuntimeRequestHandler {
	handle(request: RuntimeRequest): Promise<unknown>;
}

/**
 * Dispatch JSONL commands independently so control-plane requests can reach the
 * host while another Session is waiting on a model or tool result.
 */
export class RuntimeRequestDispatcher {
	private readonly handler: RuntimeRequestHandler;
	private readonly output: (value: unknown) => void;
	private readonly inFlight = new Set<Promise<void>>();

	constructor(handler: RuntimeRequestHandler, output: (value: unknown) => void) {
		this.handler = handler;
		this.output = output;
	}

	dispatch(line: string): void {
		const task = this.execute(line);
		this.inFlight.add(task);
		void task.finally(() => this.inFlight.delete(task));
	}

	async settle(): Promise<void> {
		while (this.inFlight.size > 0) {
			await Promise.allSettled([...this.inFlight]);
		}
	}

	private async execute(line: string): Promise<void> {
		let id = "";
		try {
			const value: unknown = JSON.parse(line);
			if (typeof value === "object" && value !== null && "id" in value && typeof value.id === "string") {
				id = value.id;
			}
			const request = parseRuntimeRequest(value);
			this.output(successResponse(request.id, await this.handler.handle(request)));
		} catch (error) {
			this.output(errorResponse(id, error));
		}
	}
}
